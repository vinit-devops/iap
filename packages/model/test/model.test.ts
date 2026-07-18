import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_VERSION,
  CORE_KINDS,
  GRADUATED_KINDS,
  NEW_KINDS,
  KINDS,
  RESERVED_KINDS,
  LEGACY_API_VERSIONS,
  isReservedKind,
  isSpecifiedKind,
  isNewKind,
  RELATIONSHIP_TYPES,
  POLICY_OPERATORS,
  COMPLIANCE_FRAMEWORKS,
  RESOURCE_ID_PATTERN,
  iisDocumentSchema,
  iisMappingSchema,
  isValidResourceId,
} from '../src/index';

const repoRoot = join(__dirname, '..', '..', '..');

function specSchema(name: string): string {
  return readFileSync(join(repoRoot, 'spec', 'schema', name), 'utf8');
}

function embeddedSchema(name: string): string {
  return readFileSync(join(__dirname, '..', 'schemas', name), 'utf8');
}

describe('schema drift guard (ADR-0002)', () => {
  it.each(['iap-v1.schema.json', 'iap-mapping-v1.schema.json'])(
    'embedded %s is byte-identical to spec/schema',
    (name) => {
      expect(embeddedSchema(name)).toBe(specSchema(name));
    },
  );
});

describe('constants match the normative schema', () => {
  const schema = iisDocumentSchema() as {
    $defs: {
      kindName: { enum: string[] };
      common: {
        relationshipType: { enum: string[] };
        policy: {
          properties: { effect: { enum: string[] } };
        };
        policyCondition: { oneOf: Array<{ properties?: { operator?: { enum: string[] } } }> };
      };
    };
    properties: {
      compliance: { properties: { frameworks: { items: { enum: string[] } } } };
    };
  };

  it('KINDS equals $defs/kindName enum', () => {
    expect([...KINDS]).toEqual(schema.$defs.kindName.enum);
  });

  it('RELATIONSHIP_TYPES equals $defs/common/relationshipType enum', () => {
    expect([...RELATIONSHIP_TYPES]).toEqual(schema.$defs.common.relationshipType.enum);
  });

  it('POLICY_OPERATORS equals the policy condition leaf operator enum', () => {
    const leaf = schema.$defs.common.policyCondition.oneOf.find((b) => b.properties?.operator);
    expect([...POLICY_OPERATORS]).toEqual(leaf?.properties?.operator?.enum);
  });

  it('COMPLIANCE_FRAMEWORKS equals the compliance frameworks enum', () => {
    expect([...COMPLIANCE_FRAMEWORKS]).toEqual(
      schema.properties.compliance.properties.frameworks.items.enum,
    );
  });

  it('CORE_KINDS all have a $defs/kinds entry', () => {
    const kinds = (iisDocumentSchema() as { $defs: { kinds: Record<string, unknown> } }).$defs
      .kinds;
    for (const kind of CORE_KINDS) {
      expect(kinds, `missing $defs/kinds/${kind}`).toHaveProperty(kind);
    }
  });

  it('spec 1.2.0 kind tiers (IEP-0016): all nine kinds graduated, reserved registry empty', () => {
    expect([...GRADUATED_KINDS]).toEqual([
      // 1.1.0 wave (IEP-0015)
      'Certificate',
      'DnsZone',
      'Registry',
      'Dashboard',
      'Alert',
      // 1.2.0 wave (IEP-0016)
      'Network',
      'Stream',
      'Workflow',
      'SearchIndex',
    ]);
    // The reserved registry is empty as of 1.2.0: every reserved kind graduated.
    expect([...RESERVED_KINDS]).toEqual([]);
    for (const kind of GRADUATED_KINDS) {
      expect(isSpecifiedKind(kind), kind).toBe(true);
      expect(isReservedKind(kind), kind).toBe(false);
      // CORE_KINDS stays the 1.0.0 thirteen (downstream registries key on it).
      expect(CORE_KINDS as readonly string[]).not.toContain(kind);
    }
    // No kind is reserved any longer: IAP801 can fire for nothing.
    for (const kind of KINDS) {
      expect(isReservedKind(kind), kind).toBe(false);
    }
    // Tiers partition the closed kind vocabulary exactly.
    expect([...CORE_KINDS, ...GRADUATED_KINDS, ...NEW_KINDS, ...RESERVED_KINDS].sort()).toEqual(
      [...KINDS].sort(),
    );
  });

  it('spec 1.3.0 kind tier (IEP-0017): Cdn and EventBus introduced directly, outside CORE_KINDS', () => {
    expect([...NEW_KINDS]).toEqual(['Cdn', 'EventBus']);
    for (const kind of NEW_KINDS) {
      // Specified (own $defs/kinds contract), not reserved.
      expect(isSpecifiedKind(kind), kind).toBe(true);
      expect(isNewKind(kind), kind).toBe(true);
      expect(isReservedKind(kind), kind).toBe(false);
      // CRITICAL (M23.1 lesson): NEW kinds are NOT in CORE_KINDS. Downstream
      // tables keyed on CORE_KINDS (provider-sdk abstract outputs, planner
      // kind reconstruction) stay the 1.0.0 thirteen until provider support
      // for these kinds lands.
      expect(CORE_KINDS as readonly string[]).not.toContain(kind);
      expect(GRADUATED_KINDS as readonly string[]).not.toContain(kind);
    }
    // KINDS gained exactly the two new names, appended at the end.
    expect(KINDS.slice(-2)).toEqual(['Cdn', 'EventBus']);
  });

  it('new-kind definitions carry x-iap-since 1.3.0 (ch. 10 §10.2.3)', () => {
    const kinds = (
      iisDocumentSchema() as { $defs: { kinds: Record<string, Record<string, unknown>> } }
    ).$defs.kinds;
    for (const kind of NEW_KINDS) {
      expect(kinds[kind], `missing $defs/kinds/${kind}`).toBeDefined();
      expect(kinds[kind]?.['x-iap-since'], `$defs/kinds/${kind}`).toBe('1.3.0');
    }
  });

  it('graduated kinds all have a $defs/kinds entry (promoted contracts)', () => {
    const kinds = (iisDocumentSchema() as { $defs: { kinds: Record<string, unknown> } }).$defs
      .kinds;
    for (const kind of GRADUATED_KINDS) {
      expect(kinds, `missing $defs/kinds/${kind}`).toHaveProperty(kind);
    }
  });

  it('graduated kind definitions carry the x-iap-since of their graduating minor (ch. 10 §10.2.3)', () => {
    const kinds = (
      iisDocumentSchema() as { $defs: { kinds: Record<string, Record<string, unknown>> } }
    ).$defs.kinds;
    for (const kind of ['Certificate', 'DnsZone', 'Registry', 'Dashboard', 'Alert']) {
      expect(kinds[kind]?.['x-iap-since'], `$defs/kinds/${kind}`).toBe('1.1.0');
    }
    for (const kind of ['Network', 'Stream', 'Workflow', 'SearchIndex']) {
      expect(kinds[kind]?.['x-iap-since'], `$defs/kinds/${kind}`).toBe('1.2.0');
    }
  });

  it('Database.class gained wide-column and warehouse in 1.1.0', () => {
    const database = (
      iisDocumentSchema() as {
        $defs: { kinds: { Database: { properties: { class: { enum: string[] } } } } };
      }
    ).$defs.kinds.Database;
    const classes = database.properties.class.enum;
    expect(classes).toContain('wide-column');
    expect(classes).toContain('warehouse');
    // 1.0.0 values retained verbatim, in order (minors are strictly additive).
    expect(classes.slice(0, 6)).toEqual([
      'relational',
      'document',
      'key-value',
      'graph',
      'timeseries',
      'vector',
    ]);
  });

  it('mapping schema parses', () => {
    expect(iisMappingSchema()).toHaveProperty('$id');
  });
});

describe('legacy apiVersion synonyms (IEP-0014 §1)', () => {
  it('lists iis.dev/v1 as a deprecated synonym and excludes the canonical value', () => {
    expect([...LEGACY_API_VERSIONS]).toEqual(['iis.dev/v1']);
    expect(LEGACY_API_VERSIONS as readonly string[]).not.toContain(API_VERSION);
  });
});

describe('resource id grammar', () => {
  it('accepts DNS labels', () => {
    for (const id of ['a', 'orders-db', 'a1-b2', 'x'.repeat(63)]) {
      expect(isValidResourceId(id), id).toBe(true);
    }
  });
  it('rejects invalid identifiers', () => {
    for (const id of ['', 'A', 'orders_db', '-a', 'a-', 'x'.repeat(64), 'a.b']) {
      expect(isValidResourceId(id), id).toBe(false);
    }
  });
  it('pattern matches the schema propertyNames pattern', () => {
    const schema = iisDocumentSchema() as {
      $defs: { common: { resourceId: { pattern: string } } };
    };
    expect(RESOURCE_ID_PATTERN.source).toBe(schema.$defs.common.resourceId.pattern);
  });
});
