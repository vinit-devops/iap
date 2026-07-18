/**
 * `aws:batch:ComputeEnvironment` + `aws:batch:JobQueue` +
 * `aws:batch:JobDefinition` handlers (@aws-sdk/client-batch) — managed batch
 * compute (M22.5). All three are name-identified natively (Describe* accepts
 * the name), so no name→id resolution pass is needed.
 *
 * ComputeEnvironment — MANAGED Fargate CE.
 *   read   → DescribeComputeEnvironments by name (empty → absent; status
 *            DELETING/DELETED → absent).
 *   create → CreateComputeEnvironment: Type MANAGED, ComputeResources Type
 *            FARGATE. Subnets/SecurityGroupIds arrive as comma-joined desired
 *            attributes from the LIVE driver (`subnets`/`securityGroups`) —
 *            REQUIRED, fail-closed; the handler never resolves networking.
 *   update → UpdateComputeEnvironment (state + maxvCpus reconcile in place).
 *   delete → DISABLE-SETTLE-DELETE: Batch refuses DeleteComputeEnvironment on
 *            an ENABLED CE, so delete() first issues UpdateComputeEnvironment
 *            State=DISABLED, then WAITS for the modification to settle (the
 *            disable holds the CE in status UPDATING, and Batch rejects a
 *            delete mid-modification with "Cannot delete, resource is being
 *            modified." — M22.5 live finding), then DeleteComputeEnvironment.
 *            A disable failure or a settle timeout propagates (fail closed) —
 *            the delete is never attempted blind or mid-modification.
 *   Projection: `type` + `computeType` IMMUTABLE (drift → gated replace,
 *   ADR-0006); `maxVcpus` + `state` mutable. Subnets/SGs are create-time
 *   context only — deliberately excluded from the drift projection.
 *
 * JobQueue — routes to its sibling CE by NAME (`computeEnvironment` desired
 * attribute, REQUIRED fail-closed; the plan wires dependsOn CE→JQ).
 *   read   → DescribeJobQueues (empty / status DELETING → absent). The live
 *            computeEnvironmentOrder carries the CE ARN — normalized back to
 *            the name (ARN tail) for drift comparison.
 *   create → CreateJobQueue: Priority, State ENABLED, single-entry
 *            ComputeEnvironmentOrder, Tags.
 *   update → UpdateJobQueue (priority / state / computeEnvironment ALL
 *            mutable — replacement justified N/A).
 *   delete → same disable-settle-delete: UpdateJobQueue State=DISABLED, wait
 *            for the queue to settle out of UPDATING (same M22.5 live
 *            finding), then DeleteJobQueue. NOTE (live): a JQ must be deleted
 *            BEFORE the CE it references — the destroy topology (reversed
 *            dependsOn) guarantees that ordering.
 *
 * JobDefinition — VERSIONED + name-identified: registration always creates a
 * new revision; revisions are only ever ACTIVE or INACTIVE.
 *   read   → DescribeJobDefinitions status ACTIVE by name (paginate), latest
 *            revision wins; no ACTIVE revision → absent.
 *   create → RegisterJobDefinition: Type container, PlatformCapabilities
 *            FARGATE, busybox `true` command (never runs — jobs are NEVER
 *            submitted), VCPU/MEMORY resource requirements, ExecutionRoleArn
 *            from the `executionRoleArn` attribute (REQUIRED fail-closed —
 *            the live plan wires a sibling aws:iam:Role).
 *   update → ANY drift = RegisterJobDefinition again: a NEW revision is the
 *            in-place reconcile for a versioned resource (old revisions stay
 *            ACTIVE until destroy) — replacement justified N/A.
 *   delete → DeregisterJobDefinition for EVERY ACTIVE revision (loop —
 *            zero-orphan teardown, ecs-service.ts idiom).
 */

import {
  CreateComputeEnvironmentCommand,
  CreateJobQueueCommand,
  DeleteComputeEnvironmentCommand,
  DeleteJobQueueCommand,
  DeregisterJobDefinitionCommand,
  DescribeComputeEnvironmentsCommand,
  DescribeJobDefinitionsCommand,
  DescribeJobQueuesCommand,
  RegisterJobDefinitionCommand,
  UpdateComputeEnvironmentCommand,
  UpdateJobQueueCommand,
} from '@aws-sdk/client-batch';
import type { BatchClient, JobDefinition } from '@aws-sdk/client-batch';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';

const ABSENT: ResourceState = { exists: false, managed: false, tags: {}, projection: {} };

