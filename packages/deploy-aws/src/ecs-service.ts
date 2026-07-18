/**
 * `aws:ecs:Service` handler (@aws-sdk/client-ecs) — the Service kind's Fargate
 * workload (M21.3). One handler owns the service AND its two sub-resources:
 * the cluster (`<resourceId>-cluster`, created/deleted with the service) and
 * the task definition family (`<resourceId>`, a new revision per image/size
 * change, all revisions deregistered at delete — zero-orphan teardown).
 *
 * read → DescribeServices (+ DescribeTaskDefinition for image/cpu/memory)
 * create → CreateCluster (idempotent) + RegisterTaskDefinition + CreateService
 *          over the default VPC's subnets/SG (ADR-0005)
 * update → RegisterTaskDefinition (on image/size drift) + UpdateService
 * delete → DeleteService(force) + DeregisterTaskDefinition(all revisions)
 *          + DeleteCluster
 *
 * Launch type is immutable — drift replaces (ADR-0006). Auto-scaling
 * (autoScalingMaxCapacity/TargetCpuUtilization → Application Auto Scaling)
 * and serviceConnectEnabled (needs a Cloud Map namespace) are honest gaps
 * until M22.5 — excluded from the projection, noted in evidence.
 */

import {
  CreateClusterCommand,
  CreateServiceCommand,
  DeleteClusterCommand,
  DeleteServiceCommand,
  DeregisterTaskDefinitionCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ListTaskDefinitionsCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import type { ECSClient } from '@aws-sdk/client-ecs';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';
import { defaultSecurityGroupId, defaultSubnetIds } from './network.js';

const CLUSTER_NOT_FOUND = ['ClusterNotFoundException'] as const;
const DEFAULTS = { cpu: '256', memory: '512', desiredCount: '1' } as const;

/** ECS tags use lower-case `key`/`value` — not the `{Key,Value}` shape. */
function toEcsTagList(tags: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.keys(tags)
    .sort()
    .map((key) => ({ key, value: tags[key] ?? '' }));
}

function fromEcsTagList(
  list: ReadonlyArray<{ key?: string | undefined; value?: string | undefined }>,
): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const entry of list) {
    if (entry.key !== undefined) tags[entry.key] = entry.value ?? '';
  }
  return tags;
}

export class EcsServiceHandler implements TargetHandler {
  static readonly targetType = 'aws:ecs:Service' as const;
  readonly targetType = EcsServiceHandler.targetType;
  /** Launch type cannot change in place (ADR-0006). */
  readonly immutableProjectionKeys = ['launchType'] as const;

  constructor(
    private readonly client: ECSClient,
    private readonly ec2: EC2Client,
  ) {}

