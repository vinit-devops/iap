/**
 * M23.4 Step Functions handler, mock-tested: `aws:states:StateMachine`.
 *
 * Covers: create with EXPRESS + roleArn + the default ASL Pass definition +
 * mandatory tags; the fail-closed refusal when roleArn is missing (recorded
 * error, zero CreateStateMachine); name→ARN resolution via paginated
 * ListStateMachines (match on page 2); a converged no-op where the live
 * definition differs only in whitespace/key-order (canonical-JSON compare, NOT
 * drift); definition drift → UpdateStateMachine in place (no replace); roleArn
 * drift → UpdateStateMachine in place; type EXPRESS→STANDARD drift classifying
 * as `replace` (immutable projection key); and destroy — the managed-only
 * refusal plus DeleteStateMachine by the resolved ARN.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateStateMachineCommand,
  DeleteStateMachineCommand,
  DescribeStateMachineCommand,
  ListStateMachinesCommand,
  ListTagsForResourceCommand,
  SFNClient,
  TagResourceCommand,
  UpdateStateMachineCommand,
} from '@aws-sdk/client-sfn';
import { AwsExecutor } from '../src/index.js';
import { StateMachineHandler } from '../src/state-machine.js';
import type { TargetHandler } from '../src/types.js';
import { planResource, providerPlan } from './helpers.js';

const sfn = mockClient(SFNClient);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

const SM_ARN = 'arn:aws:states:eu-central-1:000000000000:stateMachine:infraasprompt-flow';
const ROLE_ARN = 'arn:aws:iam::000000000000:role/infraasprompt-flow';
const OTHER_ROLE_ARN = 'arn:aws:iam::000000000000:role/infraasprompt-flow-v2';
/** Handler's canonical (compact, key-sorted) default ASL definition. */
const CANON_DEFAULT =
  '{"Comment":"iap","StartAt":"Done","States":{"Done":{"End":true,"Type":"Pass"}}}';
const MANAGED_TAGS = [{ key: 'iap:managed', value: 'true' }];

/** A live state machine (handler defaults) in ACTIVE status by default. */
function machine(overrides: Record<string, unknown> = {}) {
  return {
    stateMachineArn: SM_ARN,
    name: 'infraasprompt-flow',
    status: 'ACTIVE',
    type: 'EXPRESS',
    roleArn: ROLE_ARN,
    // AWS returns the definition it stored — here pretty-printed with reordered
    // keys, to prove canonical-JSON comparison treats it as converged.
    definition: '{\n  "StartAt": "Done",\n  "Comment": "iap",\n  "States": {\n    "Done": { "Type": "Pass", "End": true }\n  }\n}',
    ...overrides,
  };
}

beforeEach(() => {
  sfn.reset();
});

