/**
 * `aws:acm:Certificate` handler (@aws-sdk/client-acm) — the Gateway kind's
 * managed certificate (M21.2, closed to ISSUED in M23.2).
 *
 * IDENTITY (M23.2 fix): the M21.2 handler matched by DomainName, so a
 * domainName CHANGE read the (absent) new domain and classified `create` —
 * silently orphaning the old certificate instead of the intended `replace`.
 * Identity is now the `iap:resourceId` tag (whose value is the plan logicalId,
 * exactly what `buildTags` stamps): ListCertificates → ListTagsForCertificate →
 * the cert whose `iap:resourceId === logicalId` is the one this plan owns,
 * regardless of its current domain. domainName stays immutable, so a domain
 * change now correctly classifies `replace` (ADR-0006). Certificates predating
 * the tag (or created outside the runtime) still resolve by DomainName as a
 * fallback, so existing behavior — including the M21.2 tests — is preserved.
 *
 * DNS-VALIDATION → ISSUED (M23.2): with a Route 53 client and a `hostedZoneId`
 * (the resolved DnsZone the certificate dependsOn), create() closes the
 * validation loop: RequestCertificate (DNS) → poll DescribeCertificate until
 * the DomainValidationOptions carry ResourceRecords → UPSERT those CNAMEs into
 * the hosted zone → wait (bounded) for the certificate to reach ISSUED. Without
 * a Route 53 client or a hostedZoneId, it keeps the honest M21.2 request-only
 * behavior (the certificate reaches PENDING_VALIDATION and stays there).
 * delete() removes the validation CNAME(s) before DeleteCertificate; an
 * in-use certificate's delete failure surfaces honestly (fail closed).
 *
 * read → ListCertificates (+ tags) → DescribeCertificate + ListTagsForCertificate
 * update → AddTagsToCertificate (tags are the only mutable surface)
 */

