/**
 * Shared runtime types: the handler contract every target type implements and
 * the structured plan/apply reports the executor returns.
 */

import type { PlanResource } from '@iap/provider-sdk';

/** The exactly-three target types the v0.1 executor realizes. */
export const SUPPORTED_TARGET_TYPES = ['aws:s3:Bucket', 'aws:sqs:Queue', 'aws:iam:Role'] as const;

export type SupportedTargetType = (typeof SUPPORTED_TARGET_TYPES)[number];

export function isSupportedTargetType(type: string): type is SupportedTargetType {
  return (SUPPORTED_TARGET_TYPES as readonly string[]).includes(type);
}

/** Per-object convergence action. */
export type PlanAction = 'create' | 'no-op' | 'update' | 'delete';

/** Observed state of a single resource, from read-only describe calls. */
export interface ResourceState {
  exists: boolean;
  /** iap:managed=true present — required before destroy will touch it. */
  managed: boolean;
  tags: Record<string, string>;
  /** Real identifier (ARN / queue URL) when the resource exists. */
  identifier?: string;
  /** Normalized projection of the managed attributes, for drift comparison. */
  projection: Record<string, string>;
}

/** The SDK-facing contract each target type implements. */
export interface TargetHandler {
  readonly targetType: SupportedTargetType;
  /** Read-only: describe the live resource. Never mutates. */
  read(resource: PlanResource): Promise<ResourceState>;
  /** Desired managed-attribute projection, for drift comparison against read. */
  desiredProjection(resource: PlanResource): Record<string, string>;
  /** Create the resource with the mandatory + caller tags. Returns its identifier. */
  create(resource: PlanResource, tags: Record<string, string>): Promise<string>;
  /** Reconcile a drifted resource back to desired. */
  update(resource: PlanResource, current: ResourceState): Promise<void>;
  /** Delete the resource (caller has already enforced the managed gate). */
  delete(resource: PlanResource, current: ResourceState): Promise<void>;
}

export interface PlanItem {
  logicalId: string;
  targetType: string;
  action: PlanAction;
  reason: string;
}

export interface PlanReport {
  planId: string;
  region: string;
  mode: 'plan';
  destroy: boolean;
  items: PlanItem[];
}

export interface ApplyOutcomeItem {
  logicalId: string;
  targetType: string;
  action: PlanAction;
  /** Whether a mutating call was actually issued for this object. */
  applied: boolean;
  identifier?: string;
  error?: string;
}

export interface ApplyReport {
  planId: string;
  region: string;
  /** True only when the live gate (apply === true) was open. */
  applied: boolean;
  mode: 'apply' | 'dry-run';
  destroy: boolean;
  items: ApplyOutcomeItem[];
  errors: string[];
}

/** Fail-closed error for any target type outside the v0.1 golden path. */
export class UnsupportedTargetTypeError extends Error {
  constructor(public readonly targetType: string) {
    super(`unsupported target type in v0.1 executor: ${targetType}`);
    this.name = 'UnsupportedTargetTypeError';
  }
}
