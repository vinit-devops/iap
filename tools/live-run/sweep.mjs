#!/usr/bin/env node
/**
 * Live-run POST-RUN SWEEP (docs/guides/live-run-runbook.md "Post-run sweep";
 * ROADMAP-V4 M21.1). Proves zero orphans after a wave's teardown:
 *
 *   1. tagging-API sweep for iap:managed=true in the run's region → []
 *   2. IAM name-prefix sweep for infraasprompt-* roles (IAM is invisible to the tag API)
 *
 * Exit 0 = zero orphans (record "Zero orphans." in the evidence doc);
 * exit 1 = stragglers listed — delete them and re-sweep.
 *
 * `--mock` runs the same sequence with canned clean AWS responses. Usage:
 *
 *   node tools/live-run/sweep.mjs --region eu-west-1 [--aws-profile X]
 *        [--run-id infraasprompt-123] [--mock]
 */

import { awsCli, parseArgs, stepper } from './common.mjs';

const args = parseArgs(process.argv.slice(2), {
  region: 'value',
  'aws-profile': 'value',
  'run-id': 'value',
  mock: 'flag',
});

const mock = args.mock === true;
const region = args.region ?? (mock ? 'mock-region-1' : undefined);
const profile = args['aws-profile'];
const prefix = args['run-id'] ?? 'infraasprompt-';

const report = stepper(
  `live-run sweep${mock ? ' (MOCK)' : ''}: prefix ${prefix}, region ${region ?? 'UNSET'}`,
);

report.step('region explicitly chosen (fail-closed)', () => {
  if (!region) throw new Error('pass --region; no default region is assumed');
  return region;
});

report.step('tagging-API sweep for iap:managed=true returns zero resources', () => {
  const result = awsCli(
    ['resourcegroupstaggingapi', 'get-resources', '--tag-filters', 'Key=iap:managed,Values=true'],
    { mock, mockResult: { ResourceTagMappingList: [] }, profile, region },
  );
  let ghosts = 0;
  const orphans = (result?.ResourceTagMappingList ?? []).filter((r) => {
    // The tagging index retains DELETED ECS resources for a while — verify
    // ecs: ARNs against actual status instead of trusting the index.
    // KMS keys CANNOT disappear: ScheduleKeyDeletion leaves them in
    // PendingDeletion (the AWS-mandated terminal state, M22.2) until the
    // window lapses — verify kms: ARNs against KeyState the same way.
    if (
      !isEcsGhost(r.ResourceARN) &&
      !isKmsPendingDeletion(r.ResourceARN) &&
      !isCognitoUserPoolGhost(r.ResourceARN)
    )
      return true;
    ghosts += 1;
    return false;
  });
  if (orphans.length > 0) {
    throw new Error(`${orphans.length} orphan(s): ${orphans.map((r) => r.ResourceARN).join(', ')}`);
  }
  return ghosts > 0
    ? `zero orphans (${ghosts} tagging-index ghost(s) verified deleted/terminal via service APIs)`
    : 'zero orphans';
});

/** True when an ecs: ARN's resource is verified INACTIVE/absent (index ghost). */
function isEcsGhost(arn) {
  if (!arn?.startsWith('arn:aws:ecs:')) return false;
  const [, , , , , rest] = arn.split(':');
  const [kind, ...pathParts] = rest.split('/');
  if (kind === 'service') {
    const [cluster, service] = pathParts;
    const found = awsCli(
      ['ecs', 'describe-services', '--cluster', cluster, '--services', service],
      {
        mock,
        mockResult: { services: [] },
        profile,
        region,
      },
    );
    const status = found?.services?.[0]?.status;
    return status === undefined || status === 'INACTIVE';
  }
  if (kind === 'cluster') {
    const [cluster] = pathParts;
    const found = awsCli(['ecs', 'describe-clusters', '--clusters', cluster], {
      mock,
      mockResult: { clusters: [] },
      profile,
      region,
    });
    const status = found?.clusters?.[0]?.status;
    return status === undefined || status === 'INACTIVE';
  }
  return false;
}

/**
 * True when a kms: ARN's key is scheduled for deletion — KMS forbids
 * immediate deletion, so PendingDeletion/PendingReplicaDeletion IS the
 * deleted terminal state (the handler-owned alias is already gone); the key
 * leaves the tagging index only when the pending window lapses.
 */
/**
 * True when a cognito-idp: user-pool ARN's pool is already deleted — Cognito
 * user pools linger in the tagging index for a while after DeleteUserPool
 * (like the ECS-cluster ghosts), so verify against the actual API: a
 * DescribeUserPool that reports the pool does not exist is a ghost, not an
 * orphan.
 */
function isCognitoUserPoolGhost(arn) {
  if (!arn?.startsWith('arn:aws:cognito-idp:') || !arn.includes(':userpool/')) return false;
  const poolId = arn.split(':userpool/')[1];
  if (mock) return true; // mock sweep: canned clean state, treat as verified-gone
  try {
    const found = awsCli(['cognito-idp', 'describe-user-pool', '--user-pool-id', poolId], {
      profile,
      region,
    });
    // Pool still describes → NOT a ghost (a genuine orphan).
    return found?.UserPool === undefined;
  } catch (err) {
    // execFileSync throws on the CLI's non-zero exit; ResourceNotFoundException
    // means the pool is genuinely deleted (a tagging-index ghost).
    return /ResourceNotFoundException|does not exist/i.test(
      String(err?.stderr ?? err?.message ?? err),
    );
  }
}

function isKmsPendingDeletion(arn) {
  if (!arn?.startsWith('arn:aws:kms:')) return false;
  const found = awsCli(['kms', 'describe-key', '--key-id', arn], {
    mock,
    mockResult: { KeyMetadata: { KeyState: 'PendingDeletion' } },
    profile,
    region,
  });
  const state = found?.KeyMetadata?.KeyState;
  return state === 'PendingDeletion' || state === 'PendingReplicaDeletion';
}

report.step(`IAM name-prefix sweep finds no ${prefix}* roles`, () => {
  const result = awsCli(['iam', 'list-roles', '--max-items', '1000'], {
    mock,
    mockResult: { Roles: [] },
    profile,
    region,
  });
  const orphans = (result?.Roles ?? []).filter((r) => r.RoleName?.startsWith(prefix));
  if (orphans.length > 0) {
    throw new Error(
      `${orphans.length} orphan role(s): ${orphans.map((r) => r.RoleName).join(', ')}`,
    );
  }
  return 'zero orphan roles';
});

report.finish();
