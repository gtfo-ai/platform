/**
 * `@platform/prompts` — the role prompts the platform ships, and the eval sets that hold them.
 *
 * product/13 § "Prompt architecture" layer 2: *"a job description — responsibilities, inputs,
 * outputs (artifact schema), quality bar, when to ask, when to return, when to stop. Shipped as a
 * default markdown file"*. They are markdown files under `roles/<role>/prompt.md` rather than
 * template literals in TypeScript for two reasons that are both about other tools reading them:
 * promptfoo's provider takes a prompt file (TD-016), and product/13 describes a project's own
 * `prompts/<stage>.md` as a file too — diffable against ours in the UI. Since WP-92 such a file
 * **adds to** the role prompt as a data block and never replaces it (technical/04).
 *
 * ## Layer 1 is not here
 *
 * The platform prompt — identity and the five non-negotiables, including the data-block rule — is
 * `PLATFORM_PROMPT` in `@platform/domain`, beside the code that renders the blocks it describes.
 * Two halves of one contract in two packages would drift on the first edit, and the half that
 * drifts silently is the one a model reads.
 *
 * ## Who reads this package
 *
 * The composition root (`apps/server/src/pipeline.ts`), because the dependency rule forbids
 * `@platform/application` from importing it: the ring that plans a run may depend on `domain` and
 * `contracts` and nothing else (`biome.json`). That is not an inconvenience — it is why a project
 * can replace a prompt without the planner knowing, which is product/13's whole override story.
 *
 * ## A packaging obligation for WP-22
 *
 * `prompt.md` is read from disk relative to this module (`import.meta.url`). There is no build step
 * for the server rings today, so the file sits beside the source it is read from; a `tsc` emit that
 * copies only `.js` would ship a package whose prompts are missing. That is a Docker-image
 * question, recorded in PROGRESS under WP-17's discovered work rather than pre-solved here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentRole } from '@platform/contracts';
import { agentRoleSchema } from '@platform/contracts';

export interface RolePrompt {
  readonly role: AgentRole;
  /**
   * Bumped whenever `prompt.md` changes (product/13: "prompt changes are decisions"), and recorded
   * on every run through `runs.prompt_version`.
   *
   * It is **not** the only protection against an edit that forgot to bump: `promptVersionOf` in
   * `@platform/domain` appends a digest of the assembled system prompt, so the audit can tell a
   * forgotten bump from a real one. The declared number is what a changelog and a human read.
   */
  readonly version: string;
  readonly text: string;
}

/**
 * The shipped version per role.
 *
 * A table rather than a field in each file's frontmatter: a prompt file is what a project writes
 * its own of, and a project's file carrying the platform's version number would claim to be a
 * platform prompt.
 */
export const ROLE_PROMPT_VERSIONS = {
  // WP-73 (backlog 142): the type mapping is a `type_mapping` data block when given, not a
  // `get_task_context` value — no `include` serves configuration.
  triager: '2',
  // WP-40: the epic-split variant's `TicketBreakdown` section.
  // Backlog 476: questions go in the artifact (`decision: ask`), not to `ask_human`; the direction
  // page and the business pages are named only when the pack has them.
  product_manager: '3',
  // Backlog 476: a low-confidence analysis asks through `questions`, not `ask_human`.
  investigator: '2',
  // WP-40: the spike template's `ResearchReport` section.
  // WP-81: `protected_path_changes` — declare every existing test / CI-lint file changed (BD-024).
  // Backlogs 475 and 476: plans only what the workspace can carry out (a missing generator's file is
  // written by hand and judged by CI), `validation_contract` named, knowledge "when the project has it".
  architect: '4',
  // WP-138: `open_mr` takes a title and a description; the branch and the target are the
  // platform's, the platform marks the merge request ready, and the record is the tool's.
  // Backlogs 473, 475 and 476: work in slices — commit, push and `open_mr` after the first, notes
  // before the cap — a check the workspace cannot run is a known gap, and no tool is reverse-engineered.
  // Backlog 486: the merge request stays a draft until Ready; the platform marks it, never the run.
  developer: '4',
  // WP-45: the project's `review_checklist` blocks, and `criteria` when a human's merge request is
  // compared against a RefinedSpec (the shadow report's review of the human MR).
  // WP-81: judge the plan's `protected_path_changes` into `protected_path_changes_confirmed`.
  reviewer: '4',
  acceptance_tester: '1',
  facilitator: '1',
  librarian: '2',
  // WP-54: runs the project's declared commands; R1, R2 and R6 are run rather than read.
  // WP-64: `public_api` in the risk-class table (backlog 216), `./.agentic/workspace/setup` as a
  // named verb for R6 (backlog 144), and technical pages only — business pages are step 3's.
  // Backlogs 469–471 (first local test): `not_checked` for R1/R2/R6 the workspace could not run
  // (BD-026's 2026-10-06 amendment), the run image's languages, the workspace kept out of the pages,
  // the language with no ticket, and the draft's lists handed in as arrays.
  discovery: '6',
  ask: '1',
  historian: '1',
} as const satisfies Record<AgentRole, string>;

const promptsRoot = new URL('../roles/', import.meta.url);

/** Where a role's default prompt lives on disk — also what the eval config points at. */
export const rolePromptPath = (role: AgentRole): string =>
  fileURLToPath(new URL(`${role}/prompt.md`, promptsRoot));

const load = (role: AgentRole): RolePrompt => ({
  role,
  version: ROLE_PROMPT_VERSIONS[role],
  text: readFileSync(rolePromptPath(role), 'utf8'),
});

/**
 * Every role's default prompt, read once at import.
 *
 * Read eagerly rather than lazily so that a missing or unreadable file is a **boot** failure of the
 * process that composes the pipeline, not a failure of the first run that happens to need that
 * role. A prompt that is missing for one role is missing for the deployment.
 */
export const ROLE_PROMPTS: Readonly<Record<AgentRole, RolePrompt>> = Object.fromEntries(
  agentRoleSchema.options.map((role) => [role, load(role)]),
) as Readonly<Record<AgentRole, RolePrompt>>;

export * from './skills.js';

export const packageId = '@platform/prompts' as const;
