/**
 * The eval sets — TD-016's `evals/cases` per role, as checked-in artefacts that need no credential.
 *
 * > Each role has an **eval set**: 5–10 real tickets/diffs with expected verdicts/artifacts;
 * > changes to default prompts run the evals in CI. — product/13 § "Prompt quality process"
 *
 * ## What is here and what is blocked
 *
 * **Here:** the cases, their assertions, and the promptfoo configuration that would run them —
 * artefacts, reviewable, and held to the artifact schemas by `evals.test.ts` offline. A case that
 * names a field the schema does not have fails the build today, which is the drift this file is
 * mostly for.
 *
 * **Blocked:** *running* them. promptfoo's `anthropic:claude-agent-sdk` provider needs a live model,
 * this repository has no `llm-ci` environment and no `ANTHROPIC_API_KEY`, and promptfoo is not a
 * dependency. `scripts/eval.mjs` therefore **fails loudly and names what is missing** rather than
 * exiting 0 having run nothing — an eval that ran nothing and reported green is worse than no eval
 * (standing rule 18's shape, and PROGRESS backlog 8 is the same defect live in this repository: a
 * gitleaks scan of zero bytes printing "no leaks found"). The blocker brief is in the WP-17 notes
 * of `PROGRESS.md`.
 *
 * ## Two deviations from TD-016, both deliberate
 *
 * 1. **`cases.json`, not `cases.yaml`.** promptfoo accepts `.json` for both the config and the test
 *    files, and this repository has no YAML parser in its dependency tree. Adding one so that a
 *    test can validate a file nothing can execute is cost with no benefit; JSON is validated by the
 *    same test with nothing installed.
 * 2. **No per-role `schema.json`.** `schemas/artifacts/<type>.schema.json` is already generated from
 *    the one zod definition in `@platform/contracts` and checked by `pnpm schemas:check`. A second
 *    copy under each role would be a second generated corpus and therefore a second thing to drift
 *    (standing rule 41). A case names its `artifact_type`; {@link artifactSchemaPathFor} maps it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentRole, ArtifactType } from '@platform/contracts';
import { agentRoleSchema, artifactTypeSchema } from '@platform/contracts';

/** One promptfoo assertion, in the subset TD-016 chose (`is-json`, `javascript`, `llm-rubric`). */
export interface EvalAssertion {
  readonly type: 'is-json' | 'javascript' | 'llm-rubric';
  readonly value: string;
  /** `llm-rubric` is prose quality "only … at low weight" (TD-016); hard checks carry the weight. */
  readonly weight?: number;
}

export interface EvalCase {
  readonly id: string;
  readonly description: string;
  /**
   * The artifact this case is about, when it is **not** the set's own (WP-40).
   *
   * TD-016's format is one artifact type per role, which held while every role produced one. WP-40
   * gives two roles a second: the Architect produces a `ResearchReport` on the spike template and
   * the Product Manager a `TicketBreakdown` on the epic-split variant. A second *file* per role
   * would have been the alternative and is worse — `roleEvalPath` is one path, promptfoo's config
   * points at one file, and a role whose cases live in two places is a role whose corpus nobody
   * reads whole. So the set keeps the role's usual type and a case may name another one; every
   * check in `evals.test.ts` resolves per case rather than per set.
   */
  readonly artifact_type?: ArtifactType;
  /** Nunjucks variables the prompt template fills. Every one of them is untrusted in production. */
  readonly vars: Readonly<Record<string, string>>;
  /**
   * Top-level artifact fields the assertions read.
   *
   * Declared rather than parsed out of the JavaScript, so that `evals.test.ts` can hold a case to
   * the artifact schema **offline**: a case naming a field the schema does not have is a case that
   * would fail against a correct model, and that failure is worth having now rather than in CI on
   * somebody's credential.
   */
  readonly expect_fields: readonly string[];
  readonly assert: readonly EvalAssertion[];
}

export interface RoleEvalSet {
  readonly role: AgentRole;
  /** Null for a role whose stage produces no artifact — the triager reports rather than produces. */
  readonly artifact_type: ArtifactType | null;
  readonly cases: readonly EvalCase[];
}

const evalsRoot = new URL('../roles/', import.meta.url);

export const roleEvalPath = (role: AgentRole): string =>
  fileURLToPath(new URL(`${role}/evals/cases.json`, evalsRoot));

/** `RefinedSpec` → `schemas/artifacts/refined-spec.schema.json`, the one generated copy. */
export const artifactSchemaPathFor = (type: ArtifactType): string =>
  `schemas/artifacts/${type.replaceAll(/(?<!^)([A-Z])/g, '-$1').toLowerCase()}.schema.json`;

const load = (role: AgentRole): RoleEvalSet => {
  const parsed = JSON.parse(readFileSync(roleEvalPath(role), 'utf8')) as RoleEvalSet;
  if (parsed.role !== role) {
    throw new Error(
      `${roleEvalPath(role)} declares role ${JSON.stringify(parsed.role)}; a case set filed under the wrong role is a role with no cases`,
    );
  }
  if (parsed.artifact_type !== null && !artifactTypeSchema.options.includes(parsed.artifact_type)) {
    throw new Error(`${roleEvalPath(role)} names an unknown artifact type`);
  }
  for (const entry of parsed.cases) {
    if (
      entry.artifact_type !== undefined &&
      !artifactTypeSchema.options.includes(entry.artifact_type)
    ) {
      throw new Error(`${roleEvalPath(role)} case ${entry.id} names an unknown artifact type`);
    }
  }
  return parsed;
};

/** The artifact a case is about: its own when it names one, otherwise the set's. */
export const caseArtifactType = (set: RoleEvalSet, entry: EvalCase): ArtifactType | null =>
  entry.artifact_type ?? set.artifact_type;

export const ROLE_EVALS: Readonly<Record<AgentRole, RoleEvalSet>> = Object.fromEntries(
  agentRoleSchema.options.map((role) => [role, load(role)]),
) as Readonly<Record<AgentRole, RoleEvalSet>>;
