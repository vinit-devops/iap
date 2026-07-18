/**
 * `aws:route53:HostedZone` + `aws:route53:RecordSet` handlers
 * (@aws-sdk/client-route-53) — the DnsZone kind and the DNS records that hang
 * off it (M23.2). Route 53 is a global service, but the runtime constructs the
 * client per-region like every other (harmless — the control plane is global).
 *
 * HostedZone — Route 53 allows DUPLICATE zone names with different generated
 * ids, so the name alone is not an identity. Identity is resolved like
 * backup.ts resolves a generated id by name, but disambiguated by the
 * `iap:resourceId` tag (whose value is the plan logicalId, exactly what
 * `buildTags` stamps): ListHostedZonesByName → match `Name === '<zoneName>.'`
 * AND `iap:resourceId === logicalId` (via ListTagsForResource, ResourceType
 * hostedzone). The generated `/hostedzone/Zxxxx` id stays internal.
 *   read   → ListHostedZonesByName (+ ListTagsForResource) → GetHostedZone
 *   create → CreateHostedZone (CallerReference = logicalId for idempotency;
 *            PrivateZone from `visibility`) then ChangeTagsForResource for the
 *            mandatory tags — CreateHostedZone takes no inline tags.
 *   update → ChangeTagsForResource (tags) + UpdateHostedZoneComment (pinned
 *            comment only).
 *   delete → delete every non-apex record the zone owns, then DeleteHostedZone
 *            (which FAILS closed while any non-apex record remains).
 *   PROJECTION: `zoneName` and `visibility` are IMMUTABLE — a hosted zone
 *   cannot be renamed or flipped public/private in place, so drift on either
 *   classifies as replace (ADR-0006). `comment` is mutable (desired-gated: an
 *   unpinned comment never reads as drift). Output identifier = the zone id;
 *   the NS delegation set is the endpoint an output binding would surface.
 *
 * RecordSet — identity is the composite `hostedZoneId` (a cross-resource
 * reference to the parent DnsZone's resolved id, fail-closed when absent) +
 * record name + type; all three are IMMUTABLE (a record cannot move zones,
 * change name, or change type in place → replace). Route 53 record sets carry
 * NO tags, so ownership is INHERITED from the parent zone: a record is
 * "managed" iff its hosted zone carries `iap:managed=true`.
 *   read   → ListResourceRecordSets (exact name+type, else same-name/other-type
 *            so a type change is seen as drift, not a phantom create)
 *   create/update → ChangeResourceRecordSets UPSERT
 *   delete → ChangeResourceRecordSets DELETE echoing the exact CURRENT record
 *   `ttl` and `records` are mutable.
 *
 * GetChange/INSYNC: ChangeResourceRecordSets returns a ChangeInfo whose status
 * is PENDING until Route 53 propagates; a live harness polls GetChange until
 * INSYNC. The handler does NOT foreground-sleep — propagation waiting is the
 * caller/harness's concern, not a blocking call inside convergence.
 */

import {
  ChangeResourceRecordSetsCommand,
  ChangeTagsForResourceCommand,
  CreateHostedZoneCommand,
  DeleteHostedZoneCommand,
  GetHostedZoneCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
  ListTagsForResourceCommand,
  UpdateHostedZoneCommentCommand,
} from '@aws-sdk/client-route-53';
import type {
  ListHostedZonesByNameCommandOutput,
  ResourceRecordSet,
  Route53Client,
  RRType,
} from '@aws-sdk/client-route-53';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { RESOURCE_TAG_KEY, fromTagList, isManaged, toTagList } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';

/** Route 53 fully-qualifies zone/record names with a trailing dot. */
function fqdn(name: string): string {
  return name.endsWith('.') ? name : `${name}.`;
}