/**
 * Disable-settle budget (M22.5 live finding): UpdateComputeEnvironment /
 * UpdateJobQueue State=DISABLED holds the resource in status UPDATING and
 * Batch rejects an immediate delete with "Cannot delete, resource is being
 * modified." — the delete may only follow once the disable has settled.
 * Exceeding the budget fails closed (the delete is never attempted).
 */
const SETTLE_BUDGET_MS = 120_000;
const SETTLE_POLL_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split a comma-joined attribute (live-driver networking) into ids. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Batch APIs return CE references as ARNs; identity here is the NAME (ARN tail). */
function nameFromArn(ref: string): string {
  const at = ref.lastIndexOf('/');
  return at === -1 ? ref : ref.slice(at + 1);
}

export class BatchComputeEnvironmentHandler implements TargetHandler {
  static readonly targetType = 'aws:batch:ComputeEnvironment' as const;
  readonly targetType = BatchComputeEnvironmentHandler.targetType;
  /** MANAGED/UNMANAGED and the compute-resource type cannot change in place. */
  readonly immutableProjectionKeys = ['type', 'computeType'] as const;

  constructor(private readonly batch: BatchClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      type: 'MANAGED',
      computeType: 'FARGATE',
      maxVcpus: scalarStr(a['maxVcpus']) || '1',
      state: scalarStr(a['state']) || 'ENABLED',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    const found = await this.batch.send(
      new DescribeComputeEnvironmentsCommand({ computeEnvironments: [name] }),
    );
    const ce = found.computeEnvironments?.[0];
    if (ce === undefined || ce.status === 'DELETING' || ce.status === 'DELETED') {
      return { ...ABSENT };
    }

    const tags = ce.tags ?? {};
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        type: ce.type ?? '',
        computeType: ce.computeResources?.type ?? '',
        maxVcpus: ce.computeResources?.maxvCpus === undefined ? '' : String(ce.computeResources.maxvCpus),
        state: ce.state ?? '',
      },
    };
    if (ce.computeEnvironmentArn !== undefined) state.identifier = ce.computeEnvironmentArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const name = resourceIdOf(resource);
    const a = resource.desiredAttributes;
    // Networking is the LIVE DRIVER's contract: comma-joined subnet/SG ids
    // arrive as desired attributes — never resolved in-handler, fail closed.
    const subnets = splitList(scalarStr(a['subnets']));
    const securityGroups = splitList(scalarStr(a['securityGroups']));
    if (subnets.length === 0) {
      throw new Error(`batch compute environment ${name} needs a subnets attribute (comma-joined subnet ids)`);
    }
    if (securityGroups.length === 0) {
      throw new Error(`batch compute environment ${name} needs a securityGroups attribute (comma-joined security-group ids)`);
    }

    const d = this.desiredProjection(resource);
    const created = await this.batch.send(
      new CreateComputeEnvironmentCommand({
        computeEnvironmentName: name,
        type: 'MANAGED',
        state: d['state'] === 'DISABLED' ? 'DISABLED' : 'ENABLED',
        computeResources: {
          type: 'FARGATE',
          maxvCpus: Number(d['maxVcpus']),
          subnets,
          securityGroupIds: securityGroups,
        },
        tags,
      }),
    );
    return created.computeEnvironmentArn ?? `batch:compute-environment/${name}`;
  }

  /** maxVcpus + state reconcile in place via UpdateComputeEnvironment. */
  async update(resource: PlanResource, _current: ResourceState): Promise<void> {
    const d = this.desiredProjection(resource);
    await this.batch.send(
      new UpdateComputeEnvironmentCommand({
        computeEnvironment: resourceIdOf(resource),
        state: d['state'] === 'DISABLED' ? 'DISABLED' : 'ENABLED',
        computeResources: { maxvCpus: Number(d['maxVcpus']) },
      }),
    );
  }

  /**
   * DISABLE-SETTLE-DELETE: Batch rejects deleting an ENABLED CE, and it also
   * rejects deleting one whose disable is still in flight ("Cannot delete,
   * resource is being modified." — M22.5 live finding). The disable is issued
   * first, the CE is polled until the modification settles (state DISABLED,
   * status out of UPDATING), and only then is the delete sent. A disable
   * failure or settle timeout propagates (fail closed). Deletion itself is
   * async (status DELETING → DELETED); the live driver polls.
   */
  async delete(resource: PlanResource): Promise<void> {
    const name = resourceIdOf(resource);
    await this.batch.send(
      new UpdateComputeEnvironmentCommand({ computeEnvironment: name, state: 'DISABLED' }),
    );
    if (await this.settledAfterDisable(name)) {
      await this.batch.send(new DeleteComputeEnvironmentCommand({ computeEnvironment: name }));
    }
  }

  /** True once the disable settled; false if the CE is already gone/DELETING. */
  private async settledAfterDisable(name: string): Promise<boolean> {
    const deadline = Date.now() + SETTLE_BUDGET_MS;
    for (;;) {
      const found = await this.batch.send(
        new DescribeComputeEnvironmentsCommand({ computeEnvironments: [name] }),
      );
      const ce = found.computeEnvironments?.[0];
      if (ce === undefined || ce.status === 'DELETING' || ce.status === 'DELETED') return false;
      if (ce.state === 'DISABLED' && ce.status !== 'UPDATING') return true;
      if (Date.now() >= deadline) {
        throw new Error(
          `batch compute environment ${name} did not settle DISABLED within ` +
            `${SETTLE_BUDGET_MS / 1000}s — refusing to delete mid-modification`,
        );
      }
      await sleep(SETTLE_POLL_MS);
    }
  }
}

