/**
 * M22.5 App Runner handler, mock-tested: `aws:apprunner:Service`.
 *
 * Covers: name→ARN resolution via paginated ListServices (match on page 2),
 * create with the public hello image + mandatory tags, cpu drift →
 * UpdateService in place, an OPERATION_IN_PROGRESS update rejection surfacing
 * honestly as a recorded error, destroy by resolved ARN plus the managed-only
 * refusal, and the replacement-N/A shape (no immutable projection keys — any
 * drift classifies as update, never replace).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AppRunnerClient,
  CreateServiceCommand,
  DeleteServiceCommand,
  DescribeServiceCommand,
  ListServicesCommand,
  ListTagsForResourceCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-apprunner';
import { AwsExecutor } from '../src/index.js';
import { AppRunnerServiceHandler } from '../src/apprunner.js';
import type { TargetHandler } from '../src/types.js';
import { planResource, providerPlan, serviceError } from './helpers.js';

const apprunner = mockClient(AppRunnerClient);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

const SERVICE_ARN =
  'arn:aws:apprunner:eu-central-1:000000000000:service/infraasprompt-svc/8fe1e10304f84fd2b0df550fe98a71fa';
const HELLO_IMAGE = 'public.ecr.aws/aws-containers/hello-app-runner:latest';
const MANAGED_TAGS = [{ Key: 'iap:managed', Value: 'true' }];

/** A converged service (handler defaults) in the given lifecycle status. */
function runningService(status: 'RUNNING' | 'OPERATION_IN_PROGRESS' | 'DELETED' = 'RUNNING') {
  return {
    Service: {
      ServiceName: 'infraasprompt-svc',
      ServiceId: '8fe1e10304f84fd2b0df550fe98a71fa',
      ServiceArn: SERVICE_ARN,
      CreatedAt: undefined,
      UpdatedAt: undefined,
      AutoScalingConfigurationSummary: undefined,
      NetworkConfiguration: undefined,
      Status: status,
      SourceConfiguration: {
        ImageRepository: {
          ImageIdentifier: HELLO_IMAGE,
          ImageRepositoryType: 'ECR_PUBLIC' as const,
          ImageConfiguration: { Port: '8000' },
        },
        AutoDeploymentsEnabled: false,
      },
      InstanceConfiguration: { Cpu: '256', Memory: '512' },
    },
  };
}

beforeEach(() => {
  apprunner.reset();
});

