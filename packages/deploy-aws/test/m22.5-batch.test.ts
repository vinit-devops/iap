/**
 * M22.5 AWS Batch handlers, mock-tested: compute environment + job queue +
 * job definition. NO job is ever submitted — the trio is $0 with zero jobs.
 *
 * Covers: CE create fail-closed without live-driver networking (subnets /
 * securityGroups attributes), CE disable-SETTLE-delete ORDER (the delete only
 * follows a settled disable — M22.5 live finding: "Cannot delete, resource is
 * being modified."), maxVcpus drift →
 * UpdateComputeEnvironment in place; JQ create requiring the sibling
 * computeEnvironment name plus dependsOn ordering CE→JQ on create and JQ→CE
 * on destroy; JD register with a REQUIRED executionRoleArn (sibling
 * aws:iam:Role), drift → a NEW revision (no deregister), and destroy sweeping
 * every ACTIVE revision.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BatchClient,
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
import { AwsExecutor } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const batch = mockClient(BatchClient);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

const CE_ARN = 'arn:aws:batch:eu-central-1:000000000000:compute-environment/infraasprompt-ce';
const JQ_ARN = 'arn:aws:batch:eu-central-1:000000000000:job-queue/infraasprompt-queue';
const JD_ARN_PREFIX = 'arn:aws:batch:eu-central-1:000000000000:job-definition/infraasprompt-jd';
const ROLE_ARN = 'arn:aws:iam::000000000000:role/infraasprompt-jd-exec';
const MANAGED = { 'iap:managed': 'true' };

const NETWORKING = {
  subnets: 'subnet-aaa1,subnet-bbb2',
  securityGroups: 'sg-ccc3',
} as const;

/** A live Fargate CE matching the given maxvCpus (state/status overridable). */
function liveCe(
  maxvCpus: number,
  state: 'ENABLED' | 'DISABLED' = 'ENABLED',
  status: 'VALID' | 'UPDATING' = 'VALID',
) {
  return {
    computeEnvironments: [
      {
        computeEnvironmentName: 'infraasprompt-ce',
        computeEnvironmentArn: CE_ARN,
        type: 'MANAGED' as const,
        state,
        status,
        computeResources: {
          type: 'FARGATE' as const,
          maxvCpus,
          subnets: ['subnet-aaa1', 'subnet-bbb2'],
          securityGroupIds: ['sg-ccc3'],
        },
        tags: MANAGED,
      },
    ],
  };
}

/** An ACTIVE job-definition revision converged with the handler defaults. */
function jdRevision(revision: number, image = 'public.ecr.aws/docker/library/busybox:latest') {
  return {
    jobDefinitionName: 'infraasprompt-jd',
    jobDefinitionArn: `${JD_ARN_PREFIX}:${revision}`,
    revision,
    status: 'ACTIVE',
    type: 'container',
    containerProperties: {
      image,
      command: ['true'],
      executionRoleArn: ROLE_ARN,
      resourceRequirements: [
        { type: 'VCPU' as const, value: '0.25' },
        { type: 'MEMORY' as const, value: '512' },
      ],
    },
    tags: MANAGED,
  };
}

beforeEach(() => {
  batch.reset();
});