/** Hosted zone ids arrive as `/hostedzone/Zxxxx`; the tag/records APIs want the bare id. */
function bareZoneId(id: string): string {
  return id.replace(/^\/hostedzone\//, '');
}

export class Route53HostedZoneHandler implements TargetHandler {
  static readonly targetType = 'aws:route53:HostedZone' as const;
  readonly targetType = Route53HostedZoneHandler.targetType;
  /** A zone cannot be renamed or flipped public/private in place (ADR-0006). */
  readonly immutableProjectionKeys = ['zoneName', 'visibility'] as const;

  constructor(private readonly route53: Route53Client) {}

  /** The zone's DNS name: explicit `zoneName` attribute, else the plan resourceId. */
  private zoneName(resource: PlanResource): string {
    return scalarStr(resource.desiredAttributes['zoneName']) || resourceIdOf(resource);
  }

  /** private/internal → a private hosted zone; anything else → public. */
  private visibility(resource: PlanResource): 'public' | 'private' {
    const v = scalarStr(resource.desiredAttributes['visibility']).toLowerCase();
    return v === 'private' || v === 'internal' ? 'private' : 'public';
  }

  private commentPinned(resource: PlanResource): boolean {
    return resource.desiredAttributes['comment'] !== undefined;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    return {
      zoneName: this.zoneName(resource),
      visibility: this.visibility(resource),
      // Desired-gated: an unpinned comment compares '' on both sides and never drifts.
      ...(this.commentPinned(resource)
        ? { comment: scalarStr(resource.desiredAttributes['comment']) }
        : {}),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = fqdn(this.zoneName(resource));
    const resolved = await this.resolveZone(name, resource.logicalId);
    if (resolved === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const got = await this.route53.send(new GetHostedZoneCommand({ Id: resolved.id }));
    const liveName = (got.HostedZone?.Name ?? name).replace(/\.$/, '');
    const projection: Record<string, string> = {
      zoneName: liveName,
      visibility: got.HostedZone?.Config?.PrivateZone ? 'private' : 'public',
      ...(this.commentPinned(resource) ? { comment: got.HostedZone?.Config?.Comment ?? '' } : {}),
    };

    return {
      exists: true,
      managed: isManaged(resolved.tags),
      tags: resolved.tags,
      identifier: resolved.id,
      projection,
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const zoneName = this.zoneName(resource);
    const commentPinned = this.commentPinned(resource);
    const created = await this.route53.send(
      new CreateHostedZoneCommand({
        Name: zoneName,
        // The logicalId is a stable, per-resource idempotency token.
        CallerReference: resource.logicalId,
        HostedZoneConfig: {
          PrivateZone: this.visibility(resource) === 'private',
          ...(commentPinned ? { Comment: scalarStr(resource.desiredAttributes['comment']) } : {}),
        },
      }),
    );
    const id = created.HostedZone?.Id;
    // CreateHostedZone takes no inline tags — the mandatory tags land in a
    // second call, which is also what carries the iap:resourceId identity.
    if (id !== undefined) {
      await this.route53.send(
        new ChangeTagsForResourceCommand({
          ResourceType: 'hostedzone',
          ResourceId: bareZoneId(id),
          AddTags: toTagList(tags),
        }),
      );
    }
    return id ?? `route53:zone/${zoneName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const id = current.identifier;
    if (id === undefined) return;
    await this.route53.send(
      new ChangeTagsForResourceCommand({
        ResourceType: 'hostedzone',
        ResourceId: bareZoneId(id),
        AddTags: toTagList(current.tags),
      }),
    );
    if (this.commentPinned(resource)) {
      const desired = scalarStr(resource.desiredAttributes['comment']);
      if (desired !== (current.projection['comment'] ?? '')) {
        await this.route53.send(new UpdateHostedZoneCommentCommand({ Id: id, Comment: desired }));
      }
    }
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const id = current.identifier;
    if (id === undefined) {
      throw new Error(
        `no hosted zone id resolved for ${resource.logicalId} — cannot delete a ` +
          `Route 53 zone without its read-resolved identity (fail closed)`,
      );
    }
    const apex = fqdn(this.zoneName(resource));

    // A zone must be emptied of every record except its apex SOA/NS before
    // DeleteHostedZone will succeed — delete the records the zone owns first.
    const toDelete: ResourceRecordSet[] = [];
    let StartRecordName: string | undefined;
    let StartRecordType: RRType | undefined;
    let StartRecordIdentifier: string | undefined;
    for (;;) {
      const page = await this.route53.send(
        new ListResourceRecordSetsCommand({
          HostedZoneId: id,
          StartRecordName,
          StartRecordType,
          StartRecordIdentifier,
        }),
      );
      for (const rr of page.ResourceRecordSets ?? []) {
        const isApexInfra = rr.Name === apex && (rr.Type === 'NS' || rr.Type === 'SOA');
        if (!isApexInfra) toDelete.push(rr);
      }
      if (!page.IsTruncated) break;
      StartRecordName = page.NextRecordName;
      StartRecordType = page.NextRecordType;
      StartRecordIdentifier = page.NextRecordIdentifier;
    }

    if (toDelete.length > 0) {
      await this.route53.send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: id,
          ChangeBatch: {
            Changes: toDelete.map((rr) => ({ Action: 'DELETE', ResourceRecordSet: rr })),
          },
        }),
      );
    }

    // Fail closed: if any non-apex record could not be removed, DeleteHostedZone
    // raises HostedZoneNotEmpty and that surfaces as the per-object error.
    await this.route53.send(new DeleteHostedZoneCommand({ Id: id }));
  }

  /**
   * Name + tag resolution across ListHostedZonesByName pages: among zones
   * whose `Name === '<zoneName>.'` (Route 53 permits duplicates), the one whose
   * `iap:resourceId` tag equals the plan logicalId is the one this plan owns.
   */
  private async resolveZone(
    name: string,
    identityTag: string,
  ): Promise<{ id: string; tags: Record<string, string> } | undefined> {
    let DNSName: string | undefined = name;
    let HostedZoneId: string | undefined;
    for (;;) {
      const page: ListHostedZonesByNameCommandOutput = await this.route53.send(
        new ListHostedZonesByNameCommand({ DNSName, HostedZoneId }),
      );
      for (const zone of page.HostedZones ?? []) {
        if (zone.Name !== name || zone.Id === undefined) continue;
        const tagResult = await this.route53.send(
          new ListTagsForResourceCommand({
            ResourceType: 'hostedzone',
            ResourceId: bareZoneId(zone.Id),
          }),
        );
        const tags = fromTagList(tagResult.ResourceTagSet?.Tags ?? []);
        if (tags[RESOURCE_TAG_KEY] === identityTag) return { id: zone.Id, tags };
      }
      if (!page.IsTruncated) break;
      DNSName = page.NextDNSName;
      HostedZoneId = page.NextHostedZoneId;
    }
    return undefined;
  }
}

const DEFAULT_RECORD_TYPE = 'A';
const DEFAULT_TTL = '300';

export class Route53RecordSetHandler implements TargetHandler {
  static readonly targetType = 'aws:route53:RecordSet' as const;
  readonly targetType = Route53RecordSetHandler.targetType;
  /** Zone, name and type are the composite identity — drift on any → replace. */
  readonly immutableProjectionKeys = ['hostedZoneId', 'name', 'type'] as const;

  constructor(private readonly route53: Route53Client) {}

  /** The parent zone is a cross-resource reference — fail closed without it. */
  private hostedZoneId(resource: PlanResource): string {
    const id = scalarStr(resource.desiredAttributes['hostedZoneId']);
    if (id === '') {
      throw new Error(
        `aws:route53:RecordSet ${resource.logicalId} needs a hostedZoneId attribute ` +
          `(the parent aws:route53:HostedZone id)`,
      );
    }
    return id;
  }

  private recordName(resource: PlanResource): string {
    return fqdn(scalarStr(resource.desiredAttributes['recordName']) || resourceIdOf(resource));
  }

  private recordType(resource: PlanResource): string {
    return scalarStr(resource.desiredAttributes['recordType']) || DEFAULT_RECORD_TYPE;
  }

  private ttl(resource: PlanResource): string {
    return scalarStr(resource.desiredAttributes['ttl']) || DEFAULT_TTL;
  }

  /** Record values: a comma-separated `records` attribute (single value → one entry). */
  private records(resource: PlanResource): string[] {
    return parseRecords(scalarStr(resource.desiredAttributes['records']));
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    return {
      hostedZoneId: this.hostedZoneId(resource),
      name: this.recordName(resource),
      type: this.recordType(resource),
      ttl: this.ttl(resource),
      records: joinRecords(this.records(resource)),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const HostedZoneId = this.hostedZoneId(resource);
    const name = this.recordName(resource);
    const type = this.recordType(resource);

    const listed = await this.route53.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId,
        StartRecordName: name,
        StartRecordType: type as RRType,
      }),
    );
    const sets = listed.ResourceRecordSets ?? [];
    // Prefer an exact name+type match; fall back to the same name with another
    // type so a TYPE CHANGE is seen as drift (→ replace), not a phantom create.
    const exact = sets.find((r) => r.Name === name && r.Type === type);
    const byName = exact ?? sets.find((r) => r.Name === name);
    if (byName === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    // Record sets carry no tags — ownership is inherited from the parent zone.
    const managed = await this.zoneIsManaged(HostedZoneId);
    const values = (byName.ResourceRecords ?? [])
      .map((rr) => rr.Value)
      .filter((v): v is string => v !== undefined);

    return {
      exists: true,
      managed,
      tags: {},
      identifier: `${bareZoneId(HostedZoneId)}/${byName.Name ?? name}/${byName.Type ?? type}`,
      projection: {
        hostedZoneId: HostedZoneId,
        name: byName.Name ?? name,
        type: byName.Type ?? type,
        ttl: byName.TTL === undefined ? '' : String(byName.TTL),
        records: joinRecords(values),
      },
    };
  }

  async create(resource: PlanResource, _tags: Record<string, string>): Promise<string> {
    // Record sets are untaggable; the mandatory tags apply to the zone, not here.
    return this.upsert(resource);
  }

  async update(resource: PlanResource, _current: ResourceState): Promise<void> {
    await this.upsert(resource);
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const HostedZoneId = this.hostedZoneId(resource);
    // Echo the EXACT current record — on a type/name change the live record is
    // the OLD one (current.projection), which is precisely what must be removed.
    const values = parseRecords(current.projection['records'] ?? '');
    const ttl = current.projection['ttl'] ?? this.ttl(resource);
    await this.route53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId,
        ChangeBatch: {
          Changes: [
            {
              Action: 'DELETE',
              ResourceRecordSet: {
                Name: current.projection['name'] ?? this.recordName(resource),
                Type: (current.projection['type'] ?? this.recordType(resource)) as RRType,
                TTL: Number(ttl),
                ResourceRecords: values.map((Value) => ({ Value })),
              },
            },
          ],
        },
      }),
    );
    // GetChange/INSYNC: a live harness would poll GetChange until INSYNC here;
    // the handler does not foreground-sleep (propagation is the caller's wait).
  }

  private async upsert(resource: PlanResource): Promise<string> {
    const HostedZoneId = this.hostedZoneId(resource);
    const name = this.recordName(resource);
    const type = this.recordType(resource);
    const values = this.records(resource);
    await this.route53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId,
        ChangeBatch: {
          Changes: [
            {
              Action: 'UPSERT',
              ResourceRecordSet: {
                Name: name,
                Type: type as RRType,
                TTL: Number(this.ttl(resource)),
                ResourceRecords: values.map((Value) => ({ Value })),
              },
            },
          ],
        },
      }),
    );
    // GetChange/INSYNC wait is the caller/harness's concern — never a blocking
    // sleep inside convergence.
    return `${bareZoneId(HostedZoneId)}/${name}/${type}`;
  }

  /** A record set is managed iff its parent hosted zone carries iap:managed=true. */
  private async zoneIsManaged(hostedZoneId: string): Promise<boolean> {
    const tagResult = await this.route53.send(
      new ListTagsForResourceCommand({
        ResourceType: 'hostedzone',
        ResourceId: bareZoneId(hostedZoneId),
      }),
    );
    return isManaged(fromTagList(tagResult.ResourceTagSet?.Tags ?? []));
  }
}

/** Split a comma-separated record value attribute; trims and drops empties. */
function parseRecords(raw: string): string[] {
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** Deterministic (sorted) join for drift comparison. */
function joinRecords(values: string[]): string {
  return [...values].sort().join(',');
}
