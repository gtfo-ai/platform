/**
 * The check that keeps {@link ARTIFACT_FIELD_POLICIES} complete — standing rules 7 and 59.
 *
 * The scope is **read off the schema**, never carried here: every string-valued leaf path of every
 * entry of `artifactDataSchemas` is derived from `z.toJSONSchema` — the same representation the
 * runner hands the model (`infrastructure/src/runner/structured-output.ts`) — and compared with the
 * union of the type's `identifiers` and `prose` lists in **both** directions.
 *
 * So a type added with no policy fails, a field added to an existing type fails until it is
 * classified, and a renamed field fails rather than silently becoming prose. None of that depends
 * on anybody remembering to edit this file.
 *
 * **Enum leaves are excluded, and the exclusion is a property of the schema rather than a list.**
 * A closed set cannot carry a credential: a value outside it fails `validateStructuredOutput`
 * before anything is stored. The derivation marks them by reading `enum` off the derived document,
 * so adding a `z.enum` field needs no entry and changing one to `z.string()` needs one.
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { ARTIFACT_FIELD_POLICIES } from './artifact-fields.js';
import { artifactDataSchemas } from './artifacts.js';

type JsonSchemaNode = Record<string, unknown>;

/**
 * Every string-valued leaf path of one derived JSON Schema document.
 *
 * `$ref`/`$defs` are resolved rather than skipped: zod emits a `$def` for any schema it sees more
 * than once, so `nonEmptyStringSchema` — the type of most of these fields — is *always* a `$ref`.
 * The first version of this walker did not resolve them and reported two paths for `RefinedSpec`
 * instead of twenty-three, which is why the resolution is here and asserted below.
 *
 * `seen` is keyed by `(definition, path)` so a recursive definition terminates while still being
 * visited once per place it appears.
 */
const stringLeafPaths = (
  node: JsonSchemaNode,
  defs: Record<string, JsonSchemaNode>,
  prefix: string,
  out: { readonly open: Set<string>; readonly closed: Set<string> },
  seen: Set<string>,
): void => {
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    const name = ref.replace('#/$defs/', '');
    const key = `${name}@${prefix}`;
    if (seen.has(key)) return;
    seen.add(key);
    const target = defs[name];
    if (target !== undefined) stringLeafPaths(target, defs, prefix, out, seen);
    return;
  }
  const branches = (node['anyOf'] ?? node['oneOf']) as JsonSchemaNode[] | undefined;
  if (branches !== undefined) {
    for (const branch of branches) stringLeafPaths(branch, defs, prefix, out, seen);
    return;
  }
  const properties = node['properties'] as Record<string, JsonSchemaNode> | undefined;
  if (properties !== undefined) {
    for (const [key, value] of Object.entries(properties)) {
      stringLeafPaths(value, defs, prefix === '' ? key : `${prefix}.${key}`, out, seen);
    }
    return;
  }
  const items = node['items'] as JsonSchemaNode | undefined;
  if (items !== undefined) {
    stringLeafPaths(items, defs, `${prefix}[]`, out, seen);
    return;
  }
  const type = node['type'];
  const isString =
    type === 'string' || (Array.isArray(type) && (type as string[]).includes('string'));
  if (!isString) return;
  (Array.isArray(node['enum']) ? out.closed : out.open).add(prefix);
};

interface DerivedLeaves {
  /** Free-form string leaves — the ones a policy must classify. */
  readonly open: readonly string[];
  /** Enum leaves, excluded from the comparison because their value set is closed. */
  readonly closed: readonly string[];
}

export const derivedStringLeaves = (
  artifactType: keyof typeof artifactDataSchemas,
): DerivedLeaves => {
  const document = z.toJSONSchema(artifactDataSchemas[artifactType], {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'throw',
  }) as JsonSchemaNode;
  const out = { open: new Set<string>(), closed: new Set<string>() };
  stringLeafPaths(
    document,
    (document['$defs'] ?? {}) as Record<string, JsonSchemaNode>,
    '',
    out,
    new Set(),
  );
  return { open: [...out.open].sort(), closed: [...out.closed].sort() };
};

const artifactTypes = Object.keys(artifactDataSchemas) as (keyof typeof artifactDataSchemas)[];