describe('aws:states:StateMachine', () => {
  it('absent → CreateStateMachine EXPRESS with roleArn, default ASL, and mandatory tags', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-flow', 'aws:states:StateMachine', { roleArn: ROLE_ARN }),
    ]);
    sfn.on(ListStateMachinesCommand).resolves({ stateMachines: [] });
    sfn.on(CreateStateMachineCommand).resolves({ stateMachineArn: SM_ARN, creationDate: undefined });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(SM_ARN);
    const input = sfn.commandCalls(CreateStateMachineCommand)[0]?.args[0].input;
    expect(input?.name).toBe('infraasprompt-flow');
    expect(input?.type).toBe('EXPRESS');
    expect(input?.roleArn).toBe(ROLE_ARN);
    expect(input?.definition).toBe(CANON_DEFAULT);
    const tags = Object.fromEntries((input?.tags ?? []).map((t) => [t.key, t.value]));
    expect(tags['iap:managed']).toBe('true');
    expect(tags['iap:planId']).toBe('plan-hash-0001');
    expect(tags['iap:resourceId']).toBe('infraasprompt-flow.aws:states:StateMachine');
  });

  it('fail-closed: missing roleArn is a recorded error with zero CreateStateMachine calls', async () => {
    const plan = providerPlan([planResource('infraasprompt-flow', 'aws:states:StateMachine')]);
    sfn.on(ListStateMachinesCommand).resolves({ stateMachines: [] });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('roleArn');
    expect(report.errors).toHaveLength(1);
    expect(sfn.commandCalls(CreateStateMachineCommand)).toHaveLength(0);
  });

  it('resolves the state machine ARN by name across ListStateMachines pages (match on page 2)', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-flow', 'aws:states:StateMachine', { roleArn: ROLE_ARN }),
    ]);
    sfn
      .on(ListStateMachinesCommand)
      .resolvesOnce({
        nextToken: 'page-2',
        stateMachines: [
          { stateMachineArn: 'arn:other', name: 'other-flow', type: 'EXPRESS', creationDate: undefined },
        ],
      })
      .resolves({
        stateMachines: [
          { stateMachineArn: SM_ARN, name: 'infraasprompt-flow', type: 'EXPRESS', creationDate: undefined },
        ],
      });
    sfn.on(DescribeStateMachineCommand).resolves(machine());
    sfn.on(ListTagsForResourceCommand).resolves({ tags: MANAGED_TAGS });

    const report = await executor().plan(plan);

    expect(report.items[0]?.action).toBe('no-op');
    const listCalls = sfn.commandCalls(ListStateMachinesCommand);
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]?.args[0].input?.nextToken).toBe('page-2');
    // Every op after resolution is ARN-driven.
    expect(sfn.commandCalls(DescribeStateMachineCommand)[0]?.args[0].input?.stateMachineArn).toBe(
      SM_ARN,
    );
    expect(sfn.commandCalls(ListTagsForResourceCommand)[0]?.args[0].input?.resourceArn).toBe(SM_ARN);
  });

  it('converged: a whitespace/key-order-different definition is NOT drift (canonical compare)', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-flow', 'aws:states:StateMachine', { roleArn: ROLE_ARN }),
    ]);
    sfn.on(ListStateMachinesCommand).resolves({
      stateMachines: [
        { stateMachineArn: SM_ARN, name: 'infraasprompt-flow', type: 'EXPRESS', creationDate: undefined },
      ],
    });
    // Live definition is pretty-printed with reordered keys — canonically equal.
    sfn.on(DescribeStateMachineCommand).resolves(machine());
    sfn.on(ListTagsForResourceCommand).resolves({ tags: MANAGED_TAGS });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('no-op');
    expect(sfn.commandCalls(UpdateStateMachineCommand)).toHaveLength(0);
    expect(sfn.commandCalls(CreateStateMachineCommand)).toHaveLength(0);
  });

  it('definition drift → UpdateStateMachine in place by the resolved ARN (no replace)', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-flow', 'aws:states:StateMachine', {
        roleArn: ROLE_ARN,
        definition: '{"Comment":"changed","StartAt":"Done","States":{"Done":{"Type":"Pass","End":true}}}',
      }),
    ]);
    sfn.on(ListStateMachinesCommand).resolves({
      stateMachines: [
        { stateMachineArn: SM_ARN, name: 'infraasprompt-flow', type: 'EXPRESS', creationDate: undefined },
      ],
    });
    sfn.on(DescribeStateMachineCommand).resolves(machine());
    sfn.on(ListTagsForResourceCommand).resolves({ tags: MANAGED_TAGS });
    sfn.on(UpdateStateMachineCommand).resolves({ updateDate: undefined });
    sfn.on(TagResourceCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = sfn.commandCalls(UpdateStateMachineCommand)[0]?.args[0].input;
    expect(input?.stateMachineArn).toBe(SM_ARN);
    expect(input?.definition).toBe(
      '{"Comment":"changed","StartAt":"Done","States":{"Done":{"End":true,"Type":"Pass"}}}',
    );
    expect(input?.roleArn).toBe(ROLE_ARN);
    // In-place only: definition drift never cascades into delete+create.
    expect(sfn.commandCalls(DeleteStateMachineCommand)).toHaveLength(0);
    expect(sfn.commandCalls(CreateStateMachineCommand)).toHaveLength(0);
  });

  it('roleArn drift → UpdateStateMachine in place with the new role', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-flow', 'aws:states:StateMachine', { roleArn: OTHER_ROLE_ARN }),
    ]);
    sfn.on(ListStateMachinesCommand).resolves({
      stateMachines: [
        { stateMachineArn: SM_ARN, name: 'infraasprompt-flow', type: 'EXPRESS', creationDate: undefined },
      ],
    });
    sfn.on(DescribeStateMachineCommand).resolves(machine());
    sfn.on(ListTagsForResourceCommand).resolves({ tags: MANAGED_TAGS });
    sfn.on(UpdateStateMachineCommand).resolves({ updateDate: undefined });
    sfn.on(TagResourceCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = sfn.commandCalls(UpdateStateMachineCommand)[0]?.args[0].input;
    expect(input?.stateMachineArn).toBe(SM_ARN);
    expect(input?.roleArn).toBe(OTHER_ROLE_ARN);
    expect(sfn.commandCalls(DeleteStateMachineCommand)).toHaveLength(0);
  });

  it('type EXPRESS→STANDARD drift classifies as replace (immutable projection key)', async () => {
    const handler: TargetHandler = new StateMachineHandler(new SFNClient({ region: 'eu-central-1' }));
    // ADR-0006: type cannot change in place, so it is the sole immutable key.
    expect(handler.immutableProjectionKeys).toEqual(['type']);

    const plan = providerPlan([
      planResource('infraasprompt-flow', 'aws:states:StateMachine', { roleArn: ROLE_ARN, type: 'STANDARD' }),
    ]);
    sfn.on(ListStateMachinesCommand).resolves({
      stateMachines: [
        { stateMachineArn: SM_ARN, name: 'infraasprompt-flow', type: 'EXPRESS', creationDate: undefined },
      ],
    });
    sfn.on(DescribeStateMachineCommand).resolves(machine()); // live type EXPRESS
    sfn.on(ListTagsForResourceCommand).resolves({ tags: MANAGED_TAGS });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('replace'); // never 'update'
  });

  it('destroy → DeleteStateMachine by resolved ARN; unmanaged machine is refused', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-flow', 'aws:states:StateMachine', { roleArn: ROLE_ARN }),
    ]);
    sfn.on(ListStateMachinesCommand).resolves({
      stateMachines: [
        { stateMachineArn: SM_ARN, name: 'infraasprompt-flow', type: 'EXPRESS', creationDate: undefined },
      ],
    });
    sfn.on(DescribeStateMachineCommand).resolves(machine());
    sfn.on(ListTagsForResourceCommand).resolves({ tags: MANAGED_TAGS });
    sfn.on(DeleteStateMachineCommand).resolves({});

    const managed = await executor().apply(plan, { apply: true, destroy: true });
    expect(managed.items[0]?.action).toBe('delete');
    expect(managed.items[0]?.applied).toBe(true);
    expect(sfn.commandCalls(DeleteStateMachineCommand)[0]?.args[0].input?.stateMachineArn).toBe(
      SM_ARN,
    );

    // Same machine WITHOUT iap:managed=true → managed-only gate refuses.
    sfn.reset();
    sfn.on(ListStateMachinesCommand).resolves({
      stateMachines: [
        { stateMachineArn: SM_ARN, name: 'infraasprompt-flow', type: 'EXPRESS', creationDate: undefined },
      ],
    });
    sfn.on(DescribeStateMachineCommand).resolves(machine());
    sfn.on(ListTagsForResourceCommand).resolves({ tags: [] });

    const unmanaged = await executor().apply(plan, { apply: true, destroy: true });
    expect(unmanaged.items[0]?.applied).toBe(false);
    expect(unmanaged.items[0]?.error).toContain('managed-only destroy');
    expect(sfn.commandCalls(DeleteStateMachineCommand)).toHaveLength(0);
  });

  it('DELETING reads as absent even while the name lingers in ListStateMachines', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-flow', 'aws:states:StateMachine', { roleArn: ROLE_ARN }),
    ]);
    sfn.on(ListStateMachinesCommand).resolves({
      stateMachines: [
        { stateMachineArn: SM_ARN, name: 'infraasprompt-flow', type: 'EXPRESS', creationDate: undefined },
      ],
    });
    sfn.on(DescribeStateMachineCommand).resolves(machine({ status: 'DELETING' }));

    const report = await executor().plan(plan);

    expect(report.items[0]?.action).toBe('create');
    expect(sfn.commandCalls(ListTagsForResourceCommand)).toHaveLength(0);
  });
});
