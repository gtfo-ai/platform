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
