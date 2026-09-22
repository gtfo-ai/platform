/**
 * TD-012 at the **artifact** write — the path its enumeration has always named and that nothing
 * applied (WP-52, PROGRESS backlog 35).
 *
 * `createClaudeRunner` returns `structuredOutput: validated.data` untouched and the stage executor
 * stored it verbatim, so a credential the platform itself injected into the run reached
 * `artifacts.data`, `questions.text` and — through `recordMergeRequest` — the `tasks` row. It was
 * measured rather than inferred: `test/e2e/pipeline/librarian.e2e.test.ts` plants an
 * `ANTHROPIC_API_KEY` into a proposal through the **production** runner and found it verbatim in
 * the row.
 *
 * ## Prose is redacted; an identifier is refused
 *
 * The per-field split is `ARTIFACT_FIELD_POLICIES` in `@platform/contracts`, which carries the
 * classification rule and the check that keeps it complete. Here is what the two classes *do*:
 *
 *  - **prose** — `redactText`, and the replacements are summed into the count the row records;
 *  - **identifier** — a field the platform reads as a name. If it contains an injected secret the
 *    write is **refused** ({@link ArtifactIdentifierSecretError}) rather than rewritten, because
 *    redaction is many-to-one and an identity must not be (standing rule 70). The caller ends the
 *    run and escalates; nothing is stored.
 *
 * The refusal is the fail-closed direction and it costs **one run**. The alternative costs a
 * `[REDACTED:integration:…]` in `mr.head_sha`, which the platform then queries a provider with.
 *
 * ## An undeclared path is prose, and that is safe because of the check rather than by hope
 *
 * The walker classifies by path, and a path in neither list is treated as prose. That is only
 * sound because `artifact-fields.test.ts` compares the two lists with the schema's own string-leaf
 * set in both directions, and because every artifact this module is handed has already been
 * re-validated against the **strict** `artifactDataSchemas` — so an undeclared path cannot be
 * present. An artifact **type** with no policy at all is a different matter and is refused by name
 * (standing rule 7: it must fail, not default).
 *
 * ## What it does not do
 *
 * It is TD-012 **step 1** — exact match of the secrets this run was given. Steps 2 and 3 (the
 * gitleaks-derived patterns and the entropy heuristic) live in the run transcript's redactor
 * (`infrastructure/src/redaction/pattern-redaction.ts`); a caller that wants both composes them,
 * which is why this takes a `SecretRedactor` rather than a secret list.
 */
import type { ArtifactType, JsonValue } from '@platform/contracts';
import { ARTIFACT_FIELD_POLICIES } from '@platform/contracts';
import type { SecretRedactor } from '../ports/integrations/audit.js';

/**
 * An identifier field of an artifact contains a secret the platform injected into the run.
 *
 * Carries the **path**, never the value: this message is logged, put on a `run.failed` event and
 * shown to a human in an escalation brief, so naming the secret here would undo the redaction it
 * exists to enforce.
 */
export class ArtifactIdentifierSecretError extends Error {
  override readonly name = 'ArtifactIdentifierSecretError';
  readonly artifactType: ArtifactType;
  readonly path: string;

  // Fields and assignments, never a TypeScript parameter property — `erasableSyntaxOnly` is on and
  // these sources are run by Node's strip-only type stripping (`scripts/ts-source-resolver.mjs`).
  constructor(artifactType: ArtifactType, path: string) {
    super(
      `the ${artifactType} artifact carries a secret this run was given in "${path}", which the ` +
        'platform reads as an identifier; TD-012 refuses such a field rather than rewriting it, ' +
        'because a redacted identifier addresses the wrong row',
    );
    this.artifactType = artifactType;
    this.path = path;
  }
}

/** An artifact type reached this module with no entry in the per-field policy table. */
export class ArtifactPolicyMissingError extends Error {
  override readonly name = 'ArtifactPolicyMissingError';
  readonly artifactType: string;