  private clusterName(resource: PlanResource): string {
    return `${resourceIdOf(resource)}-cluster`;
  }

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      launchType: scalarStr(a['launchType']) || 'FARGATE',
      image: scalarStr(a['image']),
      cpu: scalarStr(a['cpu']) || DEFAULTS.cpu,
      memory: scalarStr(a['memory']) || DEFAULTS.memory,
      desiredCount: scalarStr(a['desiredCount']) || DEFAULTS.desiredCount,
      assignPublicIp: scalarStr(a['assignPublicIp']) === 'true' ? 'true' : 'false',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const serviceName = resourceIdOf(resource);
    let service;
    try {
      const found = await this.client.send(
        new DescribeServicesCommand({
          cluster: this.clusterName(resource),
          services: [serviceName],
          include: ['TAGS'],
        }),
      );
      service = found.services?.[0];
    } catch (err) {
      if (nameMatches(err, CLUSTER_NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (service === undefined || service.status === 'INACTIVE') {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = fromEcsTagList(service.tags ?? []);
    let image = '';
    let cpu = '';
    let memory = '';
    if (service.taskDefinition !== undefined) {
      const td = await this.client.send(
        new DescribeTaskDefinitionCommand({ taskDefinition: service.taskDefinition }),
      );
      image = td.taskDefinition?.containerDefinitions?.[0]?.image ?? '';
      cpu = td.taskDefinition?.cpu ?? '';
      memory = td.taskDefinition?.memory ?? '';
    }
    const assignPublicIp =
      service.networkConfiguration?.awsvpcConfiguration?.assignPublicIp === 'ENABLED';

    const state: ResourceState = {
      exists: true,
      managed: isManaged(tags),
      tags,
      projection: {
        launchType: service.launchType ?? 'FARGATE',
        image,
        cpu,
        memory,
        desiredCount: service.desiredCount === undefined ? '' : String(service.desiredCount),
        assignPublicIp: assignPublicIp ? 'true' : 'false',
      },
    };
    if (service.serviceArn !== undefined) state.identifier = service.serviceArn;
    return state;
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const serviceName = resourceIdOf(resource);
    const cluster = this.clusterName(resource);
    const d = this.desiredProjection(resource);
    const ecsTags = toEcsTagList(tags);

    await this.client.send(new CreateClusterCommand({ clusterName: cluster, tags: ecsTags }));
    const taskDefinitionArn = await this.registerTaskDefinition(resource);

    const spread = Number(scalarStr(resource.desiredAttributes['availabilityZoneSpread']) || '2');
    const [subnets, securityGroup] = await Promise.all([
      defaultSubnetIds(this.ec2, spread),
      defaultSecurityGroupId(this.ec2),
    ]);

    const created = await this.client.send(
      new CreateServiceCommand({
        cluster,
        serviceName,
        taskDefinition: taskDefinitionArn,
        desiredCount: Number(d['desiredCount']),
        launchType: d['launchType'] as 'FARGATE' | 'EC2',
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets,
            securityGroups: [securityGroup],
            assignPublicIp: d['assignPublicIp'] === 'true' ? 'ENABLED' : 'DISABLED',
          },
        },
        tags: ecsTags,
      }),
    );
    return created.service?.serviceArn ?? `ecs:service/${cluster}/${serviceName}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const d = this.desiredProjection(resource);
    const live = current.projection;
    const taskDrift =
      d['image'] !== live['image'] || d['cpu'] !== live['cpu'] || d['memory'] !== live['memory'];
    const taskDefinition = taskDrift ? await this.registerTaskDefinition(resource) : undefined;

    await this.client.send(
      new UpdateServiceCommand({
        cluster: this.clusterName(resource),
        service: resourceIdOf(resource),
        desiredCount: Number(d['desiredCount']),
        ...(taskDefinition !== undefined ? { taskDefinition } : {}),
      }),
    );
  }

  async delete(resource: PlanResource): Promise<void> {
    const serviceName = resourceIdOf(resource);
    const cluster = this.clusterName(resource);
    await this.client.send(
      new DeleteServiceCommand({ cluster, service: serviceName, force: true }),
    );
    // A force-deleted service lingers in DRAINING; the cluster cannot be
    // deleted until it reaches INACTIVE. Bounded waiter (runbook waiter budget).
    await this.waitForServiceInactive(cluster, serviceName);
    // Deregister every task-definition revision in the family (zero orphans).
    const revisions = await this.client.send(
      new ListTaskDefinitionsCommand({ familyPrefix: serviceName }),
    );
    for (const arn of revisions.taskDefinitionArns ?? []) {
      await this.client.send(new DeregisterTaskDefinitionCommand({ taskDefinition: arn }));
    }
    await this.client.send(new DeleteClusterCommand({ cluster }));
  }

  /** Poll (5s interval, ≤36 attempts = 3 min budget) until the service is INACTIVE/gone. */
  private async waitForServiceInactive(cluster: string, serviceName: string): Promise<void> {
    for (let attempt = 0; attempt < 36; attempt += 1) {
      const found = await this.client.send(
        new DescribeServicesCommand({ cluster, services: [serviceName] }),
      );
      const status = found.services?.[0]?.status;
      if (status === undefined || status === 'INACTIVE') return;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error(
      `service ${serviceName} did not reach INACTIVE within the 3-minute waiter budget`,
    );
  }

  private async registerTaskDefinition(resource: PlanResource): Promise<string> {
    const d = this.desiredProjection(resource);
    const registered = await this.client.send(
      new RegisterTaskDefinitionCommand({
        family: resourceIdOf(resource),
        requiresCompatibilities: ['FARGATE'],
        networkMode: 'awsvpc',
        cpu: d['cpu'],
        memory: d['memory'],
        containerDefinitions: [{ name: 'app', image: d['image'], essential: true }],
      }),
    );
    const arn = registered.taskDefinition?.taskDefinitionArn;
    if (arn === undefined) throw new Error('RegisterTaskDefinition returned no ARN');
    return arn;
  }
}
