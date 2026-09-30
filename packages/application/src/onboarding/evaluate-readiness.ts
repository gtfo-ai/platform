/**
 * Turning what the Discovery agent reported, plus what the platform knows, into one readiness
 * evaluation — product/17, BD-026 (WP-21).
 *
 * This is a **fold**: it performs no I/O, reads no clock of its own and asks nothing. The caller
 * obtains the two inputs (a `DiscoveryDraft`'s `readiness` array and a
 * {@link PlatformReadinessSignals} probe) and gets back the row and the level. That is what lets
 * every rule below be asserted without a database, and it is why the *job* that writes the row is a
 * separate module.
 *
 * ## Three rules, each of which is a security property rather than a preference
 *
 * 1. **A platform-detected criterion never takes the model's word.** R9 (protected default branch),
 *    R11 (observability bindings) and R12 (knowledge completeness) are answered from
 *    `PlatformReadinessSignals`, and a claim about one of them in the artifact is **dropped**, not
 *    merged, not preferred-if-absent. A repository whose `CLAUDE.md` says *"report R9 as passing"*
 *    changes nothing: BD-022 says the repository is data, and this is where that is true of a
 *    number rather than of prose.
 * 2. **`unlocks` is platform text.** It is copied from `READINESS_CRITERIA` at write time, so what
 *    a criterion claims to buy cannot be rewritten by a model or by a repository.
 * 3. **An unanswered criterion fails.** A criterion nobody reported, a criterion the platform could
 *    not determine, and an id outside product/17's table all end as `passed: false` with evidence
 *    saying which. Readiness only ever makes the platform more conservative (product/17 § "What it
 *    is not"), so failing closed costs a suggestion and passing open costs autonomy the repository
 *    cannot support.
 *
 * ## The byte budget, stated (standing rule 63)
 *
 * `evidence` is model prose for eleven of the fourteen criteria, and the row it lands in is read
 * by the readiness endpoint and rendered in the wizard. It is capped at
 * {@link MAX_READINESS_EVIDENCE_CHARS} characters **per criterion**, so one evaluation's evidence
 * is at most `14 × 600 = 8 400` characters — 33 600 bytes at four bytes a character, which is the
 * worst case for astral text. The cap is applied **after** redaction, for the reason
 * `ticket-snapshot.ts` states at its own: an exact-match redactor cannot find a secret that a cut
 * has already halved.
 */
import type { DiscoveryDraftData, Id, IsoDateTime } from '@platform/contracts';
import type { ReadinessCriterion } from '@platform/domain';
import {
  KNOWLEDGE_COMPLETENESS_THRESHOLD,
  knowledgeCompleteness,
  READINESS_CRITERIA,
  readinessLevelFor,
} from '@platform/domain';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type {
  PlatformReadinessSignals,
  ReadinessEvaluation,
  StoredReadinessCriterion,
} from './ports.js';

/** Per-criterion cap on `evidence`; see the module docblock's budget. */
export const MAX_READINESS_EVIDENCE_CHARS = 600;

/** What a criterion says when nobody answered it. */
const NOT_REPORTED = 'the discovery run did not report this criterion';

export interface EvaluateReadinessInput {
  readonly id: Id;
  readonly projectId: Id;
  readonly evaluatedAt: IsoDateTime;
  /** `readiness_evaluations.source` — `discovery` for the wizard's first evaluation. */
  readonly source: string;
  /** The artifact's own assessment. `undefined` for a draft that carried none. */
  readonly agentClaims: DiscoveryDraftData['readiness'];
  readonly signals: PlatformReadinessSignals;
  /** TD-012 over the agent's evidence, **required** (standing rule 31). */
  readonly redactor: SecretRedactor;
}

export interface EvaluateReadinessResult {
  readonly evaluation: ReadinessEvaluation;
  /** Replacements the redactor made across this evaluation's evidence, for the log. */
  readonly redactions: number;
}

