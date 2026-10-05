/**
 * The structured-output contract — technical/04 § "Result handling":
 *
 * > `structured_output` validated **again** by the platform against the artifact schema (defence in
 * > depth); … On `error_max_structured_output_retries`: run `failed(schema)`.
 *
 * Both halves of that contract come from the same object here: the JSON Schema handed to the CLI
 * (`outputFormat: { type: 'json_schema', schema }`, which is how the model is *asked*) and the zod
 * validator the answer is checked against are both derived from `artifactDataSchemas` in
 * `@platform/contracts`. Defence in depth against a different schema is not depth — it is two
 * schemas that will drift, and the drift shows up as a stage that succeeds with an artifact the
 * pipeline cannot read.
 *
 * The model's answer is untrusted (BD-022): it is parsed, never cast, and the schemas are strict,
 * so an unknown key is a validation failure rather than a silently dropped field.
 *
 * Validation failures report **paths and messages, never values.** A rejected artifact can contain
 * anything the model saw, including a credential from a tool result the redactor did not catch, and
 * the failure text is sent back to the model on the retry and stored on the run.
 */
import type { ArtifactType, JsonObject, JsonValue } from '@platform/contracts';
import { artifactDataSchemas } from '@platform/contracts';
import * as z from 'zod';

export type StructuredOutputResult =
  | { readonly ok: true; readonly data: JsonValue }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * The JSON Schema for an artifact's `data`, as the CLI's `--json-schema` flag wants it.
 *
 * **Self-contained and inlined: no `$ref`, no `$defs`.** zod's `reused: 'inline'` default is not
 * enough on its own: `@platform/contracts` registers its shared value objects (`NonEmptyString`,
 * `PathPattern`, `ArtifactQuestion`, …) in zod's global registry with an `id`, and zod hoists every
 * schema with an id into `$defs` whatever `reused` says. The published `schemas/artifacts/*.json`
 * keep that form — they are for editors, where a shared `$defs` keeps the file readable — and this
 * one goes to a model, where a `$ref` is one more indirection between the instruction and the
 * shape. Worse, a check added on top of a registered schema (`nonEmptyStringSchema.max(200)`) comes
 * out as `{"$ref": "#/$defs/NonEmptyString", "maxLength": 200}`: a keyword beside a `$ref` with no
 * `type` of its own, which the pinned CLI's validator reports in strict mode as *"missing type
 * "string" for keyword "maxLength""* on every ResearchReport and TicketBreakdown run (first local
 * test, 2026-10-05; PROGRESS backlog 471). {@link inlineDefinitions} resolves every reference into
 * its definition, merging the sibling keywords with the **stricter** bound winning, which is what
 * zod enforces when both checks apply.
 *
 * **No `$schema` key.** The pinned CLI compiles the flag's value with a validator that has no
 * draft 2020-12 meta-schema registered, and a document naming it is refused before the model is
 * called: *"--json-schema is not a valid JSON Schema: no schema with key or ref
 * "https://json-schema.org/draft/2020-12/schema""* — every agent run exited 1 on it (CLI 2.1.267,
 * measured against `platform-runtime`, 2026-10-05, first local test). Without the key the same
 * document is accepted, so the declaration is dropped.
 */
export const artifactJsonSchema = (artifactType: ArtifactType): JsonObject => {
  const {
    $schema: _metaSchema,
    $defs,
    ...schema
  } = z.toJSONSchema(artifactDataSchemas[artifactType], {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'throw',
  }) as JsonObject;
  return inlineDefinitions(
    schema,
    ($defs ?? {}) as Readonly<Record<string, JsonValue>>,
    [],
  ) as JsonObject;
};

/** A keyword whose stricter value is the smaller one, and the ones where it is the larger. */
const UPPER_BOUNDS = new Set(['maxLength', 'maxItems', 'maximum', 'maxProperties']);
const LOWER_BOUNDS = new Set(['minLength', 'minItems', 'minimum', 'minProperties']);

/** A definition's keywords with a `$ref`'s siblings on top — the stricter numeric bound wins. */
const mergeSiblings = (definition: JsonObject, siblings: JsonObject): JsonObject => {
  const merged: Record<string, JsonValue> = { ...definition };
  for (const [key, value] of Object.entries(siblings)) {
    const existing = merged[key];
    if (typeof existing === 'number' && typeof value === 'number') {
      if (UPPER_BOUNDS.has(key)) {
        merged[key] = Math.min(existing, value);
        continue;
      }
      if (LOWER_BOUNDS.has(key)) {
        merged[key] = Math.max(existing, value);
        continue;
      }
    }
    merged[key] = value;
  }
  return merged;
};

const DEFINITION_REF = /^#\/\$defs\/(.+)$/;

/**
 * Every `#/$defs/<name>` reference replaced by its definition, recursively. A recursive definition
 * cannot be inlined, and no artifact has one (`structured-output.test.ts` builds every type), so
 * meeting one is a thrown error naming it rather than a schema the CLI would then refuse.
 */
export const inlineDefinitions = (
  node: JsonValue,
  definitions: Readonly<Record<string, JsonValue>>,
  path: readonly string[],
): JsonValue => {
  if (Array.isArray(node)) {
    return node.map((entry) => inlineDefinitions(entry, definitions, path));
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  const { $ref, ...rest } = node as JsonObject;
  const siblings = Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [key, inlineDefinitions(value, definitions, path)]),
  ) as JsonObject;
  if (typeof $ref !== 'string') {
    return siblings;
  }
  const name = DEFINITION_REF.exec($ref)?.[1];
  const definition = name === undefined ? undefined : definitions[name];
  if (name === undefined || definition === undefined) {
    throw new Error(`artifact JSON Schema: unresolvable reference ${JSON.stringify($ref)}`);
  }
  if (path.includes(name)) {
    throw new Error(`artifact JSON Schema: ${name} is recursive and cannot be inlined`);
  }
  const resolved = inlineDefinitions(definition, definitions, [...path, name]) as JsonObject;
  return mergeSiblings(resolved, siblings);
};

/** `path.to.field: message`, with the value deliberately absent. */
const describeIssue = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
  return `${path}: ${issue.message}`;
};

/**
 * Re-validates what the model returned.
 *
 * A run with no artifact type (`intake` classification, ask-the-task) has nothing to validate
 * against; its structured output is passed through unchecked and the caller decides what to do
 * with it. That is stated rather than silently treated as "valid", because the two readings differ
 * for a run that *does* have a type and whose spec forgot to say so — which is why `artifactType`
 * is a required, nullable field of `RunSpec` rather than an optional one.
 */
export const validateStructuredOutput = (
  artifactType: ArtifactType | null,
  value: unknown,
): StructuredOutputResult => {
  if (artifactType === null) {
    return { ok: true, data: (value ?? null) as JsonValue };
  }
  if (value === undefined || value === null) {
    return {
      ok: false,
      issues: [
        `(root): the run produced no structured output, but the ${artifactType} artifact requires one`,
      ],
    };
  }
  const parsed = artifactDataSchemas[artifactType].safeParse(value);
  return parsed.success
    ? { ok: true, data: parsed.data as JsonValue }
    : { ok: false, issues: parsed.error.issues.map(describeIssue) };
};
