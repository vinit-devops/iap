/**
 * The deterministic natural-language rules extractor (M3.2/M3.4 rules
 * adapter): vocabulary and pattern tables over the roadmap §3.2 facet space.
 * No model, no network, no randomness — the same input yields deeply
 * identical facets, spans, and reports on every run.
 *
 * Posture: PRECISION OVER RECALL. Rules run in a fixed order; each match
 * claims (covers) its span; later rules never re-interpret covered text.
 * Anything left uncovered that is not a stopword becomes an explicit
 * `UnparsedSpan` — unparsed input never silently drops. Capabilities the
 * v1 core vocabulary cannot express (provider products, reserved kinds,
 * out-of-scope services) become explicit `UnsupportedFinding`s with a
 * provider-neutral suggestion when one exists — never a guess into
 * extensions (ch. 19 §19.7).
 *
 * Confidence is a constant from `CONFIDENCE_TIERS` per pattern class:
 * exact vocabulary words rank `exact-keyword`, recognized phrasings rank
 * `pattern-match`, extractor-inferred connections rank
 * `inferred-association` (below the gate threshold — always confirmed).
 */

import { RESOURCE_ID_PATTERN } from '@iap/model';
import type { ComplianceFramework, IaPDocument, Kind } from '@iap/model';
import { CONFIDENCE_TIERS } from './facets.js';
import type {
  DataServiceFacet,
  ExtractionChannel,
  ExtractionResult,
  IntentFacet,
  ScalingFacet,
  SecretFacet,
  SubjectRef,
  UnparsedSpan,
  UnsupportedFinding,
  WorkloadFacet,
} from './facets.js';
import type { SourceSpan } from './operations.js';

export interface ExtractRulesOptions {
  /** Source-input identifier stamped into every span (default `request`). */
  inputId?: string;
  /** The current document; resolves subject nouns to existing resource ids. */
  document?: IaPDocument;
}

/* ------------------------------------------------------------------ */
/* Vocabulary tables                                                   */
/* ------------------------------------------------------------------ */

/** Noun → kind table for subject references ("the database", "the API"). */
const SUBJECT_NOUN_KINDS: readonly (readonly [string, Kind])[] = [
  ['database', 'Database'],
  ['db', 'Database'],
  ['session cache', 'Cache'],
  ['cache', 'Cache'],
  ['api', 'Service'],
  ['web app', 'Service'],
  ['web application', 'Service'],
  ['application', 'Service'],
  ['app', 'Service'],
  ['website', 'Service'],
  ['storefront', 'Service'],
  ['frontend', 'Service'],
  ['backend', 'Service'],
  ['service', 'Service'],
  ['load balancer', 'Gateway'],
  ['gateway', 'Gateway'],
  ['ingress', 'Gateway'],
  ['queue', 'Queue'],
  ['topic', 'Topic'],
  ['object storage', 'ObjectStore'],
  ['object store', 'ObjectStore'],
  ['bucket', 'ObjectStore'],
  ['volume', 'Volume'],
  ['disk', 'Volume'],
  ['secret', 'Secret'],
  ['identity', 'Identity'],
  ['function', 'Function'],
  ['job', 'Job'],
];

/** Provider products → refusal with the neutral vocabulary that expresses the intent. */
const PROVIDER_PRODUCTS: readonly (readonly [string, string | undefined])[] = [
  ['dynamodb', 'Database (class: key-value)'],
  ['cosmos ?db', 'Database (class: document)'],
  ['cloud sql', 'Database (class: relational)'],
  ['firestore', 'Database (class: document)'],
  ['aurora', 'Database (class: relational)'],
  ['rds', 'Database (class: relational)'],
  ['s3', 'ObjectStore'],
  ['lambda', 'Function'],
  ['sqs', 'Queue'],
  ['sns', 'Topic'],
  ['elasticache', 'Cache'],
  ['memorystore', 'Cache'],
  ['cloudfront', 'Gateway'],
  ['fargate', 'Service'],
  ['ec2', 'Service'],
  ['app engine', 'Service'],
  ['beanstalk', 'Service'],
  ['bigquery', undefined],
];

/** Capabilities outside the fully specified v1 kind vocabulary. */
const UNSUPPORTED_CAPABILITIES: readonly (readonly [string, string])[] = [
  ['vpn', 'network segmentation beyond exposure intent is reserved (Network kind, future minor)'],
  ['content delivery network', 'edge caching is not expressible in v1 core vocabulary'],
  ['cdn', 'edge caching is not expressible in v1 core vocabulary'],
  ['email (?:service|sending|delivery)', 'email delivery is outside the v1 kind vocabulary'],
  ['sms', 'SMS delivery is outside the v1 kind vocabulary'],
  ['dns (?:zone|records?)', 'DNS intent is reserved (DnsZone kind, future minor)'],
  ['kafka', 'ordered replayable streams are reserved (Stream kind, future minor)'],
  ['event stream(?:ing)?', 'ordered replayable streams are reserved (Stream kind, future minor)'],
  ['elasticsearch', 'search indexes are reserved (SearchIndex kind, future minor)'],
  ['opensearch', 'search indexes are reserved (SearchIndex kind, future minor)'],
  ['search index', 'search indexes are reserved (SearchIndex kind, future minor)'],
  ['data warehouse', 'analytical warehousing is outside the v1 kind vocabulary'],
  ['machine learning', 'ML workloads are outside the v1 kind vocabulary'],
  ['ml model', 'ML workloads are outside the v1 kind vocabulary'],
  ['blockchain', 'outside the v1 kind vocabulary'],
  ['active directory', 'directory services are outside the v1 kind vocabulary'],
  ['ldap', 'directory services are outside the v1 kind vocabulary'],
];

