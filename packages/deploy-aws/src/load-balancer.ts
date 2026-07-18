/**
 * `aws:elasticloadbalancing:LoadBalancer` handler
 * (@aws-sdk/client-elastic-load-balancing-v2) — the Gateway kind's ALB
 * (M21.3, live-proven) plus the NLB variant (M22.5) on the SAME target type.
 *
 * The `loadBalancerType` desired attribute discriminates the variant:
 *   - 'application' (default) — the original ALB path, unchanged: HTTP
 *     attributes (`dropInvalidHeaderFields`, `accessLogsEnabled`) are part of
 *     the projection and applied via ModifyLoadBalancerAttributes.
 *   - 'network' — CreateLoadBalancer Type 'network'. NLBs are L4: the
 *     ALB-only HTTP attributes (`sslPolicy`, `dropInvalidHeaderFields`,
 *     `accessLogsEnabled`, `accessLogsBucket`) have no meaning there, so a
 *     network plan that PINS any of them fails closed with an honest error —
 *     never a silent drop (ch. 12 §12.3 spirit). Scheme defaults to internal.
 *
 * read → DescribeLoadBalancers + DescribeTags (+ DescribeLoadBalancerAttributes,
 *        ALB only — HTTP attributes do not exist on an NLB)
 * create → CreateLoadBalancer over the default VPC's subnets (ADR-0005),
 *          then ModifyLoadBalancerAttributes (ALB only)
 * update → ModifyLoadBalancerAttributes (ALB only), AddTags
 * delete → DeleteLoadBalancer
 *
 * Type and scheme are immutable — drift replaces (ADR-0006); in particular
 * application↔network drift is a gated replace, the natural replacement story
 * for changing the balancer's layer. `sslPolicy` is a LISTENER setting: it
 * applies when the Gateway golden path wires listeners (with the ACM
 * certificate) and is excluded from this handler's projection — honest gap,
 * noted in evidence. Access-log enablement requires a bucket
 * (`accessLogsBucket` attribute); enabling without one fails closed.
 */

