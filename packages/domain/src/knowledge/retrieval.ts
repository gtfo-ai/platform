/**
 * Ranking and the token-budget fill — technical/07 § "Retrieval for context packs (phase 1)",
 * steps 1–4, as a pure function.
 *
 * > 1. **Path match:** documents whose `paths` globs match any touched path → score 1.0.
 * > 2. **Trigger/full-text match:** … boosted by document `kind` (stage-specific weights …) and by
 * >    `confidence`/`status`.
 * > 3. **Validate on read:** drop items whose cited paths/symbols no longer exist at HEAD; record
 * >    `validated=false` …
 * > 4. Fill the token budget (default 12 k for tiers 0–1): tier 0 always …, then tier 1 by score
 * >    until the budget is reached.
 *
 * The full-text *query* is the store's job (a `tsvector` and `websearch_to_tsquery`, TD-008); what
 * arrives here is a rank in `[0, 1]` per candidate. Everything after that — the boosts, the
 * validation, the ordering and the fill — is deterministic arithmetic with no I/O, which is why it
 * is here and not in the adapter, and why the acceptance figure in `retrieval.test.ts` reproduces
 * from a fixture rather than from a database.
 *
 * ## What "token budget respected" means, precisely
 *
 * "Tier 0 always" and "fill the budget" are in tension whenever tier 0 alone is larger than the
 * budget, and the two ways of resolving it quietly are both wrong: dropping a tier-0 document makes
 * "always" false, and letting tier 1 run on regardless makes the budget decoration. This module
 * takes the third option and **reports** it — {@link ContextPackAssembly.outcome} is
 * `tier0_over_budget`, tier 1 is empty, and `total_tokens` exceeds `budget_tokens` in the record
 * the audit stores. An operator can see it; nothing silently absorbs it. Under the shipped default
 * that state is unreachable for a well-formed vault, and `retrieval.test.ts` pins both the ordinary
 * number and this one.
 */
import {
  type ContextPackRecord,
  type IsoDate,
  KB_CONFIDENCE_WEIGHTS,
  type KbConfidence,
  type KbScope,
  kbConfidenceWeight,
} from '@platform/contracts';
import type { KbLayer } from './document.js';
import { matchingRepoPaths } from './globs.js';

/** Stages of the shipped templates, as the pack's emphasis table keys them. */
export type ContextEmphasis = 'business' | 'technical' | 'implementation' | 'history';

/**
 * product/05: "Refinement loads business context first; Architecture and Code review load technical
 * context and decisions; Implementation loads conventions, path-scoped rules and pitfalls;
 * Retrospective loads the task history."
 *
 * `satisfies` is doing real work: the record is checked against `BUILTIN_STAGE_IDS` as the
 * catalogue, so a stage added to the shipped templates is a **typecheck failure** here rather than
 * a stage that silently gets the default emphasis (rule 7 — ask the source, do not carry a copy).
 * `stage-emphasis.test.ts` iterates the same constant.
 */
export const STAGE_EMPHASIS = {
  intake: 'business',
  refinement: 'business',
  investigation: 'technical',
  architecture: 'technical',
  implementation: 'implementation',
  ci_gate: 'implementation',
  code_review: 'technical',
  business_review: 'business',
  rebase_gate: 'implementation',
  ready_for_merge: 'implementation',
  merged_gate: 'implementation',
  retrospective: 'history',
  librarian: 'history',
  done: 'implementation',
} as const;

/**
 * A project's `custom_stages` (technical/12) are slugs the platform has never seen, so there is
 * always a stage with no entry above — and a run with no stage at all (discovery, ask-the-task,
 * librarian outside the pipeline) has no key to look up either. `technical` is the neutral choice
 * and `emphasisFor` is where it is taken; the branch has its own named test, because a default
 * nothing exercises is a default nobody has read.
 */
export const DEFAULT_EMPHASIS: ContextEmphasis = 'technical';

export const emphasisFor = (stage: string | null): ContextEmphasis =>
  stage !== null && Object.hasOwn(STAGE_EMPHASIS, stage)
    ? STAGE_EMPHASIS[stage as keyof typeof STAGE_EMPHASIS]
    : DEFAULT_EMPHASIS;

/**
 * How much of a candidate's full-text rank survives, by the layer it sits in.
 *
 * Every weight is in `[0, 1]`, so a boosted score can never leave the unit interval that
 * `contextPackRecordSchema` requires — the clamp in {@link scoreCandidate} is defence in depth and
 * `retrieval.test.ts` asserts it is never the thing doing the work.
 */