export class BatchJobQueueHandler implements TargetHandler {
  static readonly targetType = 'aws:batch:JobQueue' as const;
  readonly targetType = BatchJobQueueHandler.targetType;
  // priority/state/computeEnvironment ALL reconcile via UpdateJobQueue — replacement N/A.

  constructor(private readonly batch: BatchClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      priority: scalarStr(a['priority']) || '1',
      state: scalarStr(a['state']) || 'ENABLED',
      computeEnvironment: scalarStr(a['computeEnvironment']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    const found = await this.batch.send(new DescribeJobQueuesCommand({ jobQueues: [name] }));
    const jq = found.jobQueues?.[0];
    if (jq === undefined || jq.status === 'DELETING' || jq.status === 'DELETED') {
      return { ...ABSENT };
    }

    const tags = jq.tags ?? {};
    // Live order entries carry the CE ARN; identity is by NAME — normalize.
    const firstCe = jq.computeEnvironmentOrder?.[0]?.computeEnvironment;
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        priority: jq.priority === undefined ? '' : String(jq.priority),
        state: jq.state ?? '',
        computeEnvironment: firstCe === undefined ? '' : nameFromArn(firstCe),
      },
    };
    if (jq.jobQueueArn !== undefined) state.identifier = jq.jobQueueArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const name = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const computeEnvironment = d['computeEnvironment'];
    if (!computeEnvironment) {
      throw new Error(
        `batch job queue ${name} needs a computeEnvironment attribute (sibling compute-environment name)`,
      );
    }
    const created = await this.batch.send(
      new CreateJobQueueCommand({
        jobQueueName: name,
        priority: Number(d['priority']),
        state: d['state'] === 'DISABLED' ? 'DISABLED' : 'ENABLED',
        computeEnvironmentOrder: [{ order: 1, computeEnvironment }],
        tags,
      }),
    );
    return created.jobQueueArn ?? `batch:job-queue/${name}`;
  }

  /** priority / state / computeEnvironment reconcile via UpdateJobQueue. */
  async update(resource: PlanResource, _current: ResourceState): Promise<void> {
    const d = this.desiredProjection(resource);
    const computeEnvironment = d['computeEnvironment'];
    await this.batch.send(
      new UpdateJobQueueCommand({
        jobQueue: resourceIdOf(resource),
        priority: Number(d['priority']),
        state: d['state'] === 'DISABLED' ? 'DISABLED' : 'ENABLED',
        ...(computeEnvironment
          ? { computeEnvironmentOrder: [{ order: 1, computeEnvironment }] }
          : {}),
      }),
    );
  }

  /**
   * Same disable-settle-delete contract as the CE: DeleteJobQueue requires a
   * DISABLED queue whose disable has SETTLED ("Cannot delete, resource is
   * being modified." otherwise — M22.5 live finding); a disable failure or
   * settle timeout propagates before delete is attempted. Destroy topology
   * deletes the JQ BEFORE its CE (reversed dependsOn).
   */
  async delete(resource: PlanResource): Promise<void> {
    const name = resourceIdOf(resource);
    await this.batch.send(new UpdateJobQueueCommand({ jobQueue: name, state: 'DISABLED' }));
    if (await this.settledAfterDisable(name)) {
      await this.batch.send(new DeleteJobQueueCommand({ jobQueue: name }));
    }
  }

  /** True once the disable settled; false if the JQ is already gone/DELETING. */
  private async settledAfterDisable(name: string): Promise<boolean> {
    const deadline = Date.now() + SETTLE_BUDGET_MS;
    for (;;) {
      const found = await this.batch.send(new DescribeJobQueuesCommand({ jobQueues: [name] }));
      const jq = found.jobQueues?.[0];
      if (jq === undefined || jq.status === 'DELETING' || jq.status === 'DELETED') return false;
      if (jq.state === 'DISABLED' && jq.status !== 'UPDATING') return true;
      if (Date.now() >= deadline) {
        throw new Error(
          `batch job queue ${name} did not settle DISABLED within ` +
            `${SETTLE_BUDGET_MS / 1000}s — refusing to delete mid-modification`,
        );
      }
      await sleep(SETTLE_POLL_MS);
    }
  }
}