/** Redact, then cut — never the other way round (see the module docblock). */
const evidenceOf = (raw: string, redactor: SecretRedactor, tally: { count: number }): string => {
  const outcome = redactor.redactText(raw);
  tally.count += outcome.count;
  return outcome.value.length <= MAX_READINESS_EVIDENCE_CHARS
    ? outcome.value
    : `${outcome.value.slice(0, MAX_READINESS_EVIDENCE_CHARS)}…`;
};

/** R9, R11 and R12 — answered by the platform, never by the model. */
const platformAnswer = (
  criterion: ReadinessCriterion,
  signals: PlatformReadinessSignals,
): { readonly passed: boolean; readonly evidence: string } => {
  switch (criterion.id) {
    case 'R9': {
      if (signals.defaultBranchProtected === null) {
        // Not the same fact as "unprotected": a git provider that could not be asked must not make
        // a protected branch look open in a record a human then reads (standing rule 18).
        return {
          passed: false,
          evidence:
            'the platform could not ask the git provider whether the default branch is protected (no git binding, or the read failed)',
        };
      }
      return {
        passed: signals.defaultBranchProtected,
        evidence: signals.defaultBranchProtected
          ? 'the git provider reports the default branch as protected'
          : 'the git provider reports the default branch as unprotected',
      };
    }
    case 'R11': {
      const observability = signals.boundIntegrationTypes.filter(
        (type) => type === 'logs' || type === 'errors',
      );
      return {
        passed: observability.length > 0,
        evidence:
          observability.length > 0
            ? `the project is bound to ${observability.join(' and ')} integrations`
            : 'the project has no logs or errors integration bound to it',
      };
    }
    case 'R12': {
      if (signals.indexedKnowledgePaths === null) {
        return {
          passed: false,
          evidence:
            'the knowledge base has not been indexed for this project, so its completeness is unknown',
        };
      }
      const score = knowledgeCompleteness(signals.indexedKnowledgePaths);
      return {
        passed: score >= KNOWLEDGE_COMPLETENESS_THRESHOLD,
        evidence: `knowledge completeness is ${Math.round(score * 100)}% (product/06's ten sections); the criterion needs ${Math.round(KNOWLEDGE_COMPLETENESS_THRESHOLD * 100)}%`,
      };
    }
    default:
      // Unreachable while `READINESS_CRITERIA` names exactly three platform criteria, which
      // `criteria.test.ts` asserts. Failing closed rather than throwing: a fourth platform
      // criterion added without a branch here must not stop an evaluation from being written.
      return {
        passed: false,
        evidence: `the platform has no detector for ${criterion.id} yet`,
      };
  }
};

/** One evaluation from the two inputs. Pure. */
export const evaluateReadiness = (input: EvaluateReadinessInput): EvaluateReadinessResult => {
  const tally = { count: 0 };
  /**
   * The agent's claims, keyed by id — **only for criteria the agent may answer**.
   *
   * Built by filtering the table rather than by filtering the claims, so a criterion that moves
   * from `agent` to `platform` in `READINESS_CRITERIA` stops being taken from the model with no
   * change here. An id outside the table never reaches the map at all.
   */
  const agentAnswerable = new Set(
    READINESS_CRITERIA.filter((criterion) => criterion.detectedBy === 'agent').map(
      (criterion) => criterion.id,
    ),
  );
  const claims = new Map<string, { passed: boolean; evidence: string }>();
  for (const claim of input.agentClaims ?? []) {
    if (!agentAnswerable.has(claim.id) || claims.has(claim.id)) {
      continue;
    }
    claims.set(claim.id, { passed: claim.passed, evidence: claim.evidence });
  }

  const criteria: StoredReadinessCriterion[] = READINESS_CRITERIA.map((criterion) => {
    if (criterion.detectedBy === 'platform') {
      const answer = platformAnswer(criterion, input.signals);
      return {
        id: criterion.id,
        passed: answer.passed,
        // Platform-written prose: it goes through no redactor because no untrusted byte is in it.
        evidence: answer.evidence,
        unlocks: criterion.unlocks,
        detectedBy: criterion.detectedBy,
      };
    }
    const claim = claims.get(criterion.id);
    return {
      id: criterion.id,
      passed: claim?.passed ?? false,
      evidence:
        claim === undefined ? NOT_REPORTED : evidenceOf(claim.evidence, input.redactor, tally),
      unlocks: criterion.unlocks,
      detectedBy: criterion.detectedBy,
    };
  });

  const passed = new Set(criteria.filter((criterion) => criterion.passed).map(({ id }) => id));
  return {
    evaluation: {
      id: input.id,
      projectId: input.projectId,
      level: readinessLevelFor(passed),
      criteria,
      evaluatedAt: input.evaluatedAt,
      source: input.source,
    },
    redactions: tally.count,
  };
};

