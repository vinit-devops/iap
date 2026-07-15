/**
 * Static coverage-tiling verification (phase-6 design decision 6; spec
 * ch. 12 §12.3–§12.5; IEP-0012 "fail-closed coverage" loader obligation).
 *
 * Run at package load time so a defective package fails at install, not at
 * mapping time:
 *
 *  (a) every `derive` map is total over the supported values of its source
 *      field — the matrix's `values` constraint, or the specification's full
 *      enum when unconstrained (CM-3);
 *  (b) realize rules tile the supports matrix: every supported value
 *      combination of the fields referenced by `when` clauses is matched by
 *      some rule (a rule with no `when` is the default case and tiles
 *      everything);
 *  (c) every abstract output attribute the core declares for a supported
 *      kind is bound in `outputs`, and every binding names a target type
 *      some realize rule actually produces (CM-4).
 */

import type { MappingArtifact, Scalar, SupportsMatrix } from './mapping.js';
import {
  abstractOutputsForKind,
  isPathCovered,
  resolveKindField,
  splitTargetAttribute,
  supportedDomain,
} from './mapping.js';

export type MappingDefectCode =
  | 'derive-form'
  | 'derive-key-unresolvable'
  | 'derive-map-gap'
  | 'derive-map-unbounded'
  | 'when-field-unsupported'
  | 'when-value-out-of-domain'
  | 'realize-tiling-gap'
  | 'tiling-unverifiable'
  | 'unbound-output'
  | 'output-target-unknown'
  | 'values-field-unsupported';

export interface MappingDefect {
  code: MappingDefectCode;
  kind: string;
  message: string;
  /** Realize rule index, where the defect is rule-scoped. */
  ruleIndex?: number;
  field?: string;
  attribute?: string;
  value?: Scalar;
}

/** Ceiling on enumerated when-field value combinations (documented limit). */
export const MAX_TILING_COMBINATIONS = 65536;

/** Sentinel for "field absent from the canonical document" in tiling combos. */
const ABSENT = Symbol('absent');
type DomainValue = Scalar | typeof ABSENT;

function describeCombo(fields: string[], combo: DomainValue[]): string {
  return fields
    .map((field, i) => {
      const value = combo[i];
      return `${field}: ${value === ABSENT ? '(absent)' : JSON.stringify(value)}`;
    })
    .join(', ');
}

function fieldCanBeAbsent(kind: string, field: string): boolean {
  const info = resolveKindField(kind, field);
  // A field with a specification default is always present in canonical
  // input (ch. 1 §1.5.1); a field required by its parent is present in any
  // valid document. Everything else may be absent, including fields the
  // schema does not know (fail-closed: absence must then be tiled too).
  return !info.hasDefault && !info.requiredByParent;
}

