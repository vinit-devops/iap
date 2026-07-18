/**
 * `aws:mq:Broker` handler (@aws-sdk/client-mq) — managed ActiveMQ/RabbitMQ
 * (M22.3).
 *
 * IDENTITY: broker names are unique per account/region but the API is
 * ID-driven — the handler resolves name → BrokerId via paginated ListBrokers
 * and the generated id never leaves the handler (backup-plan idiom, M22.2).
 *
 * read   → ListBrokers (paginate to the name match) → DescribeBroker; absent
 *          when no summary matches or BrokerState is DELETION_IN_PROGRESS;
 *          tags come inline on DescribeBroker.Tags
 * create → CreateBroker: single-instance, never publicly accessible, first
 *          default-VPC subnet + default SG (ADR-0005), admin credential
 *          generated locally — passed once to AWS, never logged, never
 *          projected, never read back (M21.2 secrets posture)
 * update → UpdateBroker + CreateTags (the MQ tag API, on the broker ARN)
 * delete → DeleteBroker by the name-resolved id; an unresolved name REFUSES
 *          the delete (never a blind id guess)
 *
 * `engineType` and `deploymentMode` are immutable — drift replaces (ADR-0006,
 * gated). `instanceType` and `autoMinorVersionUpgrade` reconcile via
 * UpdateBroker, but HONESTLY: both take effect at the next maintenance window
 * (or reboot) — the API accepts the change immediately, the broker converges
 * later. The projection reads the accepted desired values, so the plan goes
 * quiet after the call; the live broker catches up on AWS's schedule.
 */

import { randomBytes } from 'node:crypto';
import {
  CreateBrokerCommand,
  CreateTagsCommand,
  DeleteBrokerCommand,
  DescribeBrokerCommand,
  ListBrokersCommand,
  UpdateBrokerCommand,
} from '@aws-sdk/client-mq';
import type { EngineType, MqClient, UpdateBrokerRequest } from '@aws-sdk/client-mq';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';
import { defaultSecurityGroupId, defaultSubnetIds } from './network.js';

const DEFAULT_ENGINE_TYPE = 'ACTIVEMQ';
const DEFAULT_INSTANCE_TYPE = 'mq.t3.micro';
/** v0.1 posture: single-instance only (multi-AZ modes are a later wave). */
const DEPLOYMENT_MODE = 'SINGLE_INSTANCE';

export class MqBrokerHandler implements TargetHandler {
  static readonly targetType = 'aws:mq:Broker' as const;
  readonly targetType = MqBrokerHandler.targetType;
  /** Engine and deployment topology cannot change in place (ADR-0006). */
  readonly immutableProjectionKeys = ['engineType', 'deploymentMode'] as const;

