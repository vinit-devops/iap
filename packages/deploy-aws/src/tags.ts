/**
 * Mandatory tagging + the managed-only ownership gate.
 *
 * Every resource the runtime creates carries three provenance tags that the
 * caller cannot override: `iap:managed=true`, `iap:planId=<planId>`, and
 * `iap:resourceId=<logicalId>`. Destroy refuses to touch any resource that does
 * not carry `iap:managed=true`, so the runtime can never delete infrastructure
 * it did not create.
 */

export const MANAGED_TAG_KEY = 'iap:managed';
export const MANAGED_TAG_VALUE = 'true';
export const PLAN_TAG_KEY = 'iap:planId';
export const RESOURCE_TAG_KEY = 'iap:resourceId';

/** Build the tag map for a created resource; mandatory tags win over caller tags. */
export function buildTags(
  planId: string,
  logicalId: string,
  callerTags: Record<string, string> = {},
): Record<string, string> {
  return {
    ...callerTags,
    [MANAGED_TAG_KEY]: MANAGED_TAG_VALUE,
    [PLAN_TAG_KEY]: planId,
    [RESOURCE_TAG_KEY]: logicalId,
  };
}

/** The ownership gate: only resources tagged iap:managed=true may be destroyed. */
export function isManaged(tags: Record<string, string>): boolean {
  return tags[MANAGED_TAG_KEY] === MANAGED_TAG_VALUE;
}

/** Convert a tag map to the `{ Key, Value }[]` shape (S3/IAM), sorted by key. */
export function toTagList(tags: Record<string, string>): Array<{ Key: string; Value: string }> {
  return Object.keys(tags)
    .sort()
    .map((key) => ({ Key: key, Value: tags[key] ?? '' }));
}

/** Convert a `{ Key, Value }[]` list back to a tag map. */
export function fromTagList(
  list: ReadonlyArray<{ Key?: string | undefined; Value?: string | undefined }>,
): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const entry of list) {
    if (entry.Key !== undefined) tags[entry.Key] = entry.Value ?? '';
  }
  return tags;
}