describe('aws:batch:ComputeEnvironment', () => {
  it('create fails closed without the live-driver subnets attribute (no CreateComputeEnvironment)', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-ce', 'aws:batch:ComputeEnvironment', {
        securityGroups: 'sg-ccc3',
      }),
    ]);
    batch.on(DescribeComputeEnvironmentsCommand).resolves({ computeEnvironments: [] });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('subnets');
    expect(report.errors).toHaveLength(1);
    expect(batch.commandCalls(CreateComputeEnvironmentCommand)).toHaveLength(0);
  });

  it('absent → CreateComputeEnvironment: MANAGED Fargate over split subnets/SGs + tags', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-ce', 'aws:batch:ComputeEnvironment', {
        ...NETWORKING,
        maxVcpus: 2,
      }),
    ]);
    batch.on(DescribeComputeEnvironmentsCommand).resolves({ computeEnvironments: [] });
    batch.on(CreateComputeEnvironmentCommand).resolves({ computeEnvironmentArn: CE_ARN });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(CE_ARN);
    const input = batch.commandCalls(CreateComputeEnvironmentCommand)[0]?.args[0].input;
    expect(input?.computeEnvironmentName).toBe('infraasprompt-ce');
    expect(input?.type).toBe('MANAGED');
    expect(input?.state).toBe('ENABLED');
    expect(input?.computeResources?.type).toBe('FARGATE');
    expect(input?.computeResources?.maxvCpus).toBe(2);
    expect(input?.computeResources?.subnets).toEqual(['subnet-aaa1', 'subnet-bbb2']);
    expect(input?.computeResources?.securityGroupIds).toEqual(['sg-ccc3']);
    expect(input?.tags?.['iap:managed']).toBe('true');
    expect(input?.tags?.['iap:resourceId']).toBe('infraasprompt-ce.aws:batch:ComputeEnvironment');
  });

  it('maxVcpus drift → UpdateComputeEnvironment in place (never delete+create)', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-ce', 'aws:batch:ComputeEnvironment', {
        ...NETWORKING,
        maxVcpus: 4,
      }),
    ]);
    batch.on(DescribeComputeEnvironmentsCommand).resolves(liveCe(1));
    batch.on(UpdateComputeEnvironmentCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = batch.commandCalls(UpdateComputeEnvironmentCommand)[0]?.args[0].input;
    expect(input?.computeEnvironment).toBe('infraasprompt-ce');
    expect(input?.computeResources?.maxvCpus).toBe(4);
    expect(batch.commandCalls(DeleteComputeEnvironmentCommand)).toHaveLength(0);
    expect(batch.commandCalls(CreateComputeEnvironmentCommand)).toHaveLength(0);
  });

  it('destroy → UpdateComputeEnvironment DISABLED strictly BEFORE DeleteComputeEnvironment', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-ce', 'aws:batch:ComputeEnvironment', NETWORKING),
    ]);
    // Classify read sees the ENABLED CE; the settle poll then sees it DISABLED.
    batch
      .on(DescribeComputeEnvironmentsCommand)
      .resolvesOnce(liveCe(1))
      .resolves(liveCe(1, 'DISABLED'));
    batch.on(UpdateComputeEnvironmentCommand).resolves({});
    batch.on(DeleteComputeEnvironmentCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    const disable = batch.commandCalls(UpdateComputeEnvironmentCommand)[0]?.args[0].input;
    expect(disable?.computeEnvironment).toBe('infraasprompt-ce');
    expect(disable?.state).toBe('DISABLED');
    const calls = batch.calls().map((c) => c.args[0].constructor.name);
    expect(calls.indexOf('UpdateComputeEnvironmentCommand')).toBeLessThan(
      calls.indexOf('DeleteComputeEnvironmentCommand'),
    );
  });

  it('delete WAITS for the disable to settle before DeleteComputeEnvironment (M22.5 live: "Cannot delete, resource is being modified.")', async () => {
    // Live finding (run infraasprompt-1784289039): UpdateComputeEnvironment
    // State=DISABLED holds the CE in status UPDATING and Batch rejects an
    // immediate delete with "Cannot delete, resource is being modified." —
    // the handler must poll the disable to settled before deleting.
    const plan = providerPlan([
      planResource('infraasprompt-ce', 'aws:batch:ComputeEnvironment', NETWORKING),
    ]);
    batch
      .on(DescribeComputeEnvironmentsCommand)
      .resolvesOnce(liveCe(1)) // classify read: ENABLED / VALID
      .resolvesOnce(liveCe(1, 'DISABLED', 'UPDATING')) // settle poll 1: still modifying
      .resolves(liveCe(1, 'DISABLED', 'VALID')); // settle poll 2: settled
    batch.on(UpdateComputeEnvironmentCommand).resolves({});
    batch.on(DeleteComputeEnvironmentCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    // The delete waited out the UPDATING poll: 3 describes, delete strictly last.
    expect(batch.commandCalls(DescribeComputeEnvironmentsCommand)).toHaveLength(3);
    expect(batch.commandCalls(DeleteComputeEnvironmentCommand)).toHaveLength(1);
    const calls = batch.calls().map((c) => c.args[0].constructor.name);
    expect(calls[calls.length - 1]).toBe('DeleteComputeEnvironmentCommand');
  }, 15_000);

  it('delete skips DeleteComputeEnvironment when the CE is already DELETING mid-settle', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-ce', 'aws:batch:ComputeEnvironment', NETWORKING),
    ]);
    batch
      .on(DescribeComputeEnvironmentsCommand)
      .resolvesOnce(liveCe(1)) // classify read
      .resolves({
        computeEnvironments: [
          {
            computeEnvironmentName: 'infraasprompt-ce',
            computeEnvironmentArn: CE_ARN,
            status: 'DELETING',
            tags: MANAGED,
          },
        ],
      });
    batch.on(UpdateComputeEnvironmentCommand).resolves({});
    batch.on(DeleteComputeEnvironmentCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.errors).toEqual([]);
    expect(batch.commandCalls(DeleteComputeEnvironmentCommand)).toHaveLength(0);
  });

  it('status DELETING reads as absent; a disable failure blocks the delete (fail closed)', async () => {
    const deletingPlan = providerPlan([
      planResource('infraasprompt-ce', 'aws:batch:ComputeEnvironment', NETWORKING),
    ]);
    batch.on(DescribeComputeEnvironmentsCommand).resolves({
      computeEnvironments: [
        {
          computeEnvironmentName: 'infraasprompt-ce',
          computeEnvironmentArn: CE_ARN,
          status: 'DELETING',
          tags: MANAGED,
        },
      ],
    });
    const planned = await executor().plan(deletingPlan);
    expect(planned.items[0]?.action).toBe('create'); // absent → converge would recreate

    // Disable rejected → DeleteComputeEnvironment must never be attempted.
    batch.reset();
    batch.on(DescribeComputeEnvironmentsCommand).resolves(liveCe(1));
    batch.on(UpdateComputeEnvironmentCommand).rejects(new Error('ClientException: cannot disable'));
    batch.on(DeleteComputeEnvironmentCommand).resolves({});

    const report = await executor().apply(deletingPlan, { apply: true, destroy: true });
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('cannot disable');
    expect(batch.commandCalls(DeleteComputeEnvironmentCommand)).toHaveLength(0);
  });
});