function verifyKind(
  kind: string,
  supports: SupportsMatrix,
  km: MappingArtifact['mappings'][string],
  defects: MappingDefect[],
): void {
  // Values constraints must constrain supported fields.
  for (const field of Object.keys(supports.values ?? {})) {
    if (!isPathCovered(field, supports.fields)) {
      defects.push({
        code: 'values-field-unsupported',
        kind,
        field,
        message: `supports.values constrains "${field}", which is not in supports.fields`,
      });
    }
  }

  km.realize.forEach((rule, ruleIndex) => {
    // `when` clauses must reference supported fields with in-domain values.
    for (const [field, value] of Object.entries(rule.when ?? {})) {
      if (!isPathCovered(field, supports.fields)) {
        defects.push({
          code: 'when-field-unsupported',
          kind,
          ruleIndex,
          field,
          message: `realize[${ruleIndex}].when references "${field}", which is not in supports.fields`,
        });
      }
      const domain = supportedDomain(kind, field, supports);
      if (domain !== null && !domain.some((allowed) => allowed === value)) {
        defects.push({
          code: 'when-value-out-of-domain',
          kind,
          ruleIndex,
          field,
          value,
          message: `realize[${ruleIndex}].when matches ${field} = ${JSON.stringify(value)}, which is outside the supported domain — the rule is unreachable`,
        });
      }
    }

    // (a) derive form validity and map totality.
    for (const [key, spec] of Object.entries(rule.derive ?? {})) {
      const hasConstant = spec.constant !== undefined;
      const hasFrom = spec.from !== undefined;
      const hasMap = spec.map !== undefined;
      const validForm = (hasConstant && !hasFrom && !hasMap) || (hasFrom && !hasConstant);
      if (!validForm) {
        defects.push({
          code: 'derive-form',
          kind,
          ruleIndex,
          attribute: key,
          message: `realize[${ruleIndex}].derive["${key}"] must use exactly one of: constant, from, or from+map`,
        });
        continue;
      }
      if (splitTargetAttribute(key, rule.targets) === null) {
        defects.push({
          code: 'derive-key-unresolvable',
          kind,
          ruleIndex,
          attribute: key,
          message: `realize[${ruleIndex}].derive["${key}"] names no target the rule produces`,
        });
      }
      if (hasFrom && hasMap) {
        const from = spec.from as string;
        const map = spec.map as Record<string, Scalar>;
        const domain = supportedDomain(kind, from, supports);
        if (domain === null) {
          defects.push({
            code: 'derive-map-unbounded',
            kind,
            ruleIndex,
            attribute: key,
            field: from,
            message: `realize[${ruleIndex}].derive["${key}"] maps over "${from}", whose value domain is unbounded — a map can never be total; constrain supports.values["${from}"]`,
          });
        } else {
          for (const value of domain) {
            if (!Object.prototype.hasOwnProperty.call(map, String(value))) {
              defects.push({
                code: 'derive-map-gap',
                kind,
                ruleIndex,
                attribute: key,
                field: from,
                value,
                message: `realize[${ruleIndex}].derive["${key}"] map does not cover supported value ${JSON.stringify(value)} of "${from}" (CM-3)`,
              });
            }
          }
        }
      }
    }
  });

  // (b) realize rules tile the supports matrix.
  const hasDefaultRule = km.realize.some(
    (rule) => rule.when === undefined || Object.keys(rule.when).length === 0,
  );
  if (!hasDefaultRule) {
    const whenFields = [
      ...new Set(km.realize.flatMap((rule) => Object.keys(rule.when ?? {}))),
    ].sort();
    const domains: DomainValue[][] = [];
    let combinations = 1;
    let verifiable = true;
    for (const field of whenFields) {
      const domain = supportedDomain(kind, field, supports);
      if (domain === null) {
        defects.push({
          code: 'tiling-unverifiable',
          kind,
          field,
          message: `realize rules discriminate on "${field}", whose value domain is unbounded — tiling cannot be verified; add a default rule or constrain supports.values["${field}"]`,
        });
        verifiable = false;
        continue;
      }
      const effective: DomainValue[] = fieldCanBeAbsent(kind, field)
        ? [...domain, ABSENT]
        : [...domain];
      domains.push(effective);
      combinations *= effective.length;
    }
    if (verifiable && combinations > MAX_TILING_COMBINATIONS) {
      defects.push({
        code: 'tiling-unverifiable',
        kind,
        message: `tiling verification would enumerate ${combinations} combinations (limit ${MAX_TILING_COMBINATIONS}); add a default rule`,
      });
      verifiable = false;
    }
    if (verifiable) {
      const combo: DomainValue[] = new Array<DomainValue>(whenFields.length);
      const enumerate = (index: number): void => {
        if (index === whenFields.length) {
          const matched = km.realize.some((rule) =>
            Object.entries(rule.when ?? {}).every(
              ([field, value]) => combo[whenFields.indexOf(field)] === value,
            ),
          );
          if (!matched) {
            defects.push({
              code: 'realize-tiling-gap',
              kind,
              message: `no realize rule matches the supported combination { ${describeCombo(whenFields, combo)} } (ch. 12 §12.4 — supports and realize must tile exactly)`,
            });
          }
          return;
        }
        for (const value of domains[index] as DomainValue[]) {
          combo[index] = value;
          enumerate(index + 1);
        }
      };
      enumerate(0);
    }
  }

  // (c) output binding completeness.
  const outputs = km.outputs ?? {};
  for (const attribute of abstractOutputsForKind(kind)) {
    if (!Object.prototype.hasOwnProperty.call(outputs, attribute)) {
      defects.push({
        code: 'unbound-output',
        kind,
        attribute,
        message: `abstract output attribute "${attribute}" declared for ${kind} by ch. 3 §3.3 is not bound in outputs (CM-4)`,
      });
    }
  }
  const allTargets = [...new Set(km.realize.flatMap((rule) => rule.targets))];
  for (const [attribute, binding] of Object.entries(outputs)) {
    const target = allTargets.find((candidate) => binding.from.startsWith(`${candidate}.`));
    if (target === undefined) {
      defects.push({
        code: 'output-target-unknown',
        kind,
        attribute,
        message: `outputs.${attribute} binds to "${binding.from}", which names no target type any realize rule produces`,
      });
    }
  }
}

/**
 * Statically verify one mapping artifact. An empty result means the artifact
 * tiles; any defect refuses the containing package (PC-1).
 */
export function verifyMappingArtifact(artifact: MappingArtifact): MappingDefect[] {
  const defects: MappingDefect[] = [];
  for (const kind of Object.keys(artifact.mappings).sort()) {
    const km = artifact.mappings[kind];
    if (km) verifyKind(kind, km.supports, km, defects);
  }
  return defects;
}
