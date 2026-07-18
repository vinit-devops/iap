/**
 * M23.2 — Redshift Serverless handlers (@aws-sdk/client-redshift-serverless):
 * `aws:redshiftserverless:Namespace` + `aws:redshiftserverless:Workgroup`, the
 * warehouse branch of the Database kind. A namespace holds the data + admin
 * identity; a workgroup is the compute that queries it. They are separate
 * resources wired together by the workgroup's `namespaceName` attribute and a
 * `dependsOn` edge (namespace before workgroup on create; the reverse-topo
 * destroy tears the workgroup down first, since a namespace cannot be deleted
 * while a workgroup still references it).
 *
 * NAMESPACE
 *   read   → GetNamespace (ResourceNotFoundException / DELETING → absent)
 *            + ListTagsForResource (namespace ARN)
 *   create → CreateNamespace with manageAdminPassword=true — Redshift stores
 *            and rotates the admin credentials in Secrets Manager, so NO
 *            password material ever passes through IaP (mirrors the RDS
 *            ManageMasterUserPassword idiom). dbName + adminUsername are
 *            create-only identity; kmsKeyId is desired-gated (an unpinned plan
 *            must not read the AWS-managed default key as drift, M22.1 lesson).
 *   update → UpdateNamespace (kmsKeyId, mutable) + TagResource
 *   delete → DeleteNamespace (no final snapshot — zero-orphan teardown)
 *   The managed-admin secret ARN (GetNamespace.adminPasswordSecretArn) is the
 *   Database warehouse branch's `connectionSecret` output.
 *
 * WORKGROUP
 *   read   → GetWorkgroup (ResourceNotFoundException / DELETING → absent)
 *            + ListTagsForResource (workgroup ARN)
 *   create → CreateWorkgroup bound to the REQUIRED `namespaceName` (a
 *            cross-resource reference to the sibling namespace's resourceId —
 *            fail closed when missing, like the timestream Table's parent
 *            database). baseCapacity defaults to 8 RPU (the serverless floor);
 *            publiclyAccessible + enhancedVpcRouting default to false. No
 *            in-handler ACTIVE waiter — creates are SLOW (CREATING→AVAILABLE,
 *            minutes); the live-run driver verifies convergence.
 *   update → UpdateWorkgroup (baseCapacity, publiclyAccessible — mutable)
 *            + TagResource
 *   delete → DeleteWorkgroup
 *
 * namespaceName is IMMUTABLE on the workgroup (a workgroup cannot move
 * namespaces → drift replaces, ADR-0006); dbName + adminUsername are immutable
 * on the namespace.
 */

import {
  CreateNamespaceCommand,
  CreateWorkgroupCommand,
  DeleteNamespaceCommand,
  DeleteWorkgroupCommand,
  GetNamespaceCommand,
  GetWorkgroupCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UpdateNamespaceCommand,
  UpdateWorkgroupCommand,
} from '@aws-sdk/client-redshift-serverless';
import type { RedshiftServerlessClient } from '@aws-sdk/client-redshift-serverless';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';

const NOT_FOUND = ['ResourceNotFoundException'] as const;

/** The fixed admin identity — the password itself is Secrets Manager-managed. */
const ADMIN_USERNAME = 'iapadmin';
/** First database created in the namespace when the plan does not pin one. */
const DEFAULT_DB_NAME = 'iapdb';
/** Serverless compute floor — 8 RPU is the minimum baseCapacity Redshift allows. */
const DEFAULT_BASE_CAPACITY = '8';

/** Redshift Serverless tags use lower-case `key`/`value` (not `{Key,Value}`). */
function toRsTagList(tags: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.keys(tags)
    .sort()
    .map((key) => ({ key, value: tags[key] ?? '' }));
}

function fromRsTagList(
  list: ReadonlyArray<{ key?: string | undefined; value?: string | undefined }>,
): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const entry of list) {
    if (entry.key !== undefined) tags[entry.key] = entry.value ?? '';
  }
  return tags;
}