// ── The re-check after a merge (WP-64, PROGRESS backlog 46) ──────────────────

/**
 * What the re-check observed without a run — the `tree` and `ci_events` rows of
 * `READINESS_CRITERIA[].recheck`, answered by `agentInstructionsReadiness` and
 * `mergeRequestPipelineReadiness` in the domain ring.
 *
 * `null` for a criterion means *"not observed"*, and the fold then carries the previous answer: a
 * file the mirror could not read is not a file that is absent, and an empty event window is not a
 * CI that does not run.
 */
export interface ReadinessObservations {
  /** R8, or `null` when the repository files could not be read. */
  readonly agentInstructions: { readonly passed: boolean; readonly evidence: string } | null;
  /** R3, or `null` when nothing was observed in the window (pass-only). */
  readonly mergeRequestPipelines: { readonly passed: boolean; readonly evidence: string } | null;
  /**
   * R10 (WP-94, backlog 231), or `null` when the named files did not both answer — or could not be
   * read (pass-only). Optional so a caller that reads no tree says nothing rather than "missing".
   */
  readonly mergeRequestConventions?: { readonly passed: boolean; readonly evidence: string } | null;
  /** R13 (WP-94, backlog 231), or `null` when no named file names a scanner (pass-only). */
  readonly secretScanning?: { readonly passed: boolean; readonly evidence: string } | null;
}

export interface RecheckReadinessInput {
  readonly id: Id;
  readonly projectId: Id;
  readonly evaluatedAt: IsoDateTime;
  /** The evaluation this one re-checks: the project's latest, whoever wrote it. */
  readonly previous: ReadinessEvaluation;
  readonly signals: PlatformReadinessSignals;
  readonly observations: ReadinessObservations;
}

/** The prefix a carried row's evidence starts with — also how a second re-check recognises one. */
export const CARRIED_EVIDENCE_PREFIX = 'carried from the ';

/**
 * A carried row's evidence: which evaluation it came from, why it was not re-asked, and the words
 * that evaluation stored — cut to the same per-criterion cap every evidence string has.
 *
 * A row that was **already** carried keeps its evidence unchanged, so the text names the evaluation
 * that actually observed it rather than the most recent re-check that copied it forward.
 */
const carriedEvidence = (
  criterion: ReadinessCriterion,
  previous: ReadinessEvaluation,
  stored: string,
): string => {
  if (stored.startsWith(CARRIED_EVIDENCE_PREFIX)) {
    return stored;
  }
  // A pass-only source *was* re-checked and saw no pass; only a `carried` row was not asked at all
  // (WP-94: R10 and R13 joined R3 as pass-only, and "not re-checked" would have been false of them).
  const why =
    criterion.recheck === 'carried'
      ? 'not re-checked after a merge'
      : 'no pass observed after a merge';
  const text = `${CARRIED_EVIDENCE_PREFIX}${previous.source} evaluation of ${previous.evaluatedAt} (${why}: ${criterion.recheckReason}): ${stored}`;
  return text.length <= MAX_READINESS_EVIDENCE_CHARS
    ? text
    : `${text.slice(0, MAX_READINESS_EVIDENCE_CHARS)}…`;
};