describe('aws:apprunner:Service', () => {
  const svcPlan = providerPlan([planResource('infraasprompt-svc', 'aws:apprunner:Service')]);

  it('resolves the service ARN by name across ListServices pages (match on page 2)', async () => {
    apprunner
      .on(ListServicesCommand)
      .resolvesOnce({
        NextToken: 'page-2',
        ServiceSummaryList: [{ ServiceName: 'other-svc', ServiceArn: 'arn:other', Status: 'RUNNING' }],
      })
      .resolves({
        ServiceSummaryList: [{ ServiceName: 'infraasprompt-svc', ServiceArn: SERVICE_ARN, Status: 'RUNNING' }],
      });
    apprunner.on(DescribeServiceCommand).resolves(runningService());
    apprunner.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });

    const report = await executor().plan(svcPlan);

    expect(report.items[0]?.action).toBe('no-op');
    const listCalls = apprunner.commandCalls(ListServicesCommand);
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]?.args[0].input?.NextToken).toBe('page-2');
    // Every op after resolution is ARN-driven.
    expect(apprunner.commandCalls(DescribeServiceCommand)[0]?.args[0].input?.ServiceArn).toBe(
      SERVICE_ARN,
    );
    expect(
      apprunner.commandCalls(ListTagsForResourceCommand)[0]?.args[0].input?.ResourceArn,
    ).toBe(SERVICE_ARN);
  });

  it('absent → CreateService with the public hello image, defaults, and mandatory tags', async () => {
    apprunner.on(ListServicesCommand).resolves({ ServiceSummaryList: [] });
    apprunner.on(CreateServiceCommand).resolves(runningService('OPERATION_IN_PROGRESS'));

    const report = await executor().apply(svcPlan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(SERVICE_ARN);
    const input = apprunner.commandCalls(CreateServiceCommand)[0]?.args[0].input;
    expect(input?.ServiceName).toBe('infraasprompt-svc');
    const repo = input?.SourceConfiguration?.ImageRepository;
    expect(repo?.ImageIdentifier).toBe(HELLO_IMAGE);
    expect(repo?.ImageRepositoryType).toBe('ECR_PUBLIC');
    expect(repo?.ImageConfiguration?.Port).toBe('8000');
    expect(input?.SourceConfiguration?.AutoDeploymentsEnabled).toBe(false);
    expect(input?.InstanceConfiguration?.Cpu).toBe('256');
    expect(input?.InstanceConfiguration?.Memory).toBe('512');
    const tags = Object.fromEntries((input?.Tags ?? []).map((t) => [t.Key, t.Value]));
    expect(tags['iap:managed']).toBe('true');
    expect(tags['iap:planId']).toBe('plan-hash-0001');
    expect(tags['iap:resourceId']).toBe('infraasprompt-svc.aws:apprunner:Service');
  });

  it('cpu drift → UpdateService in place by the resolved ARN', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-svc', 'aws:apprunner:Service', { cpu: '1024', memory: '2048' }),
    ]);
    apprunner.on(ListServicesCommand).resolves({
      ServiceSummaryList: [{ ServiceName: 'infraasprompt-svc', ServiceArn: SERVICE_ARN, Status: 'RUNNING' }],
    });
    apprunner.on(DescribeServiceCommand).resolves(runningService());
    apprunner.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });
    apprunner.on(UpdateServiceCommand).resolves({});

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(true);
    const input = apprunner.commandCalls(UpdateServiceCommand)[0]?.args[0].input;
    expect(input?.ServiceArn).toBe(SERVICE_ARN);
    expect(input?.InstanceConfiguration?.Cpu).toBe('1024');
    expect(input?.InstanceConfiguration?.Memory).toBe('2048');
    // In-place only: cpu/memory drift never cascades into delete+create.
    expect(apprunner.commandCalls(DeleteServiceCommand)).toHaveLength(0);
    expect(apprunner.commandCalls(CreateServiceCommand)).toHaveLength(0);
  });

  it('update rejected while OPERATION_IN_PROGRESS surfaces honestly (no retry loop)', async () => {
    const plan = providerPlan([
      planResource('infraasprompt-svc', 'aws:apprunner:Service', { cpu: '1024' }),
    ]);
    apprunner.on(ListServicesCommand).resolves({
      ServiceSummaryList: [{ ServiceName: 'infraasprompt-svc', ServiceArn: SERVICE_ARN, Status: 'OPERATION_IN_PROGRESS' }],
    });
    // Honest read: OPERATION_IN_PROGRESS still EXISTS (drift → update attempt).
    apprunner.on(DescribeServiceCommand).resolves(runningService('OPERATION_IN_PROGRESS'));
    apprunner.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });
    apprunner.on(UpdateServiceCommand).rejects(serviceError('InvalidStateException', 400));

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('update');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('InvalidStateException');
    expect(report.errors).toHaveLength(1);
    // Exactly ONE attempt — the handler never spins on the in-progress state.
    expect(apprunner.commandCalls(UpdateServiceCommand)).toHaveLength(1);
  });

  it('destroy → DeleteService by resolved ARN; unmanaged service is refused', async () => {
    apprunner.on(ListServicesCommand).resolves({
      ServiceSummaryList: [{ ServiceName: 'infraasprompt-svc', ServiceArn: SERVICE_ARN, Status: 'RUNNING' }],
    });
    apprunner.on(DescribeServiceCommand).resolves(runningService());
    apprunner.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });
    apprunner.on(DeleteServiceCommand).resolves(runningService('OPERATION_IN_PROGRESS'));

    const managed = await executor().apply(svcPlan, { apply: true, destroy: true });
    expect(managed.items[0]?.action).toBe('delete');
    expect(managed.items[0]?.applied).toBe(true);
    expect(apprunner.commandCalls(DeleteServiceCommand)[0]?.args[0].input?.ServiceArn).toBe(
      SERVICE_ARN,
    );

    // Same service WITHOUT iap:managed=true → managed-only gate refuses.
    apprunner.reset();
    apprunner.on(ListServicesCommand).resolves({
      ServiceSummaryList: [{ ServiceName: 'infraasprompt-svc', ServiceArn: SERVICE_ARN, Status: 'RUNNING' }],
    });
    apprunner.on(DescribeServiceCommand).resolves(runningService());
    apprunner.on(ListTagsForResourceCommand).resolves({ Tags: [] });

    const unmanaged = await executor().apply(svcPlan, { apply: true, destroy: true });
    expect(unmanaged.items[0]?.applied).toBe(false);
    expect(unmanaged.items[0]?.error).toContain('managed-only destroy');
    expect(apprunner.commandCalls(DeleteServiceCommand)).toHaveLength(0);
  });

  it('Status DELETED reads as absent even while the name lingers in ListServices', async () => {
    apprunner.on(ListServicesCommand).resolves({
      ServiceSummaryList: [{ ServiceName: 'infraasprompt-svc', ServiceArn: SERVICE_ARN, Status: 'DELETED' }],
    });
    apprunner.on(DescribeServiceCommand).resolves(runningService('DELETED'));

    const report = await executor().plan(svcPlan);

    expect(report.items[0]?.action).toBe('create');
    expect(apprunner.commandCalls(ListTagsForResourceCommand)).toHaveLength(0);
  });

  it('replacement N/A: no immutable projection keys — image drift classifies as update', async () => {
    const handler: TargetHandler = new AppRunnerServiceHandler(
      new AppRunnerClient({ region: 'eu-central-1' }),
    );
    // ADR-0006 justification: every key reconciles via UpdateService.
    expect(handler.immutableProjectionKeys).toBeUndefined();

    const plan = providerPlan([
      planResource('infraasprompt-svc', 'aws:apprunner:Service', { image: 'public.ecr.aws/other/image:1' }),
    ]);
    apprunner.on(ListServicesCommand).resolves({
      ServiceSummaryList: [{ ServiceName: 'infraasprompt-svc', ServiceArn: SERVICE_ARN, Status: 'RUNNING' }],
    });
    apprunner.on(DescribeServiceCommand).resolves(runningService());
    apprunner.on(ListTagsForResourceCommand).resolves({ Tags: MANAGED_TAGS });

    const report = await executor().plan(plan);
    expect(report.items[0]?.action).toBe('update'); // never 'replace'
  });
});
