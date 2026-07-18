/**
 * `aws:apprunner:Service` handler (@aws-sdk/client-apprunner) — fully managed
 * container web service (M22.5).
 *
 * IDENTITY — the ServiceName is the resourceId, but every App Runner
 * operation is ARN-driven: the ARN is resolved by paginating ListServices
 * until `ServiceName === resourceIdOf(...)` and stays internal to the handler
 * (backup.ts name→generated-id idiom).
 *
 *   read   → ListServices (paginate) → DescribeService; absent when unmatched
 *            or Status DELETED. Status OPERATION_IN_PROGRESS still reads as
 *            existing — an honest read; the LIVE driver waits between
 *            operations, the handler never spins. Tags via ListTagsForResource
 *            on the service ARN.
 *   create → CreateService: public hello-app-runner image by default
 *            (ECR_PUBLIC), AutoDeploymentsEnabled false, Cpu/Memory from
 *            attributes, Tags.
 *   update → UpdateService with the full desired SourceConfiguration +
 *            InstanceConfiguration (image/port/cpu/memory are ALL mutable).
 *            App Runner REJECTS updates while an operation is in progress
 *            (InvalidStateException) — that error surfaces honestly as a
 *            recorded per-object failure; no in-handler retry loops.
 *   delete → DeleteService by the resolved ARN. Deletion is asynchronous
 *            (Status → DELETED terminal); the live driver polls, not us.
 *
 * REPLACEMENT — justified N/A (ADR-0006): every projection key (image, port,
 * cpu, memory) reconciles in place via UpdateService, so there are NO
 * immutable projection keys and drift can never classify as `replace`.
 */

import {
  CreateServiceCommand,
  DeleteServiceCommand,
  DescribeServiceCommand,
  ListServicesCommand,
  ListTagsForResourceCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-apprunner';
import type {
  AppRunnerClient,
  InstanceConfiguration,
  SourceConfiguration,
} from '@aws-sdk/client-apprunner';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';

const DEFAULTS = {
  image: 'public.ecr.aws/aws-containers/hello-app-runner:latest',
  port: '8000',
  cpu: '256',
  memory: '512',
} as const;

export class AppRunnerServiceHandler implements TargetHandler {
  static readonly targetType = 'aws:apprunner:Service' as const;
  readonly targetType = AppRunnerServiceHandler.targetType;
  // All projection keys reconcile in place via UpdateService — replacement N/A.

  constructor(private readonly apprunner: AppRunnerClient) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      image: scalarStr(a['image']) || DEFAULTS.image,
      port: scalarStr(a['port']) || DEFAULTS.port,
      cpu: scalarStr(a['cpu']) || DEFAULTS.cpu,
      memory: scalarStr(a['memory']) || DEFAULTS.memory,
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const arn = await this.resolveArn(resourceIdOf(resource));
    if (arn === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const found = await this.apprunner.send(new DescribeServiceCommand({ ServiceArn: arn }));
    const service = found.Service;
    // DELETED is terminal — the name lingers in ListServices for a while but
    // the service is gone. OPERATION_IN_PROGRESS still EXISTS (honest read).
    if (service === undefined || service.Status === 'DELETED') {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tagResult = await this.apprunner.send(
      new ListTagsForResourceCommand({ ResourceArn: arn }),
    );
    const tags = fromTagList(tagResult.Tags ?? []);

    const repo = service.SourceConfiguration?.ImageRepository;
    return {
      exists: true,
      managed: isManaged(tags),
      tags,
      identifier: arn,
      projection: {
        image: repo?.ImageIdentifier ?? '',
        port: repo?.ImageConfiguration?.Port ?? '',
        cpu: service.InstanceConfiguration?.Cpu ?? '',
        memory: service.InstanceConfiguration?.Memory ?? '',
      },
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const ServiceName = resourceIdOf(resource);
    const created = await this.apprunner.send(
      new CreateServiceCommand({
        ServiceName,
        SourceConfiguration: this.sourceConfiguration(resource),
        InstanceConfiguration: this.instanceConfiguration(resource),
        Tags: toTagList(tags),
      }),
    );
    return created.Service?.ServiceArn ?? `apprunner:service/${ServiceName}`;
  }

  /**
   * All drift reconciles in place. App Runner rejects UpdateService while the
   * service is OPERATION_IN_PROGRESS — that error propagates unchanged
   * (recorded per-object by the executor); the live driver owns the waiting.
   */
  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const arn = await this.arnOf(resource, current);
    await this.apprunner.send(
      new UpdateServiceCommand({
        ServiceArn: arn,
        SourceConfiguration: this.sourceConfiguration(resource),
        InstanceConfiguration: this.instanceConfiguration(resource),
      }),
    );
  }

  /** Async delete by resolved ARN; DELETED is terminal (live driver polls). */
  async delete(resource: PlanResource, current: ResourceState): Promise<void> {
    const arn = await this.arnOf(resource, current);
    await this.apprunner.send(new DeleteServiceCommand({ ServiceArn: arn }));
  }

  /** ARN from the read state when available, else re-resolved by name. */
  private async arnOf(resource: PlanResource, current: ResourceState): Promise<string> {
    const name = resourceIdOf(resource);
    const arn = current.identifier ?? (await this.resolveArn(name));
    if (arn === undefined) {
      throw new Error(`App Runner service ${name} not found by name — refusing blind operation`);
    }
    return arn;
  }

  /**
   * Name → ARN resolution: paginate ListServices until the page carrying
   * `ServiceName === name`. The ARN never leaves the handler.
   */
  private async resolveArn(name: string): Promise<string | undefined> {
    let NextToken: string | undefined;
    do {
      const page = await this.apprunner.send(new ListServicesCommand({ NextToken }));
      const match = (page.ServiceSummaryList ?? []).find((s) => s.ServiceName === name);
      if (match?.ServiceArn !== undefined) return match.ServiceArn;
      NextToken = page.NextToken;
    } while (NextToken !== undefined);
    return undefined;
  }

  private sourceConfiguration(resource: PlanResource): SourceConfiguration {
    const d = this.desiredProjection(resource);
    return {
      ImageRepository: {
        ImageIdentifier: d['image'],
        ImageRepositoryType: 'ECR_PUBLIC',
        ImageConfiguration: { Port: d['port'] },
      },
      AutoDeploymentsEnabled: false,
    };
  }

  private instanceConfiguration(resource: PlanResource): InstanceConfiguration {
    const d = this.desiredProjection(resource);
    return { Cpu: d['cpu'], Memory: d['memory'] };
  }
}
