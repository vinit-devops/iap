/**
 * M3.2 deterministic NL rules extractor: vocabulary/pattern tables over the
 * §3.2 facet space, the §3.5 incremental-edit commands, explicit
 * unparsed-span and unsupported-capability reporting, and determinism.
 */
import { describe, expect, it } from 'vitest';
import { extractRules } from '../src/index';
import type {
  BudgetFacet,
  DataServiceFacet,
  IntentFacet,
  RecoveryObjectiveFacet,
  ScalingFacet,
  WorkloadFacet,
} from '../src/index';
import { fixtureDocument } from './helpers';

const HAPPY =
  'We need a public web app running image registry.example.com/storefront:1.4.2 behind a gateway, ' +
  'with a highly available postgresql 16 database, a redis cache, and object storage for static assets. ' +
  'Production and development environments. Daily backups.';

const kinds = (extraction: { facets: IntentFacet[] }): string[] =>
  extraction.facets.map((facet) => facet.facet);

describe('happy-path extraction (clear requirements)', () => {
  const extraction = extractRules(HAPPY, { inputId: 'req-1' });

  it('extracts every facet class the request states, and nothing is unparsed', () => {
    expect(kinds(extraction).sort()).toEqual(
      [
        'environment',
        'workload',
        'workload',
        'availability',
        'data-service',
        'data-service',
        'data-service',
        'backup',
        'exposure',
      ].sort(),
    );
    expect(extraction.unparsed).toEqual([]);
    expect(extraction.unsupported).toEqual([]);
  });

  it('attaches the artifact reference to the sole compute workload', () => {
    const web = extraction.facets.find(
      (facet): facet is WorkloadFacet => facet.facet === 'workload' && facet.workload === 'Service',
    );
    expect(web?.artifact).toBe('registry.example.com/storefront:1.4.2');
    expect(web?.name).toBe('web');
  });

  it('extracts engine, version, and class for the database exactly', () => {
    const db = extraction.facets.find(
      (facet): facet is DataServiceFacet =>
        facet.facet === 'data-service' && facet.service === 'database',
    ) as DataServiceFacet;
    expect(db.engine).toBe('postgresql');
    expect(db.engineVersion).toBe('16');
    expect(db.databaseClass).toBe('relational');
    expect(db.channel).toBe('exact-keyword');
    expect(db.confidence).toBe(0.95);
  });

  it('merges duplicate phrasings of the same resource (web app + storefront, object storage + static assets)', () => {
    const services = extraction.facets.filter(
      (facet) => facet.facet === 'workload' && (facet as WorkloadFacet).workload === 'Service',
    );
    expect(services).toHaveLength(1);
    const stores = extraction.facets.filter(
      (facet) =>
        facet.facet === 'data-service' && (facet as DataServiceFacet).service === 'object-store',
    );
    expect(stores).toHaveLength(1);
  });

  it('extracts environment names (environments are profiles, ch. 6)', () => {
    const environment = extraction.facets.find((facet) => facet.facet === 'environment');
    expect(environment).toMatchObject({ environments: ['production', 'development'] });
  });

  it('every source span quotes exactly the input slice it covers', () => {
    for (const facet of extraction.facets) {
      expect(facet.sourceSpan.input).toBe('req-1');
      expect(facet.sourceSpan.text).toBe(HAPPY.slice(facet.sourceSpan.start, facet.sourceSpan.end));
    }
  });

  it('is deterministic: the same input yields deeply identical results', () => {
    const again = extractRules(HAPPY, { inputId: 'req-1' });
    expect(JSON.stringify(again)).toBe(JSON.stringify(extraction));
  });
});

describe('ambiguous and conflicting requirements', () => {
  it('generic messaging extracts as unspecified with inferred confidence (clarified, never guessed)', () => {
    const extraction = extractRules('An api and a messaging system', { inputId: 'r' });
    const messaging = extraction.facets.find((facet) => facet.facet === 'messaging');
    expect(messaging).toMatchObject({ messaging: 'unspecified', channel: 'inferred-association' });
    expect(messaging?.confidence).toBe(0.7);
  });

  it('queue and topic are distinct exact extractions', () => {
    const extraction = extractRules('a task queue and an event bus', { inputId: 'r' });
    const values = extraction.facets
      .filter((facet) => facet.facet === 'messaging')
      .map((facet) => (facet as { messaging: string }).messaging)
      .sort();
    expect(values).toEqual(['queue', 'topic']);
  });

  it('budget and availability both extract from the roadmap worked example', () => {
    const extraction = extractRules('a highly available database with a monthly limit of $300', {
      inputId: 'r',
    });
    const budget = extraction.facets.find(
      (facet): facet is BudgetFacet => facet.facet === 'budget',
    );
    expect(budget).toMatchObject({ amountUsd: 300, period: 'monthly' });
    expect(extraction.facets.some((facet) => facet.facet === 'availability')).toBe(true);
  });
});