  constructor(artifactType: string) {
    super(
      `no TD-012 field policy is declared for the "${artifactType}" artifact, so the platform ` +
        'cannot tell its identifiers from its prose; declare one in ARTIFACT_FIELD_POLICIES',
    );
    this.artifactType = artifactType;
  }
}

export interface RedactedArtifact {
  readonly data: JsonValue;
  /** How many replacements this document's prose needed. `0` is a fact, never an absence. */
  readonly count: number;
}

/** The policy for one type, or a named refusal (standing rule 7: it must fail, not default). */
const policyFor = (
  artifactType: ArtifactType,
): (typeof ARTIFACT_FIELD_POLICIES)[keyof typeof ARTIFACT_FIELD_POLICIES] => {
  const policy = ARTIFACT_FIELD_POLICIES[artifactType as keyof typeof ARTIFACT_FIELD_POLICIES] as
    | (typeof ARTIFACT_FIELD_POLICIES)[keyof typeof ARTIFACT_FIELD_POLICIES]
    | undefined;
  if (policy === undefined) {
    throw new ArtifactPolicyMissingError(artifactType);
  }
  return policy;
};

/**
 * The one walk both passes below are built on, so the path grammar cannot come apart.
 *
 * Object **keys** are the schema's, never the model's: `artifactDataSchemas` is strict, so a key
 * present here is one this repository wrote. Nothing renames a key — the reasoning is at
 * `exactSecretRedactor`'s own walk, which says the same about the platform's keys.
 */
const mapStringLeaves = (
  value: JsonValue,
  path: string,
  visit: (path: string, text: string) => string,
): JsonValue => {
  if (typeof value === 'string') return visit(path, value);
  if (Array.isArray(value)) {
    return value.map((item) => mapStringLeaves(item as JsonValue, `${path}[]`, visit));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = mapStringLeaves(item as JsonValue, path === '' ? key : `${path}.${key}`, visit);
    }
    return out;
  }
  return value;
};

/**
 * The path of the first **identifier** field carrying a secret this run was given, or `null`.
 *
 * Exported because the ask path needs the identifier half **without** the prose half: an
 * `AskAnswer`'s prose is redacted *and then bounded*, in that order, by
 * `packages/application/src/ask/executor.ts` (WP-31's cap argument — a placeholder can be longer
 * than the value it replaced), so it cannot use {@link redactArtifactData}'s uncapped redaction.
 * Both callers therefore ask the *same* question of the *same* table.
 */
export const findArtifactIdentifierSecret = (
  artifactType: ArtifactType,
  data: JsonValue,
  redactor: SecretRedactor,
): string | null => {
  const identifiers: ReadonlySet<string> = new Set(policyFor(artifactType).identifiers);
  let found: string | null = null;
  mapStringLeaves(data, '', (path, text) => {
    if (found === null && identifiers.has(path) && redactor.redactText(text).count > 0) {
      found = path;
    }
    return text;
  });
  return found;
};

/**
 * Redacts one artifact's `data` for storage, or refuses it.
 *
 * @throws {ArtifactIdentifierSecretError} an identifier field contains an injected secret.
 * @throws {ArtifactPolicyMissingError} the type has no declared field policy.
 */
export const redactArtifactData = (
  artifactType: ArtifactType,
  data: JsonValue,
  redactor: SecretRedactor,
): RedactedArtifact => {
  // The identifier pass runs **first and whole**: a refusal must not leave a half-rewritten
  // document behind, and the caller stores nothing either way.
  const offending = findArtifactIdentifierSecret(artifactType, data, redactor);
  if (offending !== null) {
    throw new ArtifactIdentifierSecretError(artifactType, offending);
  }
  const identifiers: ReadonlySet<string> = new Set(policyFor(artifactType).identifiers);
  let count = 0;
  const redacted = mapStringLeaves(data, '', (path, text) => {
    // Byte-identical, deliberately: an identifier the pass above cleared is stored as the model
    // wrote it, so the platform addresses the row the artifact names.
    if (identifiers.has(path)) return text;
    const outcome = redactor.redactText(text);
    count += outcome.count;
    return outcome.value;
  });
  return { data: redacted, count };
};