export class RedshiftServerlessNamespaceHandler implements TargetHandler {
  static readonly targetType = 'aws:redshiftserverless:Namespace' as const;
  readonly targetType = RedshiftServerlessNamespaceHandler.targetType;
  /** dbName + adminUsername are create-only identity — drift replaces (ADR-0006). */
  readonly immutableProjectionKeys = ['dbName', 'adminUsername'] as const;

  constructor(private readonly redshiftServerless: RedshiftServerlessClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      dbName: scalarStr(a['dbName']) || DEFAULT_DB_NAME,
      adminUsername: ADMIN_USERNAME,
      // Desired-gated: an unpinned plan compares '' on both sides, so the
      // AWS-managed default key never reads as drift (M22.1 SQS/Timestream lesson).
      kmsKeyId: scalarStr(a['kmsKeyId']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const namespaceName = resourceIdOf(resource);
    let namespace;
    try {
      const found = await this.redshiftServerless.send(
        new GetNamespaceCommand({ namespaceName }),
      );
      namespace = found.namespace;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (namespace === undefined || namespace.status === 'DELETING') {
      // Deletion in progress — treat as absent; never touch a dying namespace.
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    let tags: Record<string, string> = {};
    if (namespace.namespaceArn !== undefined) {
      const tagResult = await this.redshiftServerless.send(
        new ListTagsForResourceCommand({ resourceArn: namespace.namespaceArn }),
      );
      tags = fromRsTagList(tagResult.tags ?? []);
    }

    // The live key mirrors into the projection only when the plan pins one;
    // otherwise '' so the Redshift-managed default is not drift.
    const pinned = resource.desiredAttributes['kmsKeyId'] !== undefined;
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        dbName: namespace.dbName ?? '',
        adminUsername: namespace.adminUsername ?? '',
        kmsKeyId: pinned ? (namespace.kmsKeyId ?? '') : '',
      },
    };
    if (namespace.namespaceArn !== undefined) state.identifier = namespace.namespaceArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const namespaceName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const created = await this.redshiftServerless.send(
      new CreateNamespaceCommand({
        namespaceName,
        dbName: d['dbName'],
        adminUsername: ADMIN_USERNAME,
        // Secrets Manager-managed admin credentials owned + rotated by Redshift:
        // no password material touches IaP code, logs, or projection, ever.
        manageAdminPassword: true,
        ...(d['kmsKeyId'] ? { kmsKeyId: d['kmsKeyId'] } : {}),
        tags: toRsTagList(tags),
      }),
    );
    return created.namespace?.namespaceArn ?? `redshiftserverless:namespace/${namespaceName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const namespaceName = resourceIdOf(resource);
    const desiredKey = scalarStr(resource.desiredAttributes['kmsKeyId']);
    // UpdateNamespace rotates the namespace key — issued only for a pinned,
    // actually-drifted kmsKeyId (never to "reconcile" the managed default).
    // Log exports would reconcile here the same way when the plan sets them.
    if (desiredKey !== '' && desiredKey !== (current.projection['kmsKeyId'] ?? '')) {
      await this.redshiftServerless.send(
        new UpdateNamespaceCommand({ namespaceName, kmsKeyId: desiredKey }),
      );
    }
    // Re-assert ownership tags on the live namespace (repo idiom).
    if (current.identifier !== undefined) {
      await this.redshiftServerless.send(
        new TagResourceCommand({
          resourceArn: current.identifier,
          tags: toRsTagList(current.tags),
        }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    // No final snapshot — teardown must leave zero orphans.
    await this.redshiftServerless.send(
      new DeleteNamespaceCommand({ namespaceName: resourceIdOf(resource) }),
    );
  }
}

export class RedshiftServerlessWorkgroupHandler implements TargetHandler {
  static readonly targetType = 'aws:redshiftserverless:Workgroup' as const;
  readonly targetType = RedshiftServerlessWorkgroupHandler.targetType;
  /** A workgroup cannot move namespaces — namespaceName drift replaces (ADR-0006). */
  readonly immutableProjectionKeys = ['namespaceName'] as const;

  constructor(private readonly redshiftServerless: RedshiftServerlessClient) {}

  /** The owning namespace is a cross-resource reference — fail closed without it. */
  private namespaceName(resource: PlanResource): string {
    const name = scalarStr(resource.desiredAttributes['namespaceName']);
    if (name === '') {
      throw new Error(
        `aws:redshiftserverless:Workgroup ${resource.logicalId} needs a namespaceName ` +
          `attribute (the parent aws:redshiftserverless:Namespace resourceId) — ` +
          `refusing to create a workgroup without its namespace (fail closed)`,
      );
    }
    return name;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      namespaceName: this.namespaceName(resource),
      baseCapacity: scalarStr(a['baseCapacity']) || DEFAULT_BASE_CAPACITY,
      publiclyAccessible: scalarStr(a['publiclyAccessible']) === 'true' ? 'true' : 'false',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    // Fail closed BEFORE any SDK call if the parent namespace is unbound.
    this.namespaceName(resource);
    const workgroupName = resourceIdOf(resource);
    let workgroup;
    try {
      const found = await this.redshiftServerless.send(
        new GetWorkgroupCommand({ workgroupName }),
      );
      workgroup = found.workgroup;
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (workgroup === undefined || workgroup.status === 'DELETING') {
      // Deletion in progress — treat as absent; never touch a dying workgroup.
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    let tags: Record<string, string> = {};
    if (workgroup.workgroupArn !== undefined) {
      const tagResult = await this.redshiftServerless.send(
        new ListTagsForResourceCommand({ resourceArn: workgroup.workgroupArn }),
      );
      tags = fromRsTagList(tagResult.tags ?? []);
    }

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        namespaceName: workgroup.namespaceName ?? '',
        baseCapacity:
          workgroup.baseCapacity === undefined
            ? DEFAULT_BASE_CAPACITY
            : String(workgroup.baseCapacity),
        publiclyAccessible: workgroup.publiclyAccessible === true ? 'true' : 'false',
      },
    };
    if (workgroup.workgroupArn !== undefined) state.identifier = workgroup.workgroupArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const workgroupName = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const enhancedVpcRouting = scalarStr(resource.desiredAttributes['enhancedVpcRouting']) === 'true';
    const created = await this.redshiftServerless.send(
      new CreateWorkgroupCommand({
        workgroupName,
        namespaceName: d['namespaceName'],
        // Serverless floor: 8 RPU minimum baseCapacity.
        baseCapacity: Number(d['baseCapacity']),
        publiclyAccessible: d['publiclyAccessible'] === 'true',
        enhancedVpcRouting,
        tags: toRsTagList(tags),
      }),
    );
    // No available-waiter — repo idiom (workgroup create is SLOW,
    // CREATING→AVAILABLE over minutes; the live-run driver verifies convergence).
    return created.workgroup?.workgroupArn ?? `redshiftserverless:workgroup/${workgroupName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const d = this.desiredProjection(resource);
    const live = current.projection;
    const changes: Record<string, unknown> = {};
    if (d['baseCapacity'] !== live['baseCapacity']) {
      changes['baseCapacity'] = Number(d['baseCapacity']);
    }
    if (d['publiclyAccessible'] !== live['publiclyAccessible']) {
      changes['publiclyAccessible'] = d['publiclyAccessible'] === 'true';
    }
    if (Object.keys(changes).length > 0) {
      await this.redshiftServerless.send(
        new UpdateWorkgroupCommand({
          workgroupName: resourceIdOf(resource),
          ...changes,
        }),
      );
    }
    // Re-assert ownership tags on the live workgroup (repo idiom).
    if (current.identifier !== undefined) {
      await this.redshiftServerless.send(
        new TagResourceCommand({
          resourceArn: current.identifier,
          tags: toRsTagList(current.tags),
        }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    await this.redshiftServerless.send(
      new DeleteWorkgroupCommand({ workgroupName: resourceIdOf(resource) }),
    );
  }
}
