/**
 * The deterministic half of technical/07's `ProposalCurator`, and BD-018's apply policy.
 *
 * > 2. `ProposalCurator` (deterministic + Librarian agent): dedupe against `kb_documents` (same
 * >    `id`/path or high lexical overlap → update instead of add), schema validation, secret scan,
 * >    size budgets (index ≤ 200 lines), contradiction candidates flagged, provenance attached.
 * > 3. Policy (BD-018): below `discard_below` → dropped (audit only); between thresholds →
 * >    proposal, or direct commit when `auto_apply` is on; above `proposal_above` → proposal.
 *
 * The Librarian *agent* is the other half and it runs before this: it reconciles each retrospective
 * proposal against the vault it was shown and produces a `LibrarianProposals` artifact. Everything
 * in this module is a pure function of that artifact plus the project's configuration, which is
 * what makes the thresholds assertable on both sides (standing rule 42) without a model.
 *
 * ## The three refusals, and why they live here rather than at the git call
 *
 * A proposal is model output (BD-022) and the apply path turns it into a **commit on the project's
 * repository**. Three properties therefore have to hold before a row is written, not before a push:
 *
 *  1. **It writes inside the vault, or it does not write.** BD-025 scopes the Librarian to the paths
 *     technical/07 names, and `target_path` is model-chosen. The containment is a property of the
 *     *join* — {@link vaultPathOf} refuses anything that is not a plain relative `.md` path under
 *     the knowledge directory — so a `..`, an absolute path, a Windows separator, a NUL or a path
 *     that has already been prefixed with the knowledge directory is a refusal rather than a commit
 *     outside it. Refusing early means the refusal is visible in the proposal queue with a reason,
 *     instead of as a provider error nobody reads.
 *  2. **It is bounded.** A page is capped at {@link MAX_PROPOSAL_DELTA_BYTES} and the vault index at
 *     {@link MAX_INDEX_LINES} (technical/07's "index ≤ 200 lines"). Unbounded model output would be
 *     written to a `text` column, into a commit, and back into the context pack of every later run.
 *  3. **One page, one action per batch.** Two proposals for the same path in one commit is two
 *     actions on one file, which the git provider's commits API rejects as a whole — so the second
 *     and later ones are refused here and the first still lands.
 *
 * Nothing here deletes anything, and that is deliberate: the four actions are add, update,
 * deprecate and no-op (product/05: "Deprecated pages are kept, never deleted"), so no curated
 * proposal can ever produce a `delete` action against the repository.
 */
import type {
  KnowledgeApplyPolicy,
  KnowledgeProposalStatus,
  LibrarianAction,
  LibrarianProposal,
} from '@platform/contracts';
// The page budget is a **wire** bound as well as a curation one — a maintainer's `edit` carries a
// page through `decideKbProposalRequestSchema` — so it is defined once, in contracts, and read here
// rather than restated (standing rule 41).
import { MAX_PROPOSAL_DELTA_BYTES } from '@platform/contracts';
import { PLATFORM_DEFAULT_CONFIG } from '../config/effective-config.js';
import { utf8ByteLength } from './tokens.js';

/** BD-018's two thresholds and its switch, resolved against the platform defaults. */
export interface KnowledgeApplyThresholds {
  readonly autoApply: boolean;
  readonly discardBelow: number;
  readonly proposalAbove: number;
}

const DEFAULTS = PLATFORM_DEFAULT_CONFIG.policies?.knowledge_apply ?? {};

/**
 * The thresholds in force for a project, resolved **and ordered**.
 *
 * The platform defaults are read from `PLATFORM_DEFAULT_CONFIG` rather than restated, so BD-018's
 * "Defaults: `auto_apply: off`" has one home. A project that sets none of the three gets all three.
 *
 * A project that configures `discard_below > proposal_above` has written two rules that both apply
 * to the same score — "this is noise" and "this always goes to a maintainer" — and the ordering is
 * decided **here**, once, rather than by the order of two `if`s downstream: `discard_below` is
 * lowered to meet `proposal_above`, so the overlap resolves towards the **queue**. Dropping a
 * proposal is invisible and queueing one is cheap and visible, and neither writes to the repository;
 * the band is then empty, so an inverted configuration also cannot auto-apply anything. The returned
 * value is therefore what the platform *used*, which is what the proposal's recorded reason quotes.
 */
export const knowledgeApplyThresholds = (
  policy: KnowledgeApplyPolicy | null | undefined,
): KnowledgeApplyThresholds => {
  const proposalAbove = policy?.proposal_above ?? DEFAULTS.proposal_above ?? 0.6;
  const discardBelow = policy?.discard_below ?? DEFAULTS.discard_below ?? 0.2;
  return {
    autoApply: policy?.auto_apply ?? DEFAULTS.auto_apply ?? false,
    discardBelow: Math.min(discardBelow, proposalAbove),
    proposalAbove,
  };
};