describe('aws:batch:JobQueue', () => {
  it('create fails closed without the computeEnvironment attribute (sibling CE name)', async () => {
    const plan = providerPlan([planResource('infraasprompt-queue', 'aws:batch:JobQueue')]);
    batch.on(DescribeJobQueuesCommand).resolves({ jobQueues: [] });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('computeEnvironment');
    expect(batch.commandCalls(CreateJobQueueCommand)).toHaveLength(0);
  });

  it('dependsOn honoured: CE created BEFORE the JQ that names it; destroy reverses (JQ first)', async () => {
    // 'a-queue' sorts alphabetically BEFORE 'z-env' — only dependsOn orders it.
    const ce = planResource('z-env', 'aws:batch:ComputeEnvironment', NETWORKING);
    const jq = planResource('a-queue', 'aws:batch:JobQueue', {
      computeEnvironment: 'z-env',
      priority: 5,
    });
    jq.dependsOn = [ce.logicalId];
    const plan = providerPlan([jq, ce]);

    batch.on(DescribeComputeEnvironmentsCommand).resolves({ computeEnvironments: [] });
    batch.on(DescribeJobQueuesCommand).resolves({ jobQueues: [] });
    batch.on(CreateComputeEnvironmentCommand).resolves({ computeEnvironmentArn: CE_ARN });
    batch.on(CreateJobQueueCommand).resolves({ jobQueueArn: JQ_ARN });

    const created = await executor().apply(plan, { apply: true });
    expect(created.errors).toEqual([]);
    expect(created.items.map((i) => i.logicalId)).toEqual([ce.logicalId, jq.logicalId]);
    const createCalls = batch.calls().map((c) => c.args[0].constructor.name);
    expect(createCalls.indexOf('CreateComputeEnvironmentCommand')).toBeLessThan(
      createCalls.indexOf('CreateJobQueueCommand'),
    );
    const jqInput = batch.commandCalls(CreateJobQueueCommand)[0]?.args[0].input;
    expect(jqInput?.jobQueueName).toBe('a-queue');
    expect(jqInput?.priority).toBe(5);
    expect(jqInput?.state).toBe('ENABLED');
    expect(jqInput?.computeEnvironmentOrder).toEqual([{ order: 1, computeEnvironment: 'z-env' }]);
    expect(jqInput?.tags?.['iap:managed']).toBe('true');

    // DESTROY: reversed topology — the JQ must go BEFORE the CE it references.
    batch.reset();
    const zEnv = (state: 'ENABLED' | 'DISABLED') => ({
      computeEnvironments: [
        {
          computeEnvironmentName: 'z-env',
          computeEnvironmentArn: CE_ARN,
          type: 'MANAGED' as const,
          state,
          status: 'VALID' as const,
          computeResources: {
            type: 'FARGATE' as const,
            maxvCpus: 1,
            subnets: [],
            securityGroupIds: [],
          },
          tags: MANAGED,
        },
      ],
    });
    const aQueue = (state: 'ENABLED' | 'DISABLED') => ({
      jobQueues: [
        {
          jobQueueName: 'a-queue',
          jobQueueArn: JQ_ARN,
          state,
          status: 'VALID' as const,
          priority: 5,
          computeEnvironmentOrder: [{ order: 1, computeEnvironment: CE_ARN }],
          tags: MANAGED,
        },
      ],
    });
    // First describe per resource is the classify read (ENABLED); the
    // disable-settle poll then reads DISABLED (M22.5 live finding).
    batch
      .on(DescribeComputeEnvironmentsCommand)
      .resolvesOnce(zEnv('ENABLED'))
      .resolves(zEnv('DISABLED'));
    batch.on(DescribeJobQueuesCommand).resolvesOnce(aQueue('ENABLED')).resolves(aQueue('DISABLED'));
    batch.on(UpdateJobQueueCommand).resolves({});
    batch.on(DeleteJobQueueCommand).resolves({});
    batch.on(UpdateComputeEnvironmentCommand).resolves({});
    batch.on(DeleteComputeEnvironmentCommand).resolves({});

    const destroyed = await executor().apply(plan, { apply: true, destroy: true });
    expect(destroyed.errors).toEqual([]);
    expect(destroyed.items.map((i) => i.logicalId)).toEqual([jq.logicalId, ce.logicalId]);
    const destroyCalls = batch.calls().map((c) => c.args[0].constructor.name);
    expect(destroyCalls.indexOf('DeleteJobQueueCommand')).toBeLessThan(
      destroyCalls.indexOf('DeleteComputeEnvironmentCommand'),
    );
    // Both teardowns are disable-then-delete.
    const jqDisable = batch.commandCalls(UpdateJobQueueCommand)[0]?.args[0].input;
    expect(jqDisable?.state).toBe('DISABLED');
    expect(destroyCalls.indexOf('UpdateJobQueueCommand')).toBeLessThan(
      destroyCalls.indexOf('DeleteJobQueueCommand'),
    );
  });

  it('priority drift → UpdateJobQueue in place (live CE ARN normalizes to its name)', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-queue', 'aws:batch:JobQueue', {
        computeEnvironment: 'infraasprompt-ce',
        priority: 10,
      }),
    ]);
    batch.on(DescribeJobQueuesCommand).resolves({
      jobQueues: [
        {
          jobQueueName: 'infraasprompt-queue',
          jobQueueArn: JQ_ARN,
          state: 'ENABLED',
          status: 'VALID',
          priority: 1,
          // Live responses carry the CE ARN — the handler compares by NAME.
          computeEnvironmentOrder: [{ order: 1, computeEnvironment: CE_ARN }],
          tags: MANAGED,
        },
      ],
    });
    batch.on(UpdateJobQueueCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    const input = batch.commandCalls(UpdateJobQueueCommand)[0]?.args[0].input;
    expect(input?.jobQueue).toBe('infraasprompt-queue');
    expect(input?.priority).toBe(10);
    expect(batch.commandCalls(CreateJobQueueCommand)).toHaveLength(0);
    expect(batch.commandCalls(DeleteJobQueueCommand)).toHaveLength(0);
  });

  it('delete WAITS for the JQ disable to settle before DeleteJobQueue (M22.5 live finding)', async () => {
    // Same live rejection as the CE: DeleteJobQueue immediately after
    // UpdateJobQueue State=DISABLED → "Cannot delete, resource is being
    // modified." (run infraasprompt-1784289039, test 8).
    const jqState = (state: 'ENABLED' | 'DISABLED', status: 'VALID' | 'UPDATING') => ({
      jobQueues: [
        {
          jobQueueName: 'infraasprompt-queue',
          jobQueueArn: JQ_ARN,
          state,
          status,
          priority: 1,
          computeEnvironmentOrder: [{ order: 1, computeEnvironment: CE_ARN }],
          tags: MANAGED,
        },
      ],
    });
    const plan = providerPlan([
      planResource('infraasprompt-queue', 'aws:batch:JobQueue', {
        computeEnvironment: 'infraasprompt-ce',
      }),
    ]);
    batch
      .on(DescribeJobQueuesCommand)
      .resolvesOnce(jqState('ENABLED', 'VALID')) // classify read
      .resolvesOnce(jqState('DISABLED', 'UPDATING')) // settle poll 1: still modifying
      .resolves(jqState('DISABLED', 'VALID')); // settle poll 2: settled
    batch.on(UpdateJobQueueCommand).resolves({});
    batch.on(DeleteJobQueueCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.errors).toEqual([]);
    expect(report.items[0]?.applied).toBe(true);
    expect(batch.commandCalls(DescribeJobQueuesCommand)).toHaveLength(3);
    const calls = batch.calls().map((c) => c.args[0].constructor.name);
    expect(calls[calls.length - 1]).toBe('DeleteJobQueueCommand');
  }, 15_000);
});