import {
  AddTagsCommand,
  CreateLoadBalancerCommand,
  DeleteLoadBalancerCommand,
  DescribeLoadBalancerAttributesCommand,
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  ModifyLoadBalancerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type {
  ElasticLoadBalancingV2Client,
  LoadBalancerSchemeEnum,
  LoadBalancerTypeEnum,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { fromTagList, isManaged, toTagList } from './tags.js';
import { nameMatches, resourceIdOf, scalarStr } from './util.js';
import { defaultSubnetIds } from './network.js';

const NOT_FOUND = ['LoadBalancerNotFound'] as const;

/**
 * Desired attributes with ALB-only (HTTP) semantics. Pinning any of these on
 * a `loadBalancerType: network` plan fails closed — an NLB cannot honour them
 * and silently dropping them would lie about the applied posture.
 */
const ALB_ONLY_ATTRIBUTES = [
  'sslPolicy',
  'dropInvalidHeaderFields',
  'accessLogsEnabled',
  'accessLogsBucket',
] as const;

export class LoadBalancerHandler implements TargetHandler {
  static readonly targetType = 'aws:elasticloadbalancing:LoadBalancer' as const;
  readonly targetType = LoadBalancerHandler.targetType;
  /**
   * ELBv2 type and scheme cannot change in place (ADR-0006) —
   * application↔network drift is the gated delete+create replacement story.
   */
  readonly immutableProjectionKeys = ['loadBalancerType', 'scheme'] as const;

  constructor(
    private readonly client: ElasticLoadBalancingV2Client,
    private readonly ec2: EC2Client,
  ) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    const loadBalancerType = scalarStr(a['loadBalancerType']) || 'application';
    if (loadBalancerType === 'network') {
      // NLB posture: L4 only — fail closed on pinned HTTP attributes.
      this.assertNoAlbOnlyAttributes(resource);
      return {
        loadBalancerType,
        scheme: scalarStr(a['scheme']) || 'internal',
      };
    }
    return {
      loadBalancerType,
      scheme: scalarStr(a['scheme']) || 'internal',
      dropInvalidHeaderFields:
        scalarStr(a['dropInvalidHeaderFields']) === 'true' ? 'true' : 'false',
      accessLogsEnabled: scalarStr(a['accessLogsEnabled']) === 'true' ? 'true' : 'false',
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    let lb;
    try {
      const found = await this.client.send(new DescribeLoadBalancersCommand({ Names: [name] }));
      lb = found.LoadBalancers?.[0];
    } catch (err) {
      if (nameMatches(err, NOT_FOUND)) {
        return { exists: false, managed: false, tags: {}, projection: {} };
      }
      throw err;
    }
    if (lb?.LoadBalancerArn === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const arn = lb.LoadBalancerArn;
    if (lb.Type === 'network') {
      // NLB: the HTTP attribute surface does not exist — tags only.
      const tagResult = await this.client.send(new DescribeTagsCommand({ ResourceArns: [arn] }));
      const tags = fromTagList(tagResult.TagDescriptions?.[0]?.Tags ?? []);
      return {
        exists: true,
        managed: isManaged(tags),
        tags,
        identifier: arn,
        projection: {
          loadBalancerType: 'network',
          scheme: lb.Scheme ?? '',
        },
      };
    }

    const [tagResult, attrResult] = await Promise.all([
      this.client.send(new DescribeTagsCommand({ ResourceArns: [arn] })),
      this.client.send(new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: arn })),
    ]);
    const tags = fromTagList(tagResult.TagDescriptions?.[0]?.Tags ?? []);
    const attrs: Record<string, string> = {};
    for (const attr of attrResult.Attributes ?? []) {
      if (attr.Key !== undefined) attrs[attr.Key] = attr.Value ?? '';
    }

    return {
      exists: true,
      managed: isManaged(tags),
      tags,
      identifier: arn,
      projection: {
        loadBalancerType: lb.Type ?? '',
        scheme: lb.Scheme ?? '',
        dropInvalidHeaderFields:
          attrs['routing.http.drop_invalid_header_fields.enabled'] === 'true' ? 'true' : 'false',
        accessLogsEnabled: attrs['access_logs.s3.enabled'] === 'true' ? 'true' : 'false',
      },
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const name = resourceIdOf(resource);
    const d = this.desiredProjection(resource); // fails closed on NLB + ALB-only attrs
    const Subnets = await defaultSubnetIds(this.ec2);
    if (Subnets.length < 2) {
      throw new Error(`a ${d['loadBalancerType']} load balancer needs subnets in at least two AZs`);
    }
    const created = await this.client.send(
      new CreateLoadBalancerCommand({
        Name: name,
        Type: d['loadBalancerType'] as LoadBalancerTypeEnum,
        Scheme: d['scheme'] as LoadBalancerSchemeEnum,
        Subnets,
        Tags: toTagList(tags),
      }),
    );
    const arn = created.LoadBalancers?.[0]?.LoadBalancerArn ?? `elbv2:loadbalancer/${name}`;
    if (d['loadBalancerType'] !== 'network') {
      await this.applyAttributes(arn, resource);
    }
    return arn;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const d = this.desiredProjection(resource); // fails closed on NLB + ALB-only attrs
    const arn = current.identifier ?? '';
    if (d['loadBalancerType'] !== 'network') {
      await this.applyAttributes(arn, resource);
    }
    await this.client.send(
      new AddTagsCommand({ ResourceArns: [arn], Tags: toTagList(current.tags) }),
    );
  }

  async delete(_resource: PlanResource, current: ResourceState): Promise<void> {
    await this.client.send(
      new DeleteLoadBalancerCommand({ LoadBalancerArn: current.identifier ?? '' }),
    );
  }

  /** Fail closed when a network plan pins an attribute with ALB-only semantics. */
  private assertNoAlbOnlyAttributes(resource: PlanResource): void {
    const pinned = ALB_ONLY_ATTRIBUTES.filter(
      (key) => resource.desiredAttributes[key] !== undefined,
    );
    if (pinned.length > 0) {
      throw new Error(
        `${resourceIdOf(resource)}: attribute(s) ${pinned.join(', ')} are ALB-only (HTTP ` +
          `semantics) and cannot apply to loadBalancerType: network — remove them or use ` +
          `loadBalancerType: application (fail-closed, no silent drop)`,
      );
    }
  }

  /** ALB-only: the routing.http.* / access-log HTTP attribute surface. */
  private async applyAttributes(arn: string, resource: PlanResource): Promise<void> {
    const d = this.desiredProjection(resource);
    const bucket = scalarStr(resource.desiredAttributes['accessLogsBucket']);
    if (d['accessLogsEnabled'] === 'true' && bucket === '') {
      throw new Error(
        'accessLogsEnabled=true requires an accessLogsBucket attribute (fail-closed)',
      );
    }
    const Attributes = [
      {
        Key: 'routing.http.drop_invalid_header_fields.enabled',
        Value: d['dropInvalidHeaderFields'],
      },
      { Key: 'access_logs.s3.enabled', Value: d['accessLogsEnabled'] },
      ...(d['accessLogsEnabled'] === 'true'
        ? [{ Key: 'access_logs.s3.bucket', Value: bucket }]
        : []),
    ];
    await this.client.send(
      new ModifyLoadBalancerAttributesCommand({ LoadBalancerArn: arn, Attributes }),
    );
  }
}
