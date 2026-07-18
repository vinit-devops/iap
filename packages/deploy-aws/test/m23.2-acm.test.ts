/**
 * M23.2 ACM certificate upgrade, mock-tested (aws-sdk-client-mock):
 *  - IDENTITY FIX: read resolves by the iap:resourceId tag, so a domainName
 *    change classifies `replace` (immutable) instead of a phantom `create`.
 *  - DNS-VALIDATION → ISSUED: create requests the cert, polls for the
 *    validation records, UPSERTs the CNAME(s) into the hosted zone, and waits
 *    for ISSUED — but only when a Route 53 client AND hostedZoneId are present.
 *  - route53-absent: keeps the M21.2 request-only behavior.
 *  - delete withdraws the validation CNAME then DeleteCertificate.
 *  - managed-only destroy refusal.
 *
 * The existing m21.2-handlers.test.ts ACM tests exercise the DomainName
 * fallback and must remain green.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ACMClient,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  RequestCertificateCommand,
} from '@aws-sdk/client-acm';
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { AcmCertificateHandler, AwsExecutor } from '../src/index.js';
import { planResource, providerPlan } from './helpers.js';

const acm = mockClient(ACMClient);
const r53 = mockClient(Route53Client);

const executor = () => new AwsExecutor({ region: 'eu-central-1' });

const ARN = 'arn:aws:acm:eu-central-1:000000000000:certificate/mock';
const LOGICAL = 'gateway-cert.aws:acm:Certificate';
const MANAGED_TAGS = [
  { Key: 'iap:managed', Value: 'true' },
  { Key: 'iap:resourceId', Value: LOGICAL },
];

beforeEach(() => {
  acm.reset();
  r53.reset();
});

describe('aws:acm:Certificate — tag identity (M23.2 fix)', () => {
  it('domain change resolves the SAME cert by tag → replace, not create', async () => {
    const plan = providerPlan([
      planResource('gateway-cert', 'aws:acm:Certificate', {
        domainName: 'new.example.test', // desired domain changed
        validationMethod: 'DNS',
      }),
    ]);
    // The live cert still serves the OLD domain but carries our resourceId tag.
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [{ CertificateArn: ARN, DomainName: 'old.example.test' }],
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: MANAGED_TAGS });
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'old.example.test',
        DomainValidationOptions: [{ DomainName: 'old.example.test', ValidationMethod: 'DNS' }],
      },
    });

    const report = await executor().plan(plan);
    // With the M21.2 DomainName match this would have been `create` (the bug).
    expect(report.items[0]?.action).toBe('replace');
  });
});

describe('aws:acm:Certificate — DNS validation to ISSUED (M23.2)', () => {
  const plan = providerPlan([
    planResource('gateway-cert', 'aws:acm:Certificate', {
      domainName: 'api.example.test',
      validationMethod: 'DNS',
      hostedZoneId: '/hostedzone/Z1',
    }),
  ]);

  it('create requests the cert, UPSERTs the validation CNAME, waits ISSUED', async () => {
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [] });
    acm.on(RequestCertificateCommand).resolves({ CertificateArn: ARN });
    // Validation record already exposed AND already ISSUED — both polls pass first.
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'api.example.test',
        Status: 'ISSUED',
        DomainValidationOptions: [
          {
            DomainName: 'api.example.test',
            ValidationMethod: 'DNS',
            ResourceRecord: {
              Name: '_x.api.example.test.',
              Type: 'CNAME',
              Value: '_y.acm-validations.aws.',
            },
          },
        ],
      },
    });
    r53.on(ChangeResourceRecordSetsCommand).resolves({
      ChangeInfo: { Id: '/change/C1', Status: 'PENDING' },
    });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(report.items[0]?.identifier).toBe(ARN);

    const req = acm.commandCalls(RequestCertificateCommand)[0]?.args[0].input;
    expect(req?.DomainName).toBe('api.example.test');
    expect(req?.ValidationMethod).toBe('DNS');

    // The validation CNAME was UPSERTed into the hosted zone.
    const change = r53.commandCalls(ChangeResourceRecordSetsCommand)[0]?.args[0].input;
    expect(change?.HostedZoneId).toBe('/hostedzone/Z1');
    const rrs = change?.ChangeBatch?.Changes?.[0];
    expect(rrs?.Action).toBe('UPSERT');
    expect(rrs?.ResourceRecordSet?.Name).toBe('_x.api.example.test.');
    expect(rrs?.ResourceRecordSet?.Type).toBe('CNAME');
    expect(rrs?.ResourceRecordSet?.ResourceRecords).toEqual([{ Value: '_y.acm-validations.aws.' }]);

    // ISSUED wait actually described the cert (loop closed).
    expect(acm.commandCalls(DescribeCertificateCommand).length).toBeGreaterThanOrEqual(1);
  });

  it('create fails FAST when ACM rejects the domain (FAILED before records) — live finding', async () => {
    // M23.2 live finding: a reserved/invalid domain (e.g. `.internal`) makes ACM
    // send the certificate straight to FAILED (INVALID_PUBLIC_DOMAIN) — it never
    // exposes DNS validation records. The handler must surface that reason, not
    // exhaust the poll budget and report a misleading timeout, and must NOT
    // publish anything into the hosted zone.
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [] });
    acm.on(RequestCertificateCommand).resolves({ CertificateArn: ARN });
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'api.example.test',
        Status: 'FAILED',
        FailureReason: 'INVALID_PUBLIC_DOMAIN',
        DomainValidationOptions: [{ DomainName: 'api.example.test', ValidationMethod: 'DNS' }],
      },
    });

    const report = await executor().apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('FAILED');
    expect(report.items[0]?.error).toContain('INVALID_PUBLIC_DOMAIN');
    // No validation records were ever exposed → nothing published to Route 53.
    expect(r53.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(0);
  });

  it('route53 absent → request-only fallback (no DNS records published)', async () => {
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [] });
    acm.on(RequestCertificateCommand).resolves({ CertificateArn: ARN });

    // Handler constructed WITHOUT a Route53 client (1.0.0 shape).
    const exec = new AwsExecutor({
      region: 'eu-central-1',
      handlers: [new AcmCertificateHandler(new ACMClient({ region: 'eu-central-1' }))],
    });
    const report = await exec.apply(plan, { apply: true });

    expect(report.items[0]?.action).toBe('create');
    expect(report.items[0]?.applied).toBe(true);
    expect(acm.commandCalls(RequestCertificateCommand)).toHaveLength(1);
    // No validation loop: no DescribeCertificate polling, no Route 53 writes.
    expect(acm.commandCalls(DescribeCertificateCommand)).toHaveLength(0);
    expect(r53.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(0);
  });

  it('destroy withdraws the validation CNAME then DeleteCertificate', async () => {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [{ CertificateArn: ARN, DomainName: 'api.example.test' }],
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: MANAGED_TAGS });
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: {
        CertificateArn: ARN,
        DomainName: 'api.example.test',
        DomainValidationOptions: [
          {
            DomainName: 'api.example.test',
            ValidationMethod: 'DNS',
            ResourceRecord: {
              Name: '_x.api.example.test.',
              Type: 'CNAME',
              Value: '_y.acm-validations.aws.',
            },
          },
        ],
      },
    });
    r53.on(ChangeResourceRecordSetsCommand).resolves({
      ChangeInfo: { Id: '/change/C9', Status: 'PENDING' },
    });
    acm.on(DeleteCertificateCommand).resolves({});

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.action).toBe('delete');
    expect(report.items[0]?.applied).toBe(true);

    const change = r53.commandCalls(ChangeResourceRecordSetsCommand)[0]?.args[0].input;
    const rrs = change?.ChangeBatch?.Changes?.[0];
    expect(rrs?.Action).toBe('DELETE');
    expect(rrs?.ResourceRecordSet?.Name).toBe('_x.api.example.test.');
    expect(acm.commandCalls(DeleteCertificateCommand)[0]?.args[0].input?.CertificateArn).toBe(ARN);
  });

  it('destroy refuses an unmanaged certificate (managed-only gate)', async () => {
    acm.on(ListCertificatesCommand).resolves({
      CertificateSummaryList: [{ CertificateArn: ARN, DomainName: 'api.example.test' }],
    });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: [] }); // not managed
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: { CertificateArn: ARN, DomainName: 'api.example.test' },
    });

    const report = await executor().apply(plan, { apply: true, destroy: true });

    expect(report.items[0]?.applied).toBe(false);
    expect(report.items[0]?.error).toContain('managed-only destroy');
    expect(acm.commandCalls(DeleteCertificateCommand)).toHaveLength(0);
  });
});