describe('unsupported-capability detection (never guessed into extensions)', () => {
  it('provider products surface as unsupported findings with neutral suggestions', () => {
    const extraction = extractRules('We want dynamodb and an s3 bucket on aws', { inputId: 'r' });
    const capabilities = extraction.unsupported.map((finding) => finding.capability).sort();
    expect(capabilities).toContain('dynamodb');
    expect(capabilities).toContain('s3');
    const dynamo = extraction.unsupported.find((finding) => finding.capability === 'dynamodb');
    expect(dynamo?.suggestion).toBe('Database (class: key-value)');
    // The provider preference itself is a facet, not an unsupported finding.
    expect(extraction.facets.some((facet) => facet.facet === 'provider-preference')).toBe(true);
  });

  it('out-of-vocabulary capabilities (vpn, kafka) are explicit findings, never facets', () => {
    const extraction = extractRules('a vpn and kafka', { inputId: 'r' });
    expect(extraction.unsupported.map((finding) => finding.capability).sort()).toEqual([
      'kafka',
      'vpn',
    ]);
    expect(extraction.facets).toEqual([]);
  });

  it('named provider regions extract as region facets (the compiler marks them unsupported)', () => {
    const extraction = extractRules('deploy in eu-west-1', { inputId: 'r' });
    expect(extraction.facets.find((facet) => facet.facet === 'region')).toMatchObject({
      regions: ['eu-west-1'],
    });
  });
});

describe('quantified requirements', () => {
  it('extracts RPO/RTO with unit normalization to the duration grammar', () => {
    const extraction = extractRules('an RPO of 15 minutes and RTO of 4 hours', { inputId: 'r' });
    const objectives = extraction.facets.filter(
      (facet): facet is RecoveryObjectiveFacet => facet.facet === 'recovery-objective',
    );
    expect(objectives.map((facet) => facet.rpo ?? facet.rto).sort()).toEqual(['15m', '4h']);
  });

  it('extracts scaling ranges exactly', () => {
    const extraction = extractRules('scale from 2 to 6 instances', { inputId: 'r' });
    const scaling = extraction.facets.find(
      (facet): facet is ScalingFacet => facet.facet === 'scaling',
    );
    expect(scaling).toMatchObject({ min: 2, max: 6, channel: 'exact-keyword' });
  });

  it('attaches storage quantities to the nearest data service', () => {
    const extraction = extractRules('a postgresql database with 100Gi storage', { inputId: 'r' });
    const db = extraction.facets.find(
      (facet): facet is DataServiceFacet => facet.facet === 'data-service',
    );
    expect(db?.storage).toBe('100Gi');
  });

  it('every compliance framework name maps to the closed ch. 17 vocabulary', () => {
    const cases: [string, string][] = [
      ['pci dss', 'pci-dss-4.0'],
      ['soc 2', 'soc2'],
      ['hipaa', 'hipaa'],
      ['iso 27001', 'iso27001-2022'],
      ['nist 800-53', 'nist-800-53-r5'],
      ['cis 8.0 controls', 'cis-8.0'],
    ];
    for (const [text, framework] of cases) {
      const extraction = extractRules(`must be ${text} compliant`, { inputId: 'r' });
      expect(
        extraction.facets.find((facet) => facet.facet === 'compliance'),
        text,
      ).toMatchObject({ framework });
    }
  });
});