  constructor(
    private readonly mq: MqClient,
    private readonly ec2: EC2Client,
  ) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      // AWS canonicalises the engine name's CASE on read — CreateBroker takes
      // `ACTIVEMQ`/`RABBITMQ` (SDK enum) but DescribeBroker returns
      // `ActiveMQ`/`RabbitMQ`. Normalise BOTH sides to upper case so a
      // converged broker classifies no-op, not a destructive `replace` on this
      // immutable key (M22.3 live finding — the mock returned the enum casing).
      engineType: (scalarStr(a['engineType']) || DEFAULT_ENGINE_TYPE).toUpperCase(),
      deploymentMode: DEPLOYMENT_MODE,
      instanceType: scalarStr(a['instanceType']) || DEFAULT_INSTANCE_TYPE,
      // Patch-current default: minor upgrades on unless explicitly opted out.
      autoMinorVersionUpgrade:
        scalarStr(a['autoMinorVersionUpgrade']) === 'false' ? 'false' : 'true',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    const resolved = await this.resolveByName(name);
    if (resolved === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const broker = await this.mq.send(new DescribeBrokerCommand({ BrokerId: resolved.id }));
    // A broker mid-teardown still lists — but its name is on the way to free
    // and no update is accepted; converge by recreating, not reconciling.
    if (broker.BrokerState === 'DELETION_IN_PROGRESS') {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = broker.Tags ?? {};
    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        // Upper-case to match desiredProjection: AWS returns `ActiveMQ`, the
        // enum/desired side is `ACTIVEMQ` (M22.3 live finding).
        engineType: (broker.EngineType ?? '').toUpperCase(),
        deploymentMode: broker.DeploymentMode ?? '',
        // An accepted UpdateBroker instance-type change lands in
        // PendingHostInstanceType and only migrates HostInstanceType at the
        // maintenance window. The projection must reflect the ACCEPTED value so
        // the plan goes quiet after the call (the documented contract) instead
        // of re-planning `update` every run until the window (M22.3 live
        // finding — the mock had no pending field).
        instanceType: broker.PendingHostInstanceType ?? broker.HostInstanceType ?? '',
        autoMinorVersionUpgrade: broker.AutoMinorVersionUpgrade === true ? 'true' : 'false',
      },
    };
    if (broker.BrokerArn !== undefined) state.identifier = broker.BrokerArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const id = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    // SINGLE_INSTANCE takes exactly one subnet; default VPC + default SG
    // (ADR-0005) until the M23.4 Network handlers land.
    const SubnetIds = await defaultSubnetIds(this.ec2, 1);
    const securityGroup = await defaultSecurityGroupId(this.ec2);
    // Admin credential: generated locally (32 chars, well over MQ's 12-char
    // minimum), passed ONCE to CreateBroker, never logged, never projected,
    // never stored, never read back. Operators rotate it out of band.
    const password = randomBytes(24).toString('base64url');
    const created = await this.mq.send(
      new CreateBrokerCommand({
        BrokerName: id,
        EngineType: d['engineType'] as EngineType,
        HostInstanceType: d['instanceType'],
        DeploymentMode: DEPLOYMENT_MODE,
        PubliclyAccessible: false,
        AutoMinorVersionUpgrade: d['autoMinorVersionUpgrade'] === 'true',
        SubnetIds,
        SecurityGroups: [securityGroup],
        Users: [{ Username: 'iapadmin', Password: password }],
        // CreateBroker takes a tag MAP, not a Key/Value list.
        Tags: tags,
      }),
    );
    return created.BrokerArn ?? `mq:broker:${id}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const name = resourceIdOf(resource);
    const d = this.desiredProjection(resource);
    const live = current.projection;
    const changes: Omit<UpdateBrokerRequest, 'BrokerId'> = {};
    // Both mutables apply at the next maintenance window (or reboot) — the
    // call is accepted now, the broker converges later. No immediacy claimed.
    if (d['autoMinorVersionUpgrade'] !== live['autoMinorVersionUpgrade']) {
      changes.AutoMinorVersionUpgrade = d['autoMinorVersionUpgrade'] === 'true';
    }
    if (d['instanceType'] !== live['instanceType']) {
      changes.HostInstanceType = d['instanceType'];
    }
    if (Object.keys(changes).length > 0) {
      const resolved = await this.resolveByName(name);
      if (resolved === undefined) {
        throw new Error(`mq broker ${name} disappeared between read and update`);
      }
      await this.mq.send(new UpdateBrokerCommand({ BrokerId: resolved.id, ...changes }));
    }
    if (current.identifier !== undefined) {
      await this.mq.send(
        new CreateTagsCommand({ ResourceArn: current.identifier, Tags: current.tags }),
      );
    }
  }

  async delete(resource: PlanResource): Promise<void> {
    const name = resourceIdOf(resource);
    const resolved = await this.resolveByName(name);
    if (resolved === undefined) {
      throw new Error(`mq broker ${name} not found by name — refusing blind delete`);
    }
    await this.mq.send(new DeleteBrokerCommand({ BrokerId: resolved.id }));
  }

  /**
   * Name → generated-id resolution: paginate ListBrokers until the page
   * carrying `BrokerName === name`. The id never leaves the handler.
   */
  private async resolveByName(name: string): Promise<{ id: string; arn?: string } | undefined> {
    let NextToken: string | undefined;
    do {
      const page = await this.mq.send(new ListBrokersCommand({ NextToken }));
      const match = (page.BrokerSummaries ?? []).find((b) => b.BrokerName === name);
      if (match?.BrokerId !== undefined) {
        return match.BrokerArn !== undefined
          ? { id: match.BrokerId, arn: match.BrokerArn }
          : { id: match.BrokerId };
      }
      NextToken = page.NextToken;
    } while (NextToken !== undefined);
    return undefined;
  }
}