export const EMPHASIS_LAYER_WEIGHTS = {
  business: {
    business: 1,
    decisions: 0.8,
    technical: 0.5,
    lessons: 0.6,
    rules: 0.7,
    tasks: 0.5,
    root: 0.6,
    other: 0.4,
  },
  technical: {
    technical: 1,
    decisions: 1,
    business: 0.5,
    lessons: 0.7,
    rules: 0.8,
    tasks: 0.4,
    root: 0.7,
    other: 0.4,
  },
  implementation: {
    lessons: 1,
    rules: 1,
    technical: 0.8,
    decisions: 0.6,
    business: 0.4,
    tasks: 0.4,
    root: 0.8,
    other: 0.4,
  },
  history: {
    tasks: 1,
    lessons: 0.9,
    decisions: 0.7,
    technical: 0.6,
    business: 0.6,
    rules: 0.5,
    root: 0.5,
    other: 0.4,
  },
} as const satisfies Record<ContextEmphasis, Record<KbLayer, number>>;

/**
 * An expired item is demoted, never dropped: product/05 calls expiry "soft" and hands
 * re-verification to the nightly hygiene job. Dropping it here would make a lesson disappear from
 * every pack on a date nobody looked at, which is the silent-deletion shape.
 */
export const EXPIRED_WEIGHT = 0.4;

/** product/05: "top 5–10 items" for tier 1. */
export const MAX_TIER1_DOCUMENTS = 10;

/**
 * ## There is no relevance floor, and that is a measured decision rather than an omission
 *
 * Review asked for one: a single stopword query returned a pack that was 87 % padding. Two shapes
 * were built, measured over the fixture vault, and **both were rejected** — the second of them was
 * my own, which is standing rule 27 turned on the implementer.
 *
 * **An absolute floor is backwards.** Against a real PostgreSQL 18 (2026-09-11, `ts_rank_cd` with
 * normalisation 32, `simple` configuration):
 *
 * | query | best rank | what it found |
 * |---|---|---|
 * | `"the"` | **0.947** | four padded pages, about nothing |
 * | `"seeded fixture user session tests"` | **0.048** | the one lesson that answers it |
 *
 * `ts_rank_cd` measures cover density and a common word is dense, so every threshold that excludes
 * the noise excludes the signal by a factor of twenty.
 *
 * **A floor relative to the best text score is store-dependent, which is worse than useless.** For
 * the query `session OR service OR fails OR tests OR with OR foreign OR violation`, the *correct
 * second answer* — `technical/session-service.md` — sits at **0.667** of the best score against
 * PostgreSQL and at **0.267** against the in-memory double, same corpus, same query. A ratio tuned
 * on one silently drops the right page on the other, and the acceptance figure is measured on the
 * double. A guard whose verdict depends on which store is underneath is not a guard.
 *
 * **What actually removed the measured harm is upstream of the score.** The stopword query never
 * reaches the store any more: `extractQueryTerms` reduces `"the"` and `"and the of"` to **no terms
 * at all**, so the text step contributes nothing and the pack is tier 0 plus whatever the author's
 * own `paths:` globs claim. That is store-independent, needs no threshold, and fails in the
 * direction that costs recall rather than precision.
 *
 * **What is left is a *good* query's tail**, and it is left in deliberately: for the session query
 * above, `technical/runbook.md` enters at 0.137 because it is the runbook *for the session
 * service*. Cutting it is a product judgement about recall, not a defect, and product/05 already
 * bounds it twice — {@link MAX_TIER1_DOCUMENTS} and the token budget. The precision that *is*
 * enforced is asserted rather than described: `context-pack.test.ts` and
 * `context-pack.integration.test.ts` both fail if a billing query admits a session page or the
 * reverse, against the fake and against PostgreSQL.
 */

/** product/05 and technical/07: the shipped context-pack budget for tiers 0–1. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 12_000;

/**
 * A tier-0 document: always in the pack, never scored.
 *
 * Path and size only. The document's **text** is deliberately not here: this ring decides what goes
 * in the pack, and the ring that can read a document is the one that writes the file. Carrying the
 * text through would also mean loading every candidate's body to make a decision that only needs
 * its length.
 */
export interface Tier0Document {
  readonly path: string;
  readonly tokens: number;
  /** Why it is unconditional — `index`, `rules`, `code_map`, `claude_md`. Audit only. */
  readonly reason: string;
}

