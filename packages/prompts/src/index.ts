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
   * Since WP-176 a forgotten bump also fails the build: `ROLE_PROMPT_DIGESTS`
   * (`prompt-digests.ts`) records the file's digest under each version, and its census refuses a
   * `prompt.md` that no longer matches its declared version.
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
  // WP-176 (backlog 537): the conversation blocks and `get_conversation` are data.
  // WP-181: `get_conversation` is served, so its sentences drop the *when your tools* hedge.
  triager: '4',
  // WP-40: the epic-split variant's `TicketBreakdown` section.
  // Backlog 476: questions go in the artifact (`decision: ask`), not to `ask_human`; the direction
  // page and the business pages are named only when the pack has them.
  // WP-176 (backlog 537): the conversation blocks and `get_conversation` are data.
  // WP-181: `get_conversation` is served, so its sentences drop the *when your tools* hedge.
  product_manager: '5',
  // Backlog 476: a low-confidence analysis asks through `questions`, not `ask_human`.
  // WP-176 (backlog 537): the conversation blocks and `get_conversation` are data.
  // WP-181: `get_conversation` is served, so its sentences drop the *when your tools* hedge.
  investigator: '4',
  // WP-40: the spike template's `ResearchReport` section.
  // WP-81: `protected_path_changes` — declare every existing test / CI-lint file changed (BD-024).
  // Backlogs 475 and 476: plans only what the workspace can carry out (a missing generator's file is
  // written by hand and judged by CI), `validation_contract` named, knowledge "when the project has it".
  // Backlog 496: `report_progress` is built — one line when the reading ends and the plan begins.
  // WP-176 (backlog 537): the conversation blocks and `get_conversation` are data.
  // WP-181: `get_conversation` is served, so its sentences drop the *when your tools* hedge.
  architect: '7',
  // WP-138: `open_mr` takes a title and a description; the branch and the target are the
  // platform's, the platform marks the merge request ready, and the record is the tool's.
  // Backlogs 473, 475 and 476: work in slices — commit, push and `open_mr` after the first, notes
  // before the cap — a check the workspace cannot run is a known gap, and no tool is reverse-engineered.
  // Backlog 486: the merge request stays a draft until Ready; the platform marks it, never the run.
  // Backlog 492: every artifact field is its own parameter; `summary` short, at most 4 000 characters.
  // Backlog 496: `report_progress` is built — one line after each pushed slice; *Not recorded* is
  // not an error.
  // WP-176 (backlog 537): the conversation is data; `thread_replies` answers every note acted on,
  // one entry per request (a mixed note: `fixed`, `documented`, `needs_person` naming who must act,
  // never claimed done); a status-only return reads the conversation and asks when it finds nothing.
  // WP-181: `get_conversation` is served, so its sentences drop the *when your tools* hedge.
  developer: '8',
  // WP-45: the project's `review_checklist` blocks, and `criteria` when a human's merge request is
  // compared against a RefinedSpec (the shadow report's review of the human MR).
  // WP-81: judge the plan's `protected_path_changes` into `protected_path_changes_confirmed`.
  // WP-176 (backlog 537): the conversation is data; on a re-review `resolved_threads` lists only
  // its own finding threads whose fix it verified, never a person's thread.
  // WP-181: `get_conversation` is served, so its sentences drop the *when your tools* hedge.
  reviewer: '6',
  // WP-176 (backlog 537): the conversation blocks and `get_conversation` are data.
  // WP-181: `get_conversation` is served, so its sentences drop the *when your tools* hedge.
  acceptance_tester: '3',
  // WP-176 (backlog 537): the conversation blocks and `get_conversation` are data.
  // WP-181: `get_conversation` is served, so its sentences drop the *when your tools* hedge.
  facilitator: '3',
  // WP-176 (backlog 537): the conversation blocks and `get_conversation` are data.
  // WP-181: `get_conversation` is served, so its sentences drop the *when your tools* hedge.
  librarian: '4',
  // WP-54: runs the project's declared commands; R1, R2 and R6 are run rather than read.
  // WP-64: `public_api` in the risk-class table (backlog 216), `./.agentic/workspace/setup` as a
  // named verb for R6 (backlog 144), and technical pages only — business pages are step 3's.
  // Backlogs 469–471 (first local test): `not_checked` for R1/R2/R6 the workspace could not run
  // (BD-026's 2026-10-06 amendment), the run image's languages, the workspace kept out of the pages,
  // the language with no ticket, and the draft's lists handed in as arrays.
  // WP-176 (backlog 537): the conversation blocks and `get_conversation` are data.
  // WP-181: `get_conversation` is served, so its sentences drop the *when your tools* hedge.
  discovery: '8',
  // WP-176 (backlog 537): the conversation blocks and `get_conversation` are data.
  // WP-181: `get_conversation` is served, so its sentences drop the *when your tools* hedge.
  ask: '3',
  // WP-176 (backlog 537): the conversation blocks and `get_conversation` are data.
  // WP-181: `get_conversation` is served, so its sentences drop the *when your tools* hedge.
  historian: '3',
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