const JD_DEFAULTS = {
  image: 'public.ecr.aws/docker/library/busybox:latest',
  vcpus: '0.25',
  memoryMiB: '512',
} as const;

export class BatchJobDefinitionHandler implements TargetHandler {
  static readonly targetType = 'aws:batch:JobDefinition' as const;
  readonly targetType = BatchJobDefinitionHandler.targetType;
  // Versioned resource: drift → a NEW revision (in place) — replacement N/A.

  constructor(private readonly batch: BatchClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      image: scalarStr(a['image']) || JD_DEFAULTS.image,
      vcpus: scalarStr(a['vcpus']) || JD_DEFAULTS.vcpus,
      memoryMiB: scalarStr(a['memoryMiB']) || JD_DEFAULTS.memoryMiB,
      executionRoleArn: scalarStr(a['executionRoleArn']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const revisions = await this.activeRevisions(resourceIdOf(resource));
    const latest = revisions[0];
    if (latest === undefined) return { ...ABSENT };

    const tags = latest.tags ?? {};
    const props = latest.containerProperties;
    const requirement = (type: string): string =>
      props?.resourceRequirements?.find((r) => r.type === type)?.value ?? '';

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        image: props?.image ?? '',
        vcpus: requirement('VCPU'),
        memoryMiB: requirement('MEMORY'),
        executionRoleArn: props?.executionRoleArn ?? '',
      },
    };
    if (latest.jobDefinitionArn !== undefined) state.identifier = latest.jobDefinitionArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    return this.register(resource, tags);
  }

  /**
   * ANY drift → RegisterJobDefinition again: a new revision IS the in-place
   * reconcile for a versioned resource. The previous revision stays ACTIVE
   * (never deregistered here) so in-flight references keep resolving; destroy
   * sweeps every revision. Managed tags are carried onto the new revision.
   */
  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    await this.register(resource, current.tags);
  }

  /** Deregister EVERY ACTIVE revision (zero-orphan teardown). */
  async delete(resource: PlanResource): Promise<void> {
    const name = resourceIdOf(resource);
    const revisions = await this.activeRevisions(name);
    if (revisions.length === 0) {
      throw new Error(`batch job definition ${name} has no ACTIVE revision — refusing blind deregister`);
    }
    for (const revision of revisions) {
      await this.batch.send(
        new DeregisterJobDefinitionCommand({
          jobDefinition: revision.jobDefinitionArn ?? `${name}:${revision.revision}`,
        }),
      );
    }
  }

  private async register(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const name = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const executionRoleArn = d['executionRoleArn'];
    // The live plan wires a sibling aws:iam:Role as the Fargate execution
    // role — required context, fail closed (never invent a role in-handler).
    if (!executionRoleArn) {
      throw new Error(
        `batch job definition ${name} needs an executionRoleArn attribute (sibling aws:iam:Role)`,
      );
    }
    const registered = await this.batch.send(
      new RegisterJobDefinitionCommand({
        jobDefinitionName: name,
        type: 'container',
        platformCapabilities: ['FARGATE'],
        containerProperties: {
          image: d['image'],
          // `true` exits immediately — and NO job is ever submitted anyway.
          command: ['true'],
          resourceRequirements: [
            { type: 'VCPU', value: d['vcpus'] ?? JD_DEFAULTS.vcpus },
            { type: 'MEMORY', value: d['memoryMiB'] ?? JD_DEFAULTS.memoryMiB },
          ],
          executionRoleArn,
          networkConfiguration: { assignPublicIp: 'ENABLED' },
        },
        tags,
      }),
    );
    return registered.jobDefinitionArn ?? `batch:job-definition/${name}`;
  }

  /** All ACTIVE revisions for the family, newest first (paginated). */
  private async activeRevisions(name: string): Promise<JobDefinition[]> {
    const revisions: JobDefinition[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.batch.send(
        new DescribeJobDefinitionsCommand({
          jobDefinitionName: name,
          status: 'ACTIVE',
          ...(nextToken !== undefined ? { nextToken } : {}),
        }),
      );
      revisions.push(...(page.jobDefinitions ?? []));
      nextToken = page.nextToken;
    } while (nextToken !== undefined);
    return revisions.sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0));
  }
}