/** What the policy decided; the three states technical/02's KnowledgeProposal machine starts in. */
export type ProposalDisposition = Extract<
  KnowledgeProposalStatus,
  'discarded' | 'queued' | 'auto_applied'
>;

/**
 * BD-018, as one function.
 *
 * The band is **half-open**: `significance < discard_below` is noise, `significance >=
 * proposal_above` always queues, and the band between them is where `auto_apply` decides. Both
 * edges are asserted from both sides (standing rule 42) — a boundary asserted from one side is
 * satisfied by an implementation that refuses everything.
 *
 * An inverted configuration is reconciled by {@link knowledgeApplyThresholds} before it gets here,
 * so the band this function reads is never empty by accident and is empty on purpose when a project
 * has written one: nothing can then be auto-applied.
 */
export const dispositionFor = (
  significance: number,
  thresholds: KnowledgeApplyThresholds,
): ProposalDisposition => {
  if (!Number.isFinite(significance) || significance < thresholds.discardBelow) {
    // A non-finite significance cannot be compared and is therefore noise: standing rule 16 — a
    // guard against an untrusted producer must not read a field that producer can omit, and `NaN`
    // compares false against every ceiling.
    return 'discarded';
  }
  if (significance >= thresholds.proposalAbove) {
    return 'queued';
  }
  return thresholds.autoApply ? 'auto_applied' : 'queued';
};

/** technical/07 step 2: "size budgets (index ≤ 200 lines)". */
export const MAX_INDEX_LINES = 200;

/**
 * How many proposals one Librarian run may put into the queue.
 *
 * A bound on *model output* that becomes rows and, for the auto-applied ones, one commit. Twenty is
 * well above what a retrospective produces (the shipped facilitator prompt asks for the significant
 * ones) and low enough that a model looping on its own output cannot fill the table. Proposals past
 * the cap are refused with a reason rather than silently dropped.
 */
export const MAX_PROPOSALS_PER_RUN = 20;

/** The vault's own index page, relative to the knowledge directory (product/05). */
export const VAULT_INDEX_PATH = 'index.md';

/**
 * `lessons/L-2026-09-12.md` + `.agentic/knowledge` → `.agentic/knowledge/lessons/L-2026-09-12.md`,
 * or `null` when the path is not one the Librarian may write.
 *
 * The rules, all of them fail-closed: a non-empty relative path, `/` separators only, no segment
 * that is empty, `.` or `..`, no control characters, a `.md` suffix, and a length the git provider
 * and the `text` column can both carry. A path that already starts with the knowledge directory is
 * **refused rather than normalised**: `target_path` is documented as vault-relative, and quietly
 * accepting both spellings would make `knowledge/knowledge/x.md` and `knowledge/x.md` the same
 * request on one project and different requests on another.
 */
export const vaultPathOf = (knowledgeDir: string, targetPath: string): string | null => {
  if (targetPath.length === 0 || targetPath.length > 200) {
    return null;
  }
  // A control character (C0 or DEL) or a backslash in a path is a **refusal**, never something to
  // strip: both are how one spelling of a path becomes two on the far side, and a literal NUL is
  // refused by a PostgreSQL `text` column anyway. Written as a code-point scan rather than as a
  // regex because a regex that matches a control character is one biome refuses to let a reader
  // see (`lint/suspicious/noControlCharactersInRegex`), and a suppression comment would hide the
  // one line here that is security-relevant.
  for (const character of targetPath) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || character === '\\') {
      return null;
    }
  }
  if (!targetPath.endsWith('.md')) {
    return null;
  }
  const segments = targetPath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  const dir = knowledgeDir.replace(/\/+$/, '');
  if (dir.length === 0 || targetPath === dir || targetPath.startsWith(`${dir}/`)) {
    return null;
  }
  return `${dir}/${targetPath}`;
};

/** One proposal after the curator has read it. */
export interface CuratedProposal {
  readonly proposal: LibrarianProposal;
  /**
   * The action the platform will take, which is not always the one the model asked for: an `add`
   * whose page already exists in the index is an `update` (technical/07 step 2's dedupe, and the
   * shipped prompt's "Prefer this to adding").
   */
  readonly action: LibrarianAction;
  /** Repository-relative, under the knowledge directory; `null` for a proposal that writes nothing. */
  readonly repoPath: string | null;
  readonly status: ProposalDisposition;
  /** Why the platform decided this. Plain text, written by the platform, never by the model. */
  readonly reason: string;
  /** Does applying this proposal produce a git action? `no-op` and every refusal say no. */
  readonly writes: boolean;
}

export interface CurationInput {
  readonly proposals: readonly LibrarianProposal[];
  /** `projects.knowledge_dir`, e.g. `.agentic/knowledge`. */
  readonly knowledgeDir: string;
  /** Repository-relative paths the index already holds — `kb_documents.path`. */
  readonly indexedPaths: readonly string[];
  readonly thresholds: KnowledgeApplyThresholds;
  /**
   * technical/06 and BD-021: a shadow task's mutations are recorded, never performed. A shadow run's
   * proposals are therefore **queued for a human** even when `auto_apply` is on — visible, decidable,
   * and incapable of reaching the repository on their own.
   */
  readonly shadow: boolean;
}