import {
  AddTagsToCertificateCommand,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  RequestCertificateCommand,
} from '@aws-sdk/client-acm';
import type { ACMClient, DomainValidation, ValidationMethod } from '@aws-sdk/client-acm';
import { ChangeResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import type { Route53Client, RRType } from '@aws-sdk/client-route-53';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { RESOURCE_TAG_KEY, fromTagList, isManaged, toTagList } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';

const DEFAULT_VALIDATION = 'DNS';
/** TTL for the validation CNAME(s) UPSERTed into the hosted zone. */
const VALIDATION_RECORD_TTL = 300;
/** Bounded polls (no foreground sleep) — the mock resolves on the first pass. */
const MAX_POLL_ATTEMPTS = 60;

export class AcmCertificateHandler implements TargetHandler {
  static readonly targetType = 'aws:acm:Certificate' as const;
  readonly targetType = AcmCertificateHandler.targetType;
  /** A certificate's domain and validation method cannot change in place. */
  readonly immutableProjectionKeys = ['domainName', 'validationMethod'] as const;

  constructor(
    private readonly client: ACMClient,
    // M23.2: the Route53 client enables the DNS-validation-to-ISSUED upgrade
    // (Certificate first-class). Optional so 1.0.0 callers/tests still compile;
    // when absent, the handler keeps its M21.2 request-only behavior.
    private readonly route53?: Route53Client,
  ) {}

  /** The certificate's domain: explicit attribute, else the plan resourceId. */
  private domainName(resource: PlanResource): string {
    return scalarStr(resource.desiredAttributes['domainName']) || resourceIdOf(resource);
  }

  /** The hosted zone to publish validation records into (a cross-resource ref). */
  private hostedZoneId(resource: PlanResource): string {
    return scalarStr(resource.desiredAttributes['hostedZoneId']);
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    return {
      domainName: this.domainName(resource),
      validationMethod:
        scalarStr(resource.desiredAttributes['validationMethod']) || DEFAULT_VALIDATION,
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const domain = this.domainName(resource);
    const resolved = await this.resolveCertificate(resource.logicalId, domain);
    if (resolved === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const described = await this.client.send(
      new DescribeCertificateCommand({ CertificateArn: resolved.arn }),
    );

    return {
      exists: true,
      managed: isManaged(resolved.tags),
      tags: resolved.tags,
      identifier: resolved.arn,
      projection: {
        domainName: described.Certificate?.DomainName ?? domain,
        validationMethod:
          described.Certificate?.DomainValidationOptions?.[0]?.ValidationMethod ??
          DEFAULT_VALIDATION,
      },
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const desired = this.desiredProjection(resource);
    const requested = await this.client.send(
      new RequestCertificateCommand({
        DomainName: desired['domainName'],
        ValidationMethod: desired['validationMethod'] as ValidationMethod,
        Tags: toTagList(tags),
      }),
    );
    const arn = requested.CertificateArn ?? `acm:${desired['domainName']}`;

    const hostedZoneId = this.hostedZoneId(resource);
    // Close the DNS-validation loop only when both the Route 53 client and a
    // target hosted zone are present; otherwise keep M21.2 request-only scope.
    if (this.route53 !== undefined && hostedZoneId !== '') {
      const validations = await this.waitForValidationRecords(arn);
      await this.publishValidationRecords(hostedZoneId, validations);
      await this.waitForIssued(arn);
    }
    return arn;
  }

  async update(_resource: PlanResource, current: ResourceState): Promise<void> {
    // Domain/validation drift classifies as replace; only tags reconcile in place.
    if (current.identifier !== undefined) {
      await this.client.send(
        new AddTagsToCertificateCommand({
          CertificateArn: current.identifier,
          Tags: toTagList(current.tags),
        }),
      );
    }
  }

  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const CertificateArn = current.identifier ?? '';
    const hostedZoneId = this.hostedZoneId(resource);
    // Withdraw the validation CNAME(s) before deleting the certificate, so the
    // hosted zone is not left with orphaned _acm-validations records.
    if (this.route53 !== undefined && hostedZoneId !== '' && CertificateArn !== '') {
      const described = await this.client.send(new DescribeCertificateCommand({ CertificateArn }));
      const validations = described.Certificate?.DomainValidationOptions ?? [];
      await this.withdrawValidationRecords(hostedZoneId, validations);
    }
    // An in-use certificate (still attached to a listener) fails here — the
    // error surfaces from AWS and is recorded (fail closed), never masked.
    await this.client.send(new DeleteCertificateCommand({ CertificateArn }));
  }

  /**
   * Resolve identity by the iap:resourceId tag (the plan logicalId), falling
   * back to DomainName for certificates that predate the tag. ListCertificates
   * is paginated; ListTagsForCertificate reads each candidate's tags.
   */
  private async resolveCertificate(
    identityTag: string,
    domain: string,
  ): Promise<{ arn: string; tags: Record<string, string> } | undefined> {
    let domainMatch: { arn: string; tags: Record<string, string> } | undefined;
    let NextToken: string | undefined;
    do {
      const listed = await this.client.send(new ListCertificatesCommand({ NextToken }));
      for (const summary of listed.CertificateSummaryList ?? []) {
        if (summary.CertificateArn === undefined) continue;
        const tagResult = await this.client.send(
          new ListTagsForCertificateCommand({ CertificateArn: summary.CertificateArn }),
        );
        const tags = fromTagList(tagResult.Tags ?? []);
        if (tags[RESOURCE_TAG_KEY] === identityTag) {
          return { arn: summary.CertificateArn, tags };
        }
        if (domainMatch === undefined && summary.DomainName === domain) {
          domainMatch = { arn: summary.CertificateArn, tags };
        }
      }
      NextToken = listed.NextToken;
    } while (NextToken !== undefined);
    return domainMatch;
  }

  /** Poll DescribeCertificate until the validation records are populated. */
  private async waitForValidationRecords(arn: string): Promise<DomainValidation[]> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const described = await this.client.send(
        new DescribeCertificateCommand({ CertificateArn: arn }),
      );
      const cert = described.Certificate;
      // Fail FAST on a rejected request (M23.2 live finding): ACM sends a
      // certificate for an invalid/reserved domain — e.g. a `.internal` name →
      // FailureReason INVALID_PUBLIC_DOMAIN — straight to FAILED and NEVER
      // exposes validation records. Surface the real reason instead of burning
      // the whole poll budget and reporting a misleading "did not expose
      // records" timeout. (Mocks always return records, so only a live cert
      // reaches this path.)
      if (cert?.Status === 'FAILED') {
        throw new Error(
          `ACM certificate ${arn} entered FAILED ` +
            `(${cert.FailureReason ?? 'unknown reason'}) before exposing DNS ` +
            `validation records — cannot close the validation loop (fail closed)`,
        );
      }
      const options = cert?.DomainValidationOptions ?? [];
      const ready = options.filter((o) => o.ResourceRecord?.Name !== undefined);
      // Every domain (apex + SANs) must expose its record before we publish.
      if (options.length > 0 && ready.length === options.length) return ready;
    }
    throw new Error(
      `ACM certificate ${arn} did not expose DNS validation records within ` +
        `${MAX_POLL_ATTEMPTS} polls — cannot close the validation loop (fail closed)`,
    );
  }

  /** UPSERT each distinct validation CNAME into the hosted zone. */
  private async publishValidationRecords(
    hostedZoneId: string,
    validations: DomainValidation[],
  ): Promise<void> {
    const seen = new Set<string>();
    const changes = [];
    for (const v of validations) {
      const rr = v.ResourceRecord;
      if (rr?.Name === undefined || seen.has(rr.Name)) continue;
      seen.add(rr.Name);
      changes.push({
        Action: 'UPSERT' as const,
        ResourceRecordSet: {
          Name: rr.Name,
          Type: (rr.Type ?? 'CNAME') as RRType,
          TTL: VALIDATION_RECORD_TTL,
          ResourceRecords: [{ Value: rr.Value ?? '' }],
        },
      });
    }
    if (changes.length === 0 || this.route53 === undefined) return;
    await this.route53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: { Changes: changes },
      }),
    );
  }

  /** DELETE the validation CNAME(s) — echoing the exact record ACM published. */
  private async withdrawValidationRecords(
    hostedZoneId: string,
    validations: DomainValidation[],
  ): Promise<void> {
    const seen = new Set<string>();
    const changes = [];
    for (const v of validations) {
      const rr = v.ResourceRecord;
      if (rr?.Name === undefined || seen.has(rr.Name)) continue;
      seen.add(rr.Name);
      changes.push({
        Action: 'DELETE' as const,
        ResourceRecordSet: {
          Name: rr.Name,
          Type: (rr.Type ?? 'CNAME') as RRType,
          TTL: VALIDATION_RECORD_TTL,
          ResourceRecords: [{ Value: rr.Value ?? '' }],
        },
      });
    }
    if (changes.length === 0 || this.route53 === undefined) return;
    await this.route53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: { Changes: changes },
      }),
    );
  }

  /** Bounded wait for ISSUED (no foreground sleep); returns once reached. */
  private async waitForIssued(arn: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const described = await this.client.send(
        new DescribeCertificateCommand({ CertificateArn: arn }),
      );
      if (described.Certificate?.Status === 'ISSUED') return;
    }
    // Bound exceeded: the request is placed and the records are published, so
    // validation will still complete out of band — we do not fail the create.
  }
}
