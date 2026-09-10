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
 * `reused: 'inline'` (zod's default) rather than the `$defs`/`$ref` form `pnpm schemas` publishes:
 * the published documents are for editors and external consumers, where a shared `$defs` keeps the
 * file readable, and this one goes to a model, where a `$ref` is one more indirection between the
 * instruction and the shape.
 */
export const artifactJsonSchema = (artifactType: ArtifactType): JsonObject =>
  z.toJSONSchema(artifactDataSchemas[artifactType], {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'throw',
  }) as JsonObject;

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