/**
 * **The classification, stated independently of the table it checks** — round 2, the reviewer's
 * canary 1: moving `LibrarianProposals.proposals[].target_path` from `identifiers` to `prose`
 * passed every test in this repository, because the completeness check above compares the *union*
 * of the two lists with the schema and cannot see a field changing sides.
 *
 * A check derived from the table is circular, so the anchor has to be a second statement of the
 * answer. That is the shape `packages/domain/src/permissions.test.ts` already uses for
 * `PERMISSION_REQUIREMENTS`, and the reason it is worth its upkeep is the same: **which** class a
 * field is in is the security decision, and an enumeration nothing pins is one a refactor can
 * quietly rewrite. Prose is the majority and is left to the union check; this names the thirty-one
 * paths where a wrong answer is a wrong *action* (a provider call, a commit, a lookup).
 */
const IDENTIFIERS: Record<keyof typeof artifactDataSchemas, readonly string[]> = {
  RefinedSpec: ['kb_citations[].commit_sha', 'kb_citations[].path'],
  RootCauseAnalysis: [],
  ImplementationPlan: ['files_to_change[].path', 'protected_path_changes[].path'],
  ImplementationNotes: ['mr.branch', 'mr.head_sha', 'mr.project_path', 'mr.provider', 'mr.url'],
  ReviewVerdict: ['findings[].file', 'findings[].id', 'protected_path_changes_confirmed[]'],
  AcceptanceVerdict: [],
  RetroReport: [
    'cost_summary.by_stage[].stage',
    'proposals[].target_path',
    'returns[].existing_item',
    'returns[].readiness_criterion',
    'returns[].stage',
  ],
  LibrarianProposals: ['health[].path', 'proposals[].target_path'],
  ShadowReport: [
    'agent_review_of_human_mr[].file',
    'agent_review_of_human_mr[].id',
    'human_mr.branch',
    'human_mr.head_sha',
    'human_mr.project_path',
    'human_mr.provider',
    'human_mr.url',
    'ticket',
  ],
  ReadinessReport: ['criteria[].id'],
  DiscoveryDraft: [
    'documents[].path',
    'linked_documents[].path',
    'readiness[].id',
    'risk_classes[].name',
    'risk_classes[].paths[]',
  ],
  AskAnswer: ['citations[].run_id'],
  HistoryFindings: ['proposals[].target_path'],
  ResearchReport: ['kb_citations[].commit_sha', 'kb_citations[].path'],
  TicketBreakdown: [],
};

describe('the artifact field policy', () => {
  it('covers every artifact type, in both directions', () => {
    expect(Object.keys(ARTIFACT_FIELD_POLICIES).sort()).toEqual([...artifactTypes].sort());
  });

  it.each(artifactTypes)('classifies every string field of %s and no others', (artifactType) => {
    const declared = [
      ...ARTIFACT_FIELD_POLICIES[artifactType].identifiers,
      ...ARTIFACT_FIELD_POLICIES[artifactType].prose,
    ].sort();
    expect(declared).toEqual(derivedStringLeaves(artifactType).open);
  });

  it.each(artifactTypes)('declares no path twice for %s', (artifactType) => {
    const declared = [
      ...ARTIFACT_FIELD_POLICIES[artifactType].identifiers,
      ...ARTIFACT_FIELD_POLICIES[artifactType].prose,
    ];
    expect(new Set(declared).size).toBe(declared.length);
  });

  it.each(artifactTypes)('keeps %s’s identifier set where this file says it is', (artifactType) => {
    expect([...ARTIFACT_FIELD_POLICIES[artifactType].identifiers].toSorted()).toEqual(
      [...IDENTIFIERS[artifactType]].toSorted(),
    );
  });

  /**
   * The walker's own calibration (standing rule 21): if `$ref` resolution regressed, every
   * assertion above would still pass — against a much smaller derived set, because the lists here
   * would have been written to match whatever it produced. This pins three paths that only exist
   * behind a `$def` and one that does not.
   */
  it('resolves $defs, so a shared sub-schema is not invisible', () => {
    const leaves = derivedStringLeaves('RefinedSpec');
    expect(leaves.open).toContain('goal');
    expect(leaves.open).toContain('acceptance_criteria[].given');
    expect(leaves.open).toContain('questions[].text');
    expect(leaves.closed).toContain('decision');
  });

  /** An enum leaf is excluded by being an enum, not by being absent from a hand-written list. */
  it('excludes enum leaves from the classification it demands', () => {
    const leaves = derivedStringLeaves('AskAnswer');
    expect(leaves.closed).toEqual(['citations[].artifact_type', 'citations[].kind', 'confidence']);
    expect(leaves.open).not.toContain('confidence');
  });
});