const refuse = (proposal: LibrarianProposal, reason: string): CuratedProposal => ({
  proposal,
  action: proposal.action,
  repoPath: null,
  status: 'discarded',
  reason,
  writes: false,
});

/**
 * The deterministic curation: one {@link CuratedProposal} per input, in input order.
 *
 * Every input produces an output — a refusal is a *recorded* decision, not a silence — because
 * technical/07 calls the discard path "audit only" and BD-003 makes an unrecorded decision the one
 * an operator cannot reconstruct. What a refusal does not do is write a row that can ever become a
 * commit: `writes` is false and `repoPath` is null on every one of them.
 */
export const curateProposals = (input: CurationInput): readonly CuratedProposal[] => {
  const indexed = new Set(input.indexedPaths);
  const claimed = new Set<string>();
  const curated: CuratedProposal[] = [];

  for (const [index, proposal] of input.proposals.entries()) {
    if (index >= MAX_PROPOSALS_PER_RUN) {
      curated.push(
        refuse(
          proposal,
          `this run proposed more than ${MAX_PROPOSALS_PER_RUN} knowledge changes; the ones past the cap are recorded and not applied`,
        ),
      );
      continue;
    }

    const repoPath = vaultPathOf(input.knowledgeDir, proposal.target_path);
    if (repoPath === null) {
      curated.push(
        refuse(
          proposal,
          `the target path is not a page inside "${input.knowledgeDir}": the Librarian may only write vault-relative Markdown paths (BD-025)`,
        ),
      );
      continue;
    }

    if (proposal.action === 'no-op') {
      curated.push({
        proposal,
        action: 'no-op',
        repoPath,
        status: 'discarded',
        reason: 'the Librarian reported the vault already says this, so nothing is written',
        writes: false,
      });
      continue;
    }

    const size = utf8ByteLength(proposal.delta);
    if (size > MAX_PROPOSAL_DELTA_BYTES) {
      curated.push(
        refuse(
          proposal,
          `the proposed page is ${size} bytes, over the ${MAX_PROPOSAL_DELTA_BYTES}-byte budget`,
        ),
      );
      continue;
    }

    if (proposal.target_path === VAULT_INDEX_PATH) {
      const lines = proposal.delta.split('\n').length;
      if (lines > MAX_INDEX_LINES) {
        curated.push(
          refuse(
            proposal,
            `the vault index would be ${lines} lines, over the ${MAX_INDEX_LINES}-line budget (technical/07)`,
          ),
        );
        continue;
      }
    }

    if (claimed.has(repoPath)) {
      curated.push(
        refuse(
          proposal,
          `an earlier proposal in this run already writes "${repoPath}"; one commit cannot carry two actions for one file`,
        ),
      );
      continue;
    }

    // Dedupe (technical/07 step 2): a page the index already holds is updated, never added twice.
    const action: LibrarianAction =
      proposal.action === 'add' && indexed.has(repoPath) ? 'update' : proposal.action;
    const status = dispositionFor(proposal.significance, input.thresholds);
    const disposition =
      input.shadow && status === 'auto_applied' ? ('queued' as ProposalDisposition) : status;

    claimed.add(repoPath);
    curated.push({
      proposal,
      action,
      repoPath,
      status: disposition,
      reason: reasonFor({
        action,
        requested: proposal.action,
        status: disposition,
        significance: proposal.significance,
        thresholds: input.thresholds,
        shadow: input.shadow && status === 'auto_applied',
      }),
      writes: disposition !== 'discarded',
    });
  }

  return curated;
};

const reasonFor = (input: {
  readonly action: LibrarianAction;
  readonly requested: LibrarianAction;
  readonly status: ProposalDisposition;
  readonly significance: number;
  readonly thresholds: KnowledgeApplyThresholds;
  readonly shadow: boolean;
}): string => {
  const dedupe =
    input.action === input.requested
      ? ''
      : ` (the page is already indexed, so the requested "${input.requested}" is an "${input.action}")`;
  if (input.shadow) {
    return `a shadow task never writes to the repository, so this is queued for a human instead of applied${dedupe}`;
  }
  switch (input.status) {
    case 'discarded':
      return `significance ${input.significance} is below the project's discard threshold ${input.thresholds.discardBelow}${dedupe}`;
    case 'auto_applied':
      return `significance ${input.significance} is inside the project's auto-apply band [${input.thresholds.discardBelow}, ${input.thresholds.proposalAbove}) and auto_apply is on${dedupe}`;
    default:
      return `significance ${input.significance} queues this for a maintainer${dedupe}`;
  }
};