export interface RetrievalCandidate {
  readonly path: string;
  readonly layer: KbLayer;
  readonly status: 'active' | 'deprecated' | null;
  readonly confidence: KbConfidence | null;
  readonly scope: KbScope | null;
  /** Frontmatter `paths:` globs — both the path-match signal and what validate-on-read checks. */
  readonly paths: readonly string[];
  readonly expires: IsoDate | null;
  readonly tokens: number;
  /**
   * The store's full-text rank in `[0, 1]`, or `null` for a candidate that only ever matched by
   * path. Deliberately nullable rather than defaulted to zero: "this document did not come back
   * from the text query" and "this document came back with rank 0" are different facts, and
   * collapsing them is rule 16's shape.
   */
  readonly textRank: number | null;
}

export type Tier1Reason = 'paths' | 'trigger' | 'artifact';

export interface SelectedDocument {
  readonly tier: 0 | 1;
  readonly path: string;
  readonly tokens: number;
  readonly reason: string;
}

export type PackOutcome = 'within_budget' | 'tier0_over_budget';

export interface ContextPackAssembly {
  readonly record: ContextPackRecord;
  /** Tier 0 in the order given, then the admitted tier-1 documents by descending score. */
  readonly documents: readonly SelectedDocument[];
  readonly outcome: PackOutcome;
  /**
   * Paths the fill could not **afford** — and nothing else.
   *
   * Round 1 put three causes in this one list (the budget, the tier-1 count ceiling, and a tier-0
   * overrun that admits nothing at all), which made the acceptance test's warrant unsound: it read
   * "`droppedForBudget` is non-empty, therefore the budget stopped the fill" from a list that is
   * non-empty in two other cases too. The conclusion happened to be true and the argument did not
   * support it, which is the combination that survives review. The causes are separate now, so the
   * warrant is the assertion.
   */
  readonly droppedForBudget: readonly string[];
  /** Paths refused by {@link MAX_TIER1_DOCUMENTS} while the budget still had room. */
  readonly droppedForCount: readonly string[];
  /** Paths whose cited `paths:` no longer resolve at HEAD (technical/07 step 3). */
  readonly droppedByValidation: readonly string[];
  /** Paths excluded because their `scope: stage:<x>` names a different stage. */
  readonly droppedByScope: readonly string[];
  /** Paths excluded because the document is `status: deprecated`. */
  readonly droppedAsDeprecated: readonly string[];
}

export interface AssembleContextPackInput {
  readonly stage: string | null;
  readonly budgetTokens: number;
  readonly tier0: readonly Tier0Document[];
  readonly candidates: readonly RetrievalCandidate[];
  /** Paths the task is known to touch — from the plan or the diff (technical/07 step 1). */
  readonly touchedPaths: readonly string[];
  /**
   * Every path in the repository at HEAD.
   *
   * Required, and required to be the *whole* listing: validate-on-read drops a document whose
   * cited paths have vanished, so a caller that could omit this would silently get a pack in which
   * nothing was validated while `validated: true` claimed otherwise (rule 18). A caller that
   * cannot produce a listing must not build a pack.
   */
  readonly repoPaths: readonly string[];
  /** Today, for the soft-expiry demotion. `IsoDate` so the function stays pure (no clock). */
  readonly today: IsoDate;
  readonly kbCommit: string | null;
}

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

const statusWeight = (status: RetrievalCandidate['status']): number =>
  // `deprecated` is filtered out before this is reached; the branch exists so that a future caller
  // that stops filtering gets a demotion rather than a full-strength deprecated page.
  status === 'deprecated' ? KB_CONFIDENCE_WEIGHTS.contested : 1;

export interface CandidateScore {
  readonly score: number;
  readonly reason: Tier1Reason;
  /** The touched paths that made it relevant; empty for a text-only match. */
  readonly matchedPaths: readonly string[];
}

/**
 * Steps 1 and 2 for one candidate.
 *
 * A path match wins outright at 1.0 — technical/07 is explicit, and the reason it is not multiplied
 * by the same boosts is that a `paths:` glob is an *author's* statement that this document applies
 * to these files, which is stronger evidence than any lexical rank.
 */
