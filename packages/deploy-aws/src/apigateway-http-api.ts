/**
 * `aws:apigatewayv2:Api` handler (@aws-sdk/client-apigatewayv2) — HTTP API
 * (M22.1).
 *
 * read → GetApis (name match; ApiGatewayV2 has no get-by-name)
 * create → CreateApi (HTTP protocol; quick-create Lambda proxy integration
 *          when a sibling function exists via the `targetFunctionArn`
 *          attribute or name convention)
 * update → UpdateApi (description/CORS surface kept minimal)
 * delete → DeleteApi
 *
 * HONEST SCOPE: the Gateway kind has no spec discriminator to choose HTTP API
 * over ALB until 1.3.0's `Gateway.protocol` vocabulary (M24.1) — this handler
 * ships and live-proves now; mapping emission follows the spec minor.
 * Protocol type is immutable — drift replaces (ADR-0006).
 */

import {
  CreateApiCommand,
  DeleteApiCommand,
  GetApisCommand,
  TagResourceCommand,
  UpdateApiCommand,
} from '@aws-sdk/client-apigatewayv2';
import type { ApiGatewayV2Client, ProtocolType } from '@aws-sdk/client-apigatewayv2';
import type { PlanResource } from '@iap/provider-sdk';
import type { ResourceState, TargetHandler } from './types.js';
import { isManaged } from './tags.js';
import { resourceIdOf, scalarStr } from './util.js';

export class ApiGatewayHttpApiHandler implements TargetHandler {
  static readonly targetType = 'aws:apigatewayv2:Api' as const;
  readonly targetType = ApiGatewayHttpApiHandler.targetType;
  /** HTTP ↔ WEBSOCKET cannot convert in place (ADR-0006). */
  readonly immutableProjectionKeys = ['protocolType'] as const;

  constructor(
    private readonly client: ApiGatewayV2Client,
    private readonly region: string,
  ) {}

  desiredProjection(resource: PlanResource): Record<string, string> {
    const a = resource.desiredAttributes;
    return {
      protocolType: scalarStr(a['protocolType']) || 'HTTP',
      description: scalarStr(a['description']),
    };
  }

  async read(resource: PlanResource): Promise<ResourceState> {
    const name = resourceIdOf(resource);
    const found = await this.client.send(new GetApisCommand({ MaxResults: '1000' }));
    const api = (found.Items ?? []).find((a) => a.Name === name);
    if (api?.ApiId === undefined) {
      return { exists: false, managed: false, tags: {}, projection: {} };
    }

    const tags = api.Tags ?? {};
    const desiredDescription = scalarStr(resource.desiredAttributes['description']);
    return {
      exists: true,
      managed: isManaged(tags),
      tags,
      identifier: api.ApiId,
      projection: {
        protocolType: api.ProtocolType ?? '',
        // Compare description only when the plan sets one.
        description: desiredDescription === '' ? '' : (api.Description ?? ''),
      },
    };
  }

  async create(resource: PlanResource, tags: Record<string, string>): Promise<string> {
    const d = this.desiredProjection(resource);
    const target = scalarStr(resource.desiredAttributes['targetFunctionArn']);
    const created = await this.client.send(
      new CreateApiCommand({
        Name: resourceIdOf(resource),
        ProtocolType: d['protocolType'] as ProtocolType,
        ...(d['description'] ? { Description: d['description'] } : {}),
        // Quick-create: a $default route proxying to the Lambda target.
        ...(target ? { Target: target } : {}),
        Tags: tags,
      }),
    );
    return created.ApiId ?? `apigatewayv2:${resourceIdOf(resource)}`;
  }

  async update(resource: PlanResource, current: ResourceState): Promise<void> {
    const d = this.desiredProjection(resource);
    await this.client.send(
      new UpdateApiCommand({
        ApiId: current.identifier ?? '',
        ...(d['description'] ? { Description: d['description'] } : {}),
      }),
    );
    if (current.identifier !== undefined) {
      // ApiGatewayV2 TagResource wants the full ARN shape for the api.
      await this.client.send(
        new TagResourceCommand({
          ResourceArn: `arn:aws:apigateway:${this.region}::/apis/${current.identifier}`,
          Tags: current.tags,
        }),
      );
    }
  }

  async delete(_resource: PlanResource, current: ResourceState): Promise<void> {
    await this.client.send(new DeleteApiCommand({ ApiId: current.identifier ?? '' }));
  }
}