const FRAMEWORK_NORMALIZATION: readonly (readonly [RegExp, ComplianceFramework])[] = [
  [/pci/, 'pci-dss-4.0'],
  [/soc\s?-?2/, 'soc2'],
  [/hipaa/, 'hipaa'],
  [/iso\s?-?27001/, 'iso27001-2022'],
  [/nist/, 'nist-800-53-r5'],
  [/cis/, 'cis-8.0'],
];

const DURATION_UNITS: Readonly<Record<string, string>> = {
  s: 's',
  sec: 's',
  second: 's',
  seconds: 's',
  m: 'm',
  min: 'm',
  minute: 'm',
  minutes: 'm',
  h: 'h',
  hr: 'h',
  hour: 'h',
  hours: 'h',
  d: 'd',
  day: 'd',
  days: 'd',
};

/** Words carrying no extractable intent on their own; uncovered occurrences are not reported. */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'with',
  'for',
  'from',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'as',
  'is',
  'are',
  'am',
  'be',
  'been',
  'was',
  'were',
  'we',
  'i',
  'you',
  'they',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'our',
  'my',
  'your',
  'their',
  'us',
  'me',
  'need',
  'needs',
  'want',
  'wants',
  'would',
  'like',
  'please',
  'also',
  'too',
  'plus',
  'some',
  'all',
  'new',
  'set',
  'up',
  'should',
  'must',
  'may',
  'can',
  'could',
  'will',
  'do',
  'does',
  'have',
  'has',
  'had',
  'get',
  'give',
  'make',
  'makes',
  'add',
  'adds',
  'use',
  'uses',
  'using',
  'build',
  'create',
  'so',
  'then',
  'there',
  'here',
  'into',
  'onto',
  'per',
  'via',
]);

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract intent facets from a natural-language request. Deterministic
 * (no clock, no randomness, constant confidence tiers); handles the roadmap
 * §3.5 incremental-edit commands against an existing document.
 */
