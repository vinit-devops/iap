/**
 * `iap destroy` — tear down the resources a document declares (Phase 19,
 * M19.3). Identical shape and live gate to `iap deploy` (`--confirm` required
 * to mutate), but classifies existing resources for deletion. The executor's
 * managed-only guard is authoritative: any resource NOT tagged
 * `iap:managed=true` is refused, surfaces as a per-resource failure, and forces
 * a nonzero exit — the CLI never overrides that guard.
 */

import type { CliIO, ParsedArgs } from '../shared.js';
import { runDeployment } from './deploy.js';

export function destroyCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  return runDeployment(args, io, true);
}