describe('aws:batch:JobDefinition', () => {
  it('create fails closed without executionRoleArn (the sibling aws:iam:Role)', async () => {
    const plan = providerPlan([planResource('infraasprompt-jd', 'aws:batch:JobDefinition')]);
    batch.on(DescribeJobDefinitionsCommand).resolves({ jobDefinitions: [] });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('executionRoleArn');
    expect(batch.commandCalls(RegisterJobDefinitionCommand)).toHaveLength(0);
  });

  it('absent → RegisterJobDefinition: Fargate container, busybox true, role, tags', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-jd', 'aws:batch:JobDefinition', { executionRoleArn: ROLE_ARN }),
    ]);
    batch.on(DescribeJobDefinitionsCommand).resolves({ jobDefinitions: [] });
    batch.on(RegisterJobDefinitionCommand).resolves({
      jobDefinitionName: 'infraasprompt-jd',
      jobDefinitionArn: `${JD_ARN_PREFIX}:1`,
      revision: 1,
    });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(`${JD_ARN_PREFIX}:1`);
    const input = batch.commandCalls(RegisterJobDefinitionCommand)[0]?.args[0].input;
    expect(input?.jobDefinitionName).toBe('infraasprompt-jd');
    expect(input?.type).toBe('container');
    expect(input?.platformCapabilities).toEqual(['FARGATE']);
    expect(input?.containerProperties?.image).toBe('public.ecr.aws/docker/library/busybox:latest');
    expect(input?.containerProperties?.command).toEqual(['true']);
    expect(input?.containerProperties?.executionRoleArn).toBe(ROLE_ARN);
    expect(input?.containerProperties?.resourceRequirements).toEqual([
      { type: 'VCPU', value: '0.25' },
      { type: 'MEMORY', value: '512' },
    ]);
    expect(input?.containerProperties?.networkConfiguration?.assignPublicIp).toBe('ENABLED');
    expect(input?.tags?.['iap:managed']).toBe('true');
  });

  it('image drift → a NEW revision via RegisterJobDefinition — never a deregister', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-jd', 'aws:batch:JobDefinition', {
        executionRoleArn: ROLE_ARN,
        image: 'public.ecr.aws/docker/library/alpine:latest',
      }),
    ]);
    batch.on(DescribeJobDefinitionsCommand).resolves({ jobDefinitions: [jdRevision(1)] });
    batch.on(RegisterJobDefinitionCommand).resolves({
      jobDefinitionName: 'infraasprompt-jd',
      jobDefinitionArn: `${JD_ARN_PREFIX}:2`,
      revision: 2,
    });

    const report = await executor().apply(plan, { apply: true });

    // In-place for a versioned resource = a new revision (replacement N/A).
    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = batch.commandCalls(RegisterJobDefinitionCommand)[0]?.args[0].input;
    expect(input?.containerProperties?.image).toBe('public.ecr.aws/docker/library/alpine:latest');
    expect(input?.tags?.['iap:managed']).toBe('true'); // managed tag carried onto the revision
    expect(batch.commandCalls(DeregisterJobDefinitionCommand)).toHaveLength(0);
  });

  it('destroy deregisters EVERY ACTIVE revision (paginated sweep, zero orphans)', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-jd', 'aws:batch:JobDefinition', { executionRoleArn: ROLE_ARN }),
    ]);
    // Two pages of ACTIVE revisions — resolution must paginate, then sweep all.
    batch
      .on(DescribeJobDefinitionsCommand)
      .resolvesOnce({ nextToken: 'page-2', jobDefinitions: [jdRevision(1)] })
      .resolvesOnce({ jobDefinitions: [jdRevision(2)] })
      .resolvesOnce({ nextToken: 'page-2', jobDefinitions: [jdRevision(1)] })
      .resolves({ jobDefinitions: [jdRevision(2)] });
    batch.on(DeregisterJobDefinitionCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);
    const deregistered = batch
      .commandCalls(DeregisterJobDefinitionCommand)
      .map((c) => c.args[0].input?.jobDefinition);
    expect(deregistered).toHaveLength(2);
    expect(deregistered).toContain(`${JD_ARN_PREFIX}:1`);
    expect(deregistered).toContain(`${JD_ARN_PREFIX}:2`);
  });
});
