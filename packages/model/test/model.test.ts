import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_VERSION,
  CORE_KINDS,
  KINDS,
  LEGACY_API_VERSIONS,
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