describe('§3.5 incremental-edit commands against an existing document', () => {
  const document = fixtureDocument();

  it('"Add a cache for the API" — cache attached to the referenced workload', () => {
    const extraction = extractRules('Add a cache for the API', { inputId: 'r', document });
    const cache = extraction.facets.find(
      (facet): facet is DataServiceFacet => facet.facet === 'data-service',
    );
    expect(cache).toMatchObject({ service: 'cache', attachTo: { kind: 'Service' } });
    expect(extraction.unparsed).toEqual([]);
  });

  it('"Make the database private" — exposure facet with a kind subject', () => {
    const extraction = extractRules('Make the database private', { inputId: 'r', document });
    expect(extraction.facets[0]).toMatchObject({
      facet: 'exposure',
      exposure: 'private',
      subject: { kind: 'Database' },
    });
  });

  it('a document resource id wins over the noun table as the subject', () => {
    const extraction = extractRules('Make the orders-db internal', { inputId: 'r', document });
    expect(extraction.facets[0]).toMatchObject({
      facet: 'exposure',
      subject: { resourceId: 'orders-db' },
    });
  });

  it('"Remove public access" — a networking directive, not a removal', () => {
    const extraction = extractRules('Remove public access', { inputId: 'r', document });
    expect(extraction.facets[0]).toMatchObject({
      facet: 'networking',
      intent: 'remove-public-access',
    });
  });

  it('"Move to maximum availability" — a global availability facet', () => {
    const extraction = extractRules('Move to maximum availability', { inputId: 'r', document });
    expect(extraction.facets[0]).toMatchObject({ facet: 'availability', availability: 'maximum' });
  });

  it('"Add disaster recovery" — backup facet with the DR flag', () => {
    const extraction = extractRules('Add disaster recovery', { inputId: 'r', document });
    expect(extraction.facets[0]).toMatchObject({
      facet: 'backup',
      backup: 'required',
      disasterRecovery: true,
    });
  });

  it('"Remove the X" — removal facets for nouns and arbitrary identifiers', () => {
    const byNoun = extractRules('Remove the queue', { inputId: 'r', document });
    expect(byNoun.facets[0]).toMatchObject({ facet: 'removal', subject: { kind: 'Queue' } });
    const byId = extractRules('Remove the reports-db', { inputId: 'r', document });
    expect(byId.facets[0]).toMatchObject({
      facet: 'removal',
      subject: { resourceId: 'reports-db' },
    });
  });

  it('"Reduce expected cost" — a budget-reduction directive', () => {
    const extraction = extractRules('Reduce expected cost', { inputId: 'r', document });
    expect(extraction.facets[0]).toMatchObject({ facet: 'budget', reduce: true });
  });

  it('"Explain what changes this request will make" — the explain directive', () => {
    const extraction = extractRules('Explain what changes this request will make', {
      inputId: 'r',
      document,
    });
    expect(extraction.explain).toBe(true);
    expect(extraction.facets).toEqual([]);
  });
});

describe('unparsed input never silently drops', () => {
  it('unrecognized content is reported as spans with offsets', () => {
    const input = 'please deploy the flurble womble with a database';
    const extraction = extractRules(input, { inputId: 'r' });
    expect(extraction.facets.some((facet) => facet.facet === 'data-service')).toBe(true);
    expect(extraction.unparsed).toHaveLength(1);
    const span = extraction.unparsed[0]?.sourceSpan;
    expect(span?.text).toBe('deploy the flurble womble');
    expect(input.slice(span?.start, span?.end)).toBe(span?.text);
  });

  it('stopwords alone are not reported (no noise)', () => {
    const extraction = extractRules('we would like a database please', { inputId: 'r' });
    expect(extraction.unparsed).toEqual([]);
  });

  it('an artifact reference with no attachable workload is reported, not dropped', () => {
    const extraction = extractRules(
      'a web app and an api, running image registry.example.com/app:1.0.0',
      { inputId: 'r' },
    );
    expect(extraction.unparsed).toHaveLength(1);
    expect(extraction.unparsed[0]?.reason).toContain('could not be attached');
  });
});

describe('provider preference', () => {
  it('contextual provider mentions extract exactly; bare mentions infer', () => {
    const exact = extractRules('hosted on azure', { inputId: 'r' });
    expect(exact.facets[0]).toMatchObject({
      facet: 'provider-preference',
      provider: 'azure',
      channel: 'exact-keyword',
    });
    const inferred = extractRules('the gcp stack', { inputId: 'r' });
    expect(inferred.facets[0]).toMatchObject({
      facet: 'provider-preference',
      provider: 'gcp',
      channel: 'inferred-association',
    });
  });
});