export const scoreCandidate = (
  candidate: RetrievalCandidate,
  input: Pick<AssembleContextPackInput, 'stage' | 'touchedPaths' | 'today'>,
): CandidateScore | null => {
  const matchedPaths = matchingRepoPaths(candidate.paths, input.touchedPaths);
  if (matchedPaths.length > 0) return { score: 1, reason: 'paths', matchedPaths };
  if (candidate.textRank === null) return null;

  const weights = EMPHASIS_LAYER_WEIGHTS[emphasisFor(input.stage)];
  const expired = candidate.expires !== null && candidate.expires < input.today;
  const score =
    clampUnit(candidate.textRank) *
    weights[candidate.layer] *
    kbConfidenceWeight(candidate.confidence) *
    statusWeight(candidate.status) *
    (expired ? EXPIRED_WEIGHT : 1);
  return { score: clampUnit(score), reason: 'trigger', matchedPaths: [] };
};

const inScope = (scope: KbScope | null, stage: string | null): boolean => {
  if (scope === null || scope === 'project') return true;
  return stage !== null && scope === `stage:${stage}`;
};

/**
 * technical/07 step 3. A document that cites no paths has nothing to validate and is `true`; one
 * that cites paths is `false` unless at least one of its globs still resolves against HEAD.
 */
export const validateAgainstHead = (
  candidate: RetrievalCandidate,
  repoPaths: readonly string[],
): boolean =>
  candidate.paths.length === 0 || matchingRepoPaths(candidate.paths, repoPaths).length > 0;

export const assembleContextPack = (input: AssembleContextPackInput): ContextPackAssembly => {
  const tier0Tokens = input.tier0.reduce((total, document) => total + document.tokens, 0);
  const overBudget = tier0Tokens > input.budgetTokens;

  const droppedByScope: string[] = [];
  const droppedAsDeprecated: string[] = [];
  const droppedByValidation: string[] = [];
  const droppedForBudget: string[] = [];
  const droppedForCount: string[] = [];

  const scored = input.candidates
    .filter((candidate) => {
      if (!inScope(candidate.scope, input.stage)) {
        droppedByScope.push(candidate.path);
        return false;
      }
      if (candidate.status === 'deprecated') {
        // product/05 deprecates rather than deleting, and a deprecated page stays reachable through
        // `kb_search`; what it must not do is arrive unasked in a prompt as current guidance.
        droppedAsDeprecated.push(candidate.path);
        return false;
      }
      return true;
    })
    .flatMap((candidate) => {
      const scoring = scoreCandidate(candidate, input);
      return scoring === null ? [] : [{ candidate, scoring }];
    })
    .sort((left, right) =>
      right.scoring.score === left.scoring.score
        ? left.candidate.path.localeCompare(right.candidate.path)
        : right.scoring.score - left.scoring.score,
    );

  const tier1Record: ContextPackRecord['tier1'] = [];
  const admitted: SelectedDocument[] = [];
  let spent = tier0Tokens;

  for (const { candidate, scoring } of scored) {
    const validated = validateAgainstHead(candidate, input.repoPaths);
    if (!validated) {
      droppedByValidation.push(candidate.path);
      tier1Record.push({
        path: candidate.path,
        reason: scoring.reason,
        score: scoring.score,
        tokens: candidate.tokens,
        validated: false,
      });
      continue;
    }
    if (admitted.length >= MAX_TIER1_DOCUMENTS) {
      droppedForCount.push(candidate.path);
      continue;
    }
    if (overBudget || spent + candidate.tokens > input.budgetTokens) {
      droppedForBudget.push(candidate.path);
      continue;
    }
    spent += candidate.tokens;
    admitted.push({
      tier: 1,
      path: candidate.path,
      tokens: candidate.tokens,
      reason: scoring.reason,
    });
    tier1Record.push({
      path: candidate.path,
      reason: scoring.reason,
      score: scoring.score,
      tokens: candidate.tokens,
      validated: true,
    });
  }

  return {
    record: {
      tier0: input.tier0.map((document) => ({ path: document.path, tokens: document.tokens })),
      tier1: tier1Record,
      budget_tokens: input.budgetTokens,
      total_tokens: spent,
      kb_commit: input.kbCommit,
    },
    documents: [
      ...input.tier0.map(
        (document): SelectedDocument => ({
          tier: 0,
          path: document.path,
          tokens: document.tokens,
          reason: document.reason,
        }),
      ),
      ...admitted,
    ],
    outcome: overBudget ? 'tier0_over_budget' : 'within_budget',
    droppedForBudget,
    droppedForCount,
    droppedByValidation,
    droppedByScope,
    droppedAsDeprecated,
  };
};