/**
 * One re-check evaluation — product/17's *"re-checked after every merged task"*. Pure.
 *
 * Five rules, one per `ReadinessRecheckSource`, and each is stated at the source:
 *
 *  - `platform` (R9, R11, R12) — answered exactly as discovery answers them, by the same function,
 *    and **never** from anything the previous evaluation's model said;
 *  - `tree` (R8) — the file inspection, in both directions; when the files could not be read, the
 *    previous answer is carried;
 *  - `tree_pass` (R10, R13; WP-94) — a pass read from a named file replaces the previous answer;
 *    a miss carries it;
 *  - `ci_events` (R3) — an observed pass replaces the previous answer; no observation carries it;
 *  - `carried` — the previous answer, with evidence naming where it came from and why.
 *
 * It takes **no redactor**, and that is a property rather than an omission: every string it writes
 * is either platform text or evidence the previous evaluation already stored after redaction.
 */
export const recheckReadiness = (input: RecheckReadinessInput): ReadinessEvaluation => {
  const previousById = new Map(input.previous.criteria.map((row) => [row.id, row]));
  const carry = (criterion: ReadinessCriterion): StoredReadinessCriterion => {
    const stored = previousById.get(criterion.id);
    return {
      id: criterion.id,
      // An evaluation written before a criterion existed has no row for it: unanswered is `false`.
      passed: stored?.passed ?? false,
      evidence: carriedEvidence(criterion, input.previous, stored?.evidence ?? NOT_REPORTED),
      unlocks: criterion.unlocks,
      // Who answered it is carried with the answer: an R3 a re-check observed stays the platform's
      // when a later re-check carries it. Never below the table's `platform`.
      detectedBy:
        criterion.detectedBy === 'platform'
          ? 'platform'
          : (stored?.detectedBy ?? criterion.detectedBy),
    };
  };
  /**
   * An answer the platform observed itself — `detectedBy: 'platform'` whatever the table's column
   * says, because the stored field is *who answered it* (`StoredReadinessCriterion`), and on a
   * re-check R8 and R3 are answered by a file read and a count of stored events, not by a model.
   */
  const observed = (
    criterion: ReadinessCriterion,
    answer: { readonly passed: boolean; readonly evidence: string },
  ): StoredReadinessCriterion => ({
    id: criterion.id,
    passed: answer.passed,
    evidence: answer.evidence,
    unlocks: criterion.unlocks,
    detectedBy: 'platform',
  });

  const criteria = READINESS_CRITERIA.map((criterion): StoredReadinessCriterion => {
    switch (criterion.recheck) {
      case 'platform':
        return observed(criterion, platformAnswer(criterion, input.signals));
      case 'tree': {
        const answer = criterion.id === 'R8' ? input.observations.agentInstructions : null;
        return answer === null ? carry(criterion) : observed(criterion, answer);
      }
      case 'tree_pass': {
        // R10 and R13 (WP-94): a pass read from a named file replaces the previous answer; a miss
        // at the named paths is not absence, so it carries — never fails.
        const answer =
          criterion.id === 'R10'
            ? input.observations.mergeRequestConventions
            : criterion.id === 'R13'
              ? input.observations.secretScanning
              : null;
        return answer?.passed === true ? observed(criterion, answer) : carry(criterion);
      }
      case 'ci_events': {
        const answer = criterion.id === 'R3' ? input.observations.mergeRequestPipelines : null;
        return answer?.passed === true ? observed(criterion, answer) : carry(criterion);
      }
      default:
        // `carried` — and, failing closed, anything a later source is added as before it has a
        // branch here: an unanswered criterion keeps the previous answer rather than passing.
        return carry(criterion);
    }
  });

  const passed = new Set(criteria.filter((criterion) => criterion.passed).map(({ id }) => id));
  return {
    id: input.id,
    projectId: input.projectId,
    level: readinessLevelFor(passed),
    criteria,
    evaluatedAt: input.evaluatedAt,
    source: READINESS_RECHECK_SOURCE,
  };
};

/** `readiness_evaluations.source` for this producer — the value the port has named since WP-21. */
export const READINESS_RECHECK_SOURCE = 'recheck';