export function extractRules(input: string, options: ExtractRulesOptions = {}): ExtractionResult {
  const inputId = options.inputId ?? 'request';
  const document = options.document;
  const covered = new Array<boolean>(input.length).fill(false);
  const rawFacets: IntentFacet[] = [];
  const unsupported: UnsupportedFinding[] = [];
  let explain = false;

  /**
   * Push a facet, merging duplicates that would author the SAME resource:
   * two phrasings of one workload ("web app ... the storefront") or one data
   * service ("object storage for static assets") merge into the first facet,
   * later matches contributing any fields the first lacked. Distinctly named
   * or attached facets never merge — two caches for two workloads stay two.
   */
  const facets = rawFacets;
  const pushFacet = (facet: IntentFacet): void => {
    if (facet.facet === 'workload') {
      const existing = rawFacets.find(
        (candidate): candidate is WorkloadFacet =>
          candidate.facet === 'workload' &&
          candidate.workload === facet.workload &&
          (candidate.name ?? '') === (facet.name ?? ''),
      );
      if (existing !== undefined) {
        if (existing.artifact === undefined && facet.artifact !== undefined) {
          existing.artifact = facet.artifact;
        }
        if (existing.schedule === undefined && facet.schedule !== undefined) {
          existing.schedule = facet.schedule;
        }
        return;
      }
    }
    if (facet.facet === 'data-service') {
      const existing = rawFacets.find(
        (candidate): candidate is DataServiceFacet =>
          candidate.facet === 'data-service' &&
          candidate.service === facet.service &&
          (candidate.name ?? '') === (facet.name ?? '') &&
          JSON.stringify(candidate.attachTo ?? null) === JSON.stringify(facet.attachTo ?? null),
      );
      if (existing !== undefined) {
        if (existing.engine === undefined && facet.engine !== undefined) {
          existing.engine = facet.engine;
        }
        if (existing.databaseClass === undefined && facet.databaseClass !== undefined) {
          existing.databaseClass = facet.databaseClass;
        }
        if (existing.engineVersion === undefined && facet.engineVersion !== undefined) {
          existing.engineVersion = facet.engineVersion;
        }
        if (existing.storage === undefined && facet.storage !== undefined) {
          existing.storage = facet.storage;
        }
        return;
      }
    }
    if (facet.facet === 'messaging') {
      const duplicate = rawFacets.some(
        (candidate) =>
          candidate.facet === 'messaging' &&
          candidate.messaging === facet.messaging &&
          (candidate.name ?? '') === (facet.name ?? ''),
      );
      if (duplicate) return;
    }
    if (facet.facet === 'identity' || facet.facet === 'secret') {
      const duplicate = rawFacets.some(
        (candidate) =>
          candidate.facet === facet.facet &&
          ((candidate as { name?: string }).name ?? '') ===
            ((facet as { name?: string }).name ?? ''),
      );
      if (duplicate) return;
    }
    rawFacets.push(facet);
  };

  const span = (start: number, end: number): SourceSpan => ({
    input: inputId,
    start,
    end,
    text: input.slice(start, end),
  });
  const overlaps = (start: number, end: number): boolean => {
    for (let i = start; i < end; i += 1) if (covered[i] === true) return true;
    return false;
  };
  const cover = (start: number, end: number): void => {
    for (let i = start; i < end; i += 1) covered[i] = true;
  };

  /** Run one rule: each non-overlapping match is offered to the handler; a true return claims the span. */
  const run = (
    pattern: RegExp,
    handler: (match: RegExpExecArray, at: SourceSpan) => boolean,
  ): void => {
    for (const match of input.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) continue;
      if (handler(match as RegExpExecArray, span(start, end))) cover(start, end);
    }
  };

  const tier = (channel: ExtractionChannel): number => CONFIDENCE_TIERS[channel];

  const subjectFromNoun = (noun: string): SubjectRef => {
    const cleaned = noun.trim().toLowerCase();
    const slug = cleaned.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (RESOURCE_ID_PATTERN.test(slug) && document?.resources?.[slug] !== undefined) {
      return { resourceId: slug };
    }
    for (const [word, kind] of SUBJECT_NOUN_KINDS) {
      if (cleaned === word) return { kind };
    }
    if (RESOURCE_ID_PATTERN.test(slug)) return { resourceId: slug };
    return { kind: 'Service' };
  };

  // Subject-noun alternation: known nouns plus the document's resource ids,
  // longest first so multi-word nouns win.
  const nounWords = [
    ...SUBJECT_NOUN_KINDS.map(([word]) => word),
    ...Object.keys(document?.resources ?? {}),
  ]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map(escapeRegExp);
  const NOUN = `(${nounWords.join('|')})`;

  /* -- 0. Artifact references ----------------------------------------- */
  // Claimed FIRST: image references contain arbitrary words ("storefront",
  // "s3") that later vocabulary rules would otherwise match inside the URL.
  // Attachment to a workload happens in a post-pass once workloads exist.
  const artifactCaptures: { reference: string; sourceSpan: SourceSpan }[] = [];
  run(
    /\b(?:running|runs|using|deploying|serving)\s+(?:the\s+)?(?:container\s+)?image\s+(\S+)|\bimage\s+([a-z0-9][\w./-]*:[\w.-]+)/gi,
    (match, at) => {
      const raw = (match[1] ?? match[2]) as string;
      artifactCaptures.push({ reference: raw.replace(/[.,;]+$/, ''), sourceSpan: at });
      return true;
    },
  );

  /* -- 1. §3.5 directives ------------------------------------------- */

  run(
    /\bexplain what (?:changes\s+)?this request will make\b|\bexplain (?:the |what )?changes\b/gi,
    () => {
      explain = true;
      return true;
    },
  );

  run(/\bremove public access\b/gi, (_match, at) => {
    pushFacet({
      facet: 'networking',
      intent: 'remove-public-access',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });

  run(
    new RegExp(`\\bmake (?:the |our )?${NOUN} (private|internal|public)\\b`, 'gi'),
    (match, at) => {
      pushFacet({
        facet: 'exposure',
        exposure: match[2]?.toLowerCase() as 'private' | 'internal' | 'public',
        subject: subjectFromNoun(match[1] as string),
        sourceSpan: at,
        confidence: tier('exact-keyword'),
        channel: 'exact-keyword',
      });
      return true;
    },
  );

  run(
    new RegExp(`\\badd (?:a |an )?(redis|memcached)? ?cache for (?:the |our )?${NOUN}\\b`, 'gi'),
    (match, at) => {
      const facet: DataServiceFacet = {
        facet: 'data-service',
        service: 'cache',
        attachTo: subjectFromNoun(match[2] as string),
        sourceSpan: at,
        confidence: tier('exact-keyword'),
        channel: 'exact-keyword',
      };
      if (match[1] !== undefined) facet.engine = `${match[1].toLowerCase()}-compatible`;
      pushFacet(facet);
      return true;
    },
  );

  run(/\b(?:add |include |with )?disaster recovery\b/gi, (_match, at) => {
    pushFacet({
      facet: 'backup',
      backup: 'required',
      disasterRecovery: true,
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });

  run(
    /\b(?:move to|switch to|upgrade to|downgrade to) (standard|high|maximum) availability\b/gi,
    (match, at) => {
      pushFacet({
        facet: 'availability',
        availability: match[1]?.toLowerCase() as 'standard' | 'high' | 'maximum',
        sourceSpan: at,
        confidence: tier('exact-keyword'),
        channel: 'exact-keyword',
      });
      return true;
    },
  );

  run(new RegExp(`\\b(?:remove|delete|drop) (?:the |our )?${NOUN}\\b`, 'gi'), (match, at) => {
    pushFacet({
      facet: 'removal',
      subject: subjectFromNoun(match[1] as string),
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  // Fallback removal of an arbitrary identifier ("remove the reports-db"):
  // the subject resolves against the document, and an unknown id becomes an
  // unresolved-reference clarification — never a guess.
  run(/\b(?:remove|delete|drop) (?:the |our )?([a-z0-9][a-z0-9-]*)\b/gi, (match, at) => {
    const slug = (match[1] as string).toLowerCase();
    if (!RESOURCE_ID_PATTERN.test(slug)) return false;
    pushFacet({
      facet: 'removal',
      subject: { resourceId: slug },
      sourceSpan: at,
      confidence: tier('pattern-match'),
      channel: 'pattern-match',
    });
    return true;
  });

  run(
    /\breduce (?:the |our )?(?:expected |monthly )?costs?\b|\blower (?:the )?costs?\b/gi,
    (_match, at) => {
      pushFacet({
        facet: 'budget',
        period: 'monthly',
        reduce: true,
        sourceSpan: at,
        confidence: tier('pattern-match'),
        channel: 'pattern-match',
      });
      return true;
    },
  );

  /* -- 2. Quantified requirements ------------------------------------ */

  run(
    /\bmonthly (?:limit|budget|cost|spend) of \$\s?(\d+)\b|\$\s?(\d+)\s?(?:per month|\/month|a month|monthly)\b/gi,
    (match, at) => {
      const amount = Number.parseInt((match[1] ?? match[2]) as string, 10);
      pushFacet({
        facet: 'budget',
        amountUsd: amount,
        period: 'monthly',
        sourceSpan: at,
        confidence: tier('exact-keyword'),
        channel: 'exact-keyword',
      });
      return true;
    },
  );

  run(
    /\b(rpo|rto|recovery point objective|recovery time objective)\s?(?:of |under |within )?(\d+)\s?(minutes?|min|hours?|hr|days?|seconds?|sec|[smhd])\b/gi,
    (match, at) => {
      const which = (match[1] as string).toLowerCase().startsWith('recovery point')
        ? 'rpo'
        : (match[1] as string).toLowerCase().startsWith('recovery time')
          ? 'rto'
          : ((match[1] as string).toLowerCase() as 'rpo' | 'rto');
      const unit = DURATION_UNITS[(match[3] as string).toLowerCase()];
      if (unit === undefined) return false;
      const duration = `${match[2]}${unit}`;
      pushFacet({
        facet: 'recovery-objective',
        ...(which === 'rpo' ? { rpo: duration } : { rto: duration }),
        sourceSpan: at,
        confidence: tier('exact-keyword'),
        channel: 'exact-keyword',
      });
      return true;
    },
  );

  /* -- 3. Compliance --------------------------------------------------- */

  run(
    /\b(?:add\s+)?(pci[- ]?dss(?:[- ]?4(?:\.0)?)?|pci|soc[- ]?2|hipaa|iso[- ]?27001(?:[-:]2022)?|nist(?:[- ]?800[- ]?53(?:[- ]?r5)?)?|cis(?:[- ]?8(?:\.0)?)?)\s?(?:controls|compliance|compliant|requirements)?\b/gi,
    (match, at) => {
      const raw = (match[1] as string).toLowerCase();
      const entry = FRAMEWORK_NORMALIZATION.find(([pattern]) => pattern.test(raw));
      if (entry === undefined) return false;
      pushFacet({
        facet: 'compliance',
        framework: entry[1],
        sourceSpan: at,
        confidence: tier('exact-keyword'),
        channel: 'exact-keyword',
      });
      return true;
    },
  );

  /* -- 4. Environments ------------------------------------------------- */

  run(
    /\b((?:production|staging|development|qa)(?:(?:,\s*|\s+and\s+)(?:production|staging|development|qa))*)\s+environments?\b/gi,
    (match, at) => {
      const names = (match[1] as string).toLowerCase().split(/(?:,\s*|\s+and\s+)/);
      pushFacet({
        facet: 'environment',
        environments: [...new Set(names)],
        sourceSpan: at,
        confidence: tier('exact-keyword'),
        channel: 'exact-keyword',
      });
      return true;
    },
  );

  /* -- 5. Relationship phrasings ---------------------------------------- */

  run(new RegExp(`\\bconnects? to (?:the |a |an )?${NOUN}\\b`, 'gi'), (match, at) => {
    pushFacet({
      facet: 'networking',
      intent: 'connect',
      to: subjectFromNoun(match[1] as string),
      sourceSpan: at,
      confidence: tier('pattern-match'),
      channel: 'pattern-match',
    });
    return true;
  });
  run(
    new RegExp(`\\bpublish(?:es|ing)? (?:events? |messages? )?to (?:the |a |an )?${NOUN}\\b`, 'gi'),
    (match, at) => {
      pushFacet({
        facet: 'networking',
        intent: 'publish',
        to: subjectFromNoun(match[1] as string),
        sourceSpan: at,
        confidence: tier('pattern-match'),
        channel: 'pattern-match',
      });
      return true;
    },
  );
  run(
    new RegExp(
      `\\bconsum(?:es|ing)? (?:messages? |events? )?from (?:the |a |an )?${NOUN}\\b`,
      'gi',
    ),
    (match, at) => {
      pushFacet({
        facet: 'networking',
        intent: 'consume',
        to: subjectFromNoun(match[1] as string),
        sourceSpan: at,
        confidence: tier('pattern-match'),
        channel: 'pattern-match',
      });
      return true;
    },
  );
  run(
    new RegExp(`\\bstores? (?:data |files |images |assets )?in (?:the |a |an )?${NOUN}\\b`, 'gi'),
    (match, at) => {
      pushFacet({
        facet: 'networking',
        intent: 'store',
        to: subjectFromNoun(match[1] as string),
        sourceSpan: at,
        confidence: tier('pattern-match'),
        channel: 'pattern-match',
      });
      return true;
    },
  );

  run(/\bbehind (?:a |an |the )?(?:api )?(gateway|load balancer|ingress)\b/gi, (_match, at) => {
    pushFacet({
      facet: 'workload',
      workload: 'Gateway',
      name: 'edge',
      sourceSpan: at,
      confidence: tier('pattern-match'),
      channel: 'pattern-match',
    });
    return true;
  });

  /* -- 6. Provider signals ----------------------------------------------- */

  for (const [product, suggestion] of PROVIDER_PRODUCTS) {
    run(new RegExp(`\\b${product}\\b`, 'gi'), (match, at) => {
      const finding: UnsupportedFinding = {
        capability: match[0].toLowerCase(),
        sourceSpan: at,
        reason:
          'provider-specific product; IaP documents express provider-neutral intent only (ch. 19 §19.7)',
      };
      if (suggestion !== undefined) finding.suggestion = suggestion;
      unsupported.push(finding);
      return true;
    });
  }

  run(
    /\b(?:on|prefer(?:ably)?|use|using|host(?:ed)? on|deploy(?:ed)? (?:on|to)|run(?:ning)? on)\s+(aws|amazon web services|azure|microsoft azure|gcp|google cloud|kubernetes|k8s|on[- ]prem(?:ises)?)\b/gi,
    (match, at) => {
      const raw = (match[1] as string).toLowerCase();
      const provider = raw.includes('amazon')
        ? 'aws'
        : raw.includes('azure')
          ? 'azure'
          : raw.includes('google')
            ? 'gcp'
            : raw === 'k8s'
              ? 'kubernetes'
              : raw.startsWith('on')
                ? 'on-prem'
                : raw;
      pushFacet({
        facet: 'provider-preference',
        provider,
        sourceSpan: at,
        confidence: tier('exact-keyword'),
        channel: 'exact-keyword',
      });
      return true;
    },
  );
  run(/\b(aws|azure|gcp)\b/gi, (match, at) => {
    pushFacet({
      facet: 'provider-preference',
      provider: match[0].toLowerCase(),
      sourceSpan: at,
      confidence: tier('inferred-association'),
      channel: 'inferred-association',
    });
    return true;
  });

  /* -- 7. Availability and regions ------------------------------------------ */

  run(/\bmulti[- ]region(?:al)?\b/gi, (_match, at) => {
    pushFacet({
      facet: 'region',
      multiRegion: true,
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\b((?:us|eu|ap|sa|ca|me|af)(?:-[a-z]+)+-\d)\b/gi, (match, at) => {
    pushFacet({
      facet: 'region',
      regions: [(match[1] as string).toLowerCase()],
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\bhigh(?:ly)?[- ]availab(?:le|ility)\b/gi, (_match, at) => {
    pushFacet({
      facet: 'availability',
      availability: 'high',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\b(standard|high|maximum) availability\b/gi, (match, at) => {
    pushFacet({
      facet: 'availability',
      availability: match[1]?.toLowerCase() as 'standard' | 'high' | 'maximum',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });

  /* -- 8. Data services ---------------------------------------------------- */

  run(
    /\b(postgres(?:ql)?|mysql|mariadb)(?:\s+(\d+(?:\.\d+)*))?(?:\s+(?:database|db|instance))?\b/gi,
    (match, at) => {
      const engine = (match[1] as string).toLowerCase().startsWith('postgres')
        ? 'postgresql'
        : ((match[1] as string).toLowerCase() as 'mysql' | 'mariadb');
      const facet: DataServiceFacet = {
        facet: 'data-service',
        service: 'database',
        databaseClass: 'relational',
        engine,
        sourceSpan: at,
        confidence: tier('exact-keyword'),
        channel: 'exact-keyword',
      };
      if (match[2] !== undefined) facet.engineVersion = match[2];
      pushFacet(facet);
      return true;
    },
  );
  run(/\bmongo(?:db)?(?:[- ]compatible)?(?:\s+(?:database|db))?\b/gi, (_match, at) => {
    pushFacet({
      facet: 'data-service',
      service: 'database',
      databaseClass: 'document',
      engine: 'mongodb-compatible',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\bcassandra(?:[- ]compatible)?(?:\s+(?:database|db))?\b/gi, (_match, at) => {
    pushFacet({
      facet: 'data-service',
      service: 'database',
      databaseClass: 'key-value',
      engine: 'cassandra-compatible',
      sourceSpan: at,
      confidence: tier('inferred-association'),
      channel: 'inferred-association',
    });
    return true;
  });
  run(
    /\b(relational|document|key[- ]value|graph|time[- ]?series|vector)\s+(?:database|db|store)\b/gi,
    (match, at) => {
      const raw = (match[1] as string).toLowerCase().replace(/[ ]/g, '-');
      const normalized = (raw === 'time-series' ? 'timeseries' : raw) as NonNullable<
        DataServiceFacet['databaseClass']
      >;
      pushFacet({
        facet: 'data-service',
        service: 'database',
        databaseClass: normalized,
        sourceSpan: at,
        confidence: tier('exact-keyword'),
        channel: 'exact-keyword',
      });
      return true;
    },
  );
  run(/\b(?:sql\s+)?database\b/gi, (_match, at) => {
    pushFacet({
      facet: 'data-service',
      service: 'database',
      sourceSpan: at,
      confidence: tier('pattern-match'),
      channel: 'pattern-match',
    });
    return true;
  });

  run(/\b(redis|memcached)(?:[- ]compatible)?\s+cache\b/gi, (match, at) => {
    pushFacet({
      facet: 'data-service',
      service: 'cache',
      engine: `${(match[1] as string).toLowerCase()}-compatible`,
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\b(redis|memcached)(?:[- ]compatible)?\b/gi, (match, at) => {
    pushFacet({
      facet: 'data-service',
      service: 'cache',
      engine: `${(match[1] as string).toLowerCase()}-compatible`,
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\bcach(?:e|ing)\b/gi, (_match, at) => {
    pushFacet({
      facet: 'data-service',
      service: 'cache',
      sourceSpan: at,
      confidence: tier('pattern-match'),
      channel: 'pattern-match',
    });
    return true;
  });

  run(
    /\bobject stor(?:e|age)\b|\bblob storage\b|\bstatic assets?\b|\bfile uploads?\b|\bbucket\b/gi,
    (_match, at) => {
      pushFacet({
        facet: 'data-service',
        service: 'object-store',
        name: 'assets',
        sourceSpan: at,
        confidence: tier('pattern-match'),
        channel: 'pattern-match',
      });
      return true;
    },
  );

  run(/\bpersistent (?:volume|disk|storage)\b/gi, (_match, at) => {
    pushFacet({
      facet: 'data-service',
      service: 'volume',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });

  /* -- 9. Messaging ---------------------------------------------------------- */

  run(/\b(?:message|task|job|work) queue\b|\bqueue\b/gi, (_match, at) => {
    pushFacet({
      facet: 'messaging',
      messaging: 'queue',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\btopic\b|\bpub[/ -]?sub\b|\bevent bus\b/gi, (_match, at) => {
    pushFacet({
      facet: 'messaging',
      messaging: 'topic',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\bmessag(?:e|ing) (?:broker|system|bus|layer)\b|\bmessaging\b/gi, (_match, at) => {
    pushFacet({
      facet: 'messaging',
      messaging: 'unspecified',
      sourceSpan: at,
      confidence: tier('inferred-association'),
      channel: 'inferred-association',
    });
    return true;
  });

  /* -- 10. Workloads ------------------------------------------------------------ */

  run(
    /\bweb app(?:lication)?s?\b|\bwebsite\b|\bstorefront\b|\bweb service\b|\bweb frontend\b|\bfrontend\b/gi,
    (_match, at) => {
      pushFacet({
        facet: 'workload',
        workload: 'Service',
        name: 'web',
        sourceSpan: at,
        confidence: tier('pattern-match'),
        channel: 'pattern-match',
      });
      return true;
    },
  );
  run(/\b(?:rest |http |json )?api\b|\bbackend\b/gi, (_match, at) => {
    pushFacet({
      facet: 'workload',
      workload: 'Service',
      name: 'api',
      sourceSpan: at,
      confidence: tier('pattern-match'),
      channel: 'pattern-match',
    });
    return true;
  });
  run(
    /\b(nightly|daily|weekly|scheduled|cron|batch) jobs?\b|\bbatch processing\b/gi,
    (match, at) => {
      const facet: WorkloadFacet = {
        facet: 'workload',
        workload: 'Job',
        sourceSpan: at,
        confidence: tier('pattern-match'),
        channel: 'pattern-match',
      };
      const qualifier = match[1]?.toLowerCase();
      if (qualifier === 'nightly' || qualifier === 'daily') facet.schedule = '@daily';
      if (qualifier === 'weekly') facet.schedule = '@weekly';
      pushFacet(facet);
      return true;
    },
  );
  run(
    /\bserverless functions?\b|\bevent[- ]driven functions?\b|\bcloud functions?\b/gi,
    (_match, at) => {
      pushFacet({
        facet: 'workload',
        workload: 'Function',
        sourceSpan: at,
        confidence: tier('pattern-match'),
        channel: 'pattern-match',
      });
      return true;
    },
  );
  run(/\b(?:api )?gateway\b|\bload balancer\b|\bingress\b/gi, (_match, at) => {
    pushFacet({
      facet: 'workload',
      workload: 'Gateway',
      name: 'edge',
      sourceSpan: at,
      confidence: tier('pattern-match'),
      channel: 'pattern-match',
    });
    return true;
  });

  /* -- 11. Scaling, identity, secrets ------------------------------------------ */

  run(
    /\b(?:auto[- ]?scal(?:e|es|ing)|scal(?:e|es|ing))(?:\s+(?:from|between)\s+(\d+)\s+(?:to|and|[-–])\s+(\d+)|\s+(?:up\s+)?to\s+(\d+))?\b/gi,
    (match, at) => {
      const channel: ExtractionChannel = match[1] !== undefined ? 'exact-keyword' : 'pattern-match';
      const facet: ScalingFacet = {
        facet: 'scaling',
        sourceSpan: at,
        confidence: tier(channel),
        channel,
      };
      if (match[1] !== undefined) facet.min = Number.parseInt(match[1], 10);
      if (match[2] !== undefined) facet.max = Number.parseInt(match[2], 10);
      if (match[3] !== undefined) facet.max = Number.parseInt(match[3], 10);
      pushFacet(facet);
      return true;
    },
  );

  run(/\bworkload identit(?:y|ies)\b|\bservice account\b|\bmanaged identity\b/gi, (_match, at) => {
    pushFacet({
      facet: 'identity',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });

  run(
    /\bsecrets? (?:manager|management|store|storage)\b|\bapi keys?\b|\bcredentials?\b/gi,
    (_match, at) => {
      pushFacet({
        facet: 'secret',
        sourceSpan: at,
        confidence: tier('pattern-match'),
        channel: 'pattern-match',
      });
      return true;
    },
  );
  run(/\brotat(?:e|ed|ion|ing)\b/gi, (_match, _at) => {
    const secret = facets.find((facet): facet is SecretFacet => facet.facet === 'secret');
    if (secret === undefined) return false;
    secret.rotation = true;
    return true;
  });

  /* -- 12. Security and operations ----------------------------------------------- */

  run(/\btls\s?(?:minimum\s?)?(?:version\s?)?1\.3\b/gi, (_match, at) => {
    pushFacet({
      facet: 'security',
      requirement: 'tls-minimum-1.3',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\bencrypt(?:ed|ion|s)?(\s+at\s+rest|\s+in\s+transit)?\b/gi, (match, at) => {
    const dimension = match[1]?.trim().toLowerCase();
    pushFacet({
      facet: 'security',
      requirement:
        dimension === 'at rest'
          ? 'encryption-at-rest'
          : dimension === 'in transit'
            ? 'encryption-in-transit'
            : 'encryption',
      sourceSpan: at,
      confidence: tier(dimension !== undefined ? 'exact-keyword' : 'pattern-match'),
      channel: dimension !== undefined ? 'exact-keyword' : 'pattern-match',
    });
    return true;
  });

  run(/\bcentrali[sz]ed logging\b|\blogging\b|\blogs\b/gi, (_match, at) => {
    pushFacet({
      facet: 'operational',
      requirement: 'logs',
      level: 'required',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\bmetrics\b/gi, (_match, at) => {
    pushFacet({
      facet: 'operational',
      requirement: 'metrics',
      level: 'required',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\b(?:distributed )?tracing\b|\btraces\b/gi, (_match, at) => {
    pushFacet({
      facet: 'operational',
      requirement: 'traces',
      level: 'required',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\bmonitor(?:ing|ed)?\b/gi, (_match, at) => {
    pushFacet({
      facet: 'operational',
      requirement: 'metrics',
      level: 'preferred',
      sourceSpan: at,
      confidence: tier('inferred-association'),
      channel: 'inferred-association',
    });
    return true;
  });

  /* -- 13. Backup ------------------------------------------------------------------ */

  run(/\b(?:no|without|skip) backups?\b/gi, (_match, at) => {
    pushFacet({
      facet: 'backup',
      backup: 'none',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });
  run(/\b(?:daily |regular |automated )?backups?\b|\bbacked up\b/gi, (_match, at) => {
    pushFacet({
      facet: 'backup',
      backup: 'required',
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });

  /* -- 14. Storage quantities attach to the nearest data service ------------------- */

  run(/\b(\d+)\s?(Gi|Ti|Mi|gb|tb|mb)\b/g, (match, _at) => {
    const unit = match[2] as string;
    const exact = unit === 'Gi' || unit === 'Ti' || unit === 'Mi';
    const normalized = exact
      ? unit
      : unit.toLowerCase() === 'gb'
        ? 'Gi'
        : unit.toLowerCase() === 'tb'
          ? 'Ti'
          : 'Mi';
    const quantity = `${match[1]}${normalized}`;
    const start = match.index;
    const candidates = facets.filter(
      (facet): facet is DataServiceFacet =>
        facet.facet === 'data-service' &&
        (facet.service === 'database' || facet.service === 'volume') &&
        facet.storage === undefined,
    );
    const preceding = candidates.filter((facet) => facet.sourceSpan.start < start);
    const target =
      preceding.length > 0 ? (preceding[preceding.length - 1] as DataServiceFacet) : candidates[0];
    if (target === undefined) return false;
    target.storage = quantity;
    if (!exact) {
      target.channel = 'inferred-association';
      target.confidence = tier('inferred-association');
    }
    return true;
  });

  /* -- 15. Existing-resource references ---------------------------------------------- */

  run(/\b(?:existing|current)\s+([a-z0-9][a-z0-9-]*)\b/gi, (match, at) => {
    const reference = (match[1] as string).toLowerCase();
    if (!RESOURCE_ID_PATTERN.test(reference)) return false;
    pushFacet({
      facet: 'existing-resource',
      reference,
      sourceSpan: at,
      confidence: tier('exact-keyword'),
      channel: 'exact-keyword',
    });
    return true;
  });

  /* -- 16. Unsupported capability nouns ------------------------------------------------ */

  for (const [capability, reason] of UNSUPPORTED_CAPABILITIES) {
    run(new RegExp(`\\b${capability}\\b`, 'gi'), (match, at) => {
      unsupported.push({
        capability: match[0].toLowerCase(),
        sourceSpan: at,
        reason,
      });
      return true;
    });
  }

  /* -- 17. Generic exposure words (last: commands own their spans first) ---------------- */

  run(
    /\bpublic(?:ly)?(?:[- ](?:facing|accessible|reachable|available))?\b|\binternet[- ]facing\b/gi,
    (_match, at) => {
      pushFacet({
        facet: 'exposure',
        exposure: 'public',
        sourceSpan: at,
        confidence: tier('pattern-match'),
        channel: 'pattern-match',
      });
      return true;
    },
  );
  run(/\binternal(?:[- ]only)?\b/gi, (_match, at) => {
    pushFacet({
      facet: 'exposure',
      exposure: 'internal',
      sourceSpan: at,
      confidence: tier('pattern-match'),
      channel: 'pattern-match',
    });
    return true;
  });
  run(/\bprivate\b/gi, (_match, at) => {
    pushFacet({
      facet: 'exposure',
      exposure: 'private',
      sourceSpan: at,
      confidence: tier('pattern-match'),
      channel: 'pattern-match',
    });
    return true;
  });

  /* -- Post-pass: attach captured artifact references --------------------------------- */

  const unparsed: UnparsedSpan[] = [];
  for (const capture of artifactCaptures) {
    const compute = facets.filter(
      (facet): facet is WorkloadFacet => facet.facet === 'workload' && facet.workload !== 'Gateway',
    );
    if (compute.length === 1 && (compute[0] as WorkloadFacet).artifact === undefined) {
      (compute[0] as WorkloadFacet).artifact = capture.reference;
      continue;
    }
    // Zero or several candidate workloads: report explicitly, never guess.
    unparsed.push({
      sourceSpan: capture.sourceSpan,
      reason: `artifact reference "${capture.reference}" could not be attached to exactly one workload`,
    });
  }

  /* -- Unparsed reporting ------------------------------------------------------------- */

  let group: { start: number; end: number } | null = null;
  const flush = (): void => {
    if (group !== null) {
      unparsed.push({
        sourceSpan: span(group.start, group.end),
        reason: 'no extraction rule matched this text',
      });
      group = null;
    }
  };
  for (const token of input.matchAll(/[A-Za-z0-9$](?:[A-Za-z0-9.'$/-]*[A-Za-z0-9])?/g)) {
    const start = token.index;
    const end = start + token[0].length;
    let tokenCovered = true;
    for (let i = start; i < end; i += 1) {
      if (covered[i] !== true) {
        tokenCovered = false;
        break;
      }
    }
    if (tokenCovered) {
      flush();
      continue;
    }
    if (STOPWORDS.has(token[0].toLowerCase())) continue;
    if (group === null) group = { start, end };
    else group.end = end;
  }
  flush();

  const result: ExtractionResult = { facets, unparsed, unsupported };
  if (explain) result.explain = true;
  return result;
}
