/**
 * How a stage's *artifact* becomes the *verdict* the interpreter transitions on.
 *
 * technical/12: "Verdict fields drive transitions; the platform never parses markdown to decide."
 * So the verdict is read from the structured `data` of the artifact the stage produced, and from
 * nowhere else — not from the model's prose, not from the run's exit code.
 *
 * ## Why this does not read a field the model can omit (standing rule 16)
 *
 * The rule that matters is: **the artifact type decides whether there is a verdict field, and the
 * template declares the artifact type.** A `ReviewVerdict` has a required `verdict` — an artifact
 * missing it does not validate and never becomes an artifact at all — so `approve` here is always
 * a value the model wrote on purpose. An `ImplementationPlan` has no verdict field by design;
 * for those stages the verdict is "the stage produced the artifact its template asked for", which
 * is a fact about the *platform's* validation and not about a field the model chose to fill in.
 *
 * The one place the model does get to choose a branch is `RefinedSpec.decision`
 * (`proceed | ask | reject`, technical/12) and `RootCauseAnalysis.confidence`, and both are
 * required fields of their schemas for exactly that reason.
 */
import type { ArtifactType, JsonValue, StageVerdict } from '@platform/contracts';

/** What `stageVerdict` needs to know about the run that produced the artifact. */
export interface VerdictInput {
  readonly artifactType: ArtifactType | null;
  /** The validated artifact `data`, or null when the stage produces no artifact. */
  readonly data: JsonValue | null;
  /**
   * product/04 S1b: a `low`-confidence root cause "asks for more evidence (question) instead of
   * proceeding, **unless the project policy says 'attempt anyway'**".
   */
  readonly attemptOnLowConfidence: boolean;
}

const field = (data: JsonValue | null, key: string): string | null => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const value = (data as Record<string, JsonValue | undefined>)[key];
  return typeof value === 'string' ? value : null;
};

/**
 * The verdict of a completed agent stage, or `null` when the artifact does not say.
 *
 * `null` is not "approve": the caller escalates on it, which is what makes an artifact whose
 * `verdict` field carries something the platform does not recognise a stop rather than a guess.
 */
export const stageVerdict = (input: VerdictInput): StageVerdict | null => {
  switch (input.artifactType) {
    case 'ReviewVerdict':
    case 'AcceptanceVerdict': {
      const verdict = field(input.data, 'verdict');
      return verdict === 'approve' || verdict === 'request_changes' ? verdict : null;
    }
    case 'RefinedSpec': {
      switch (field(input.data, 'decision')) {
        case 'proceed':
          return 'approve';
        case 'ask':
          return 'questions';
        case 'reject':
          return 'reject';
        default:
          return null;
      }
    }
    case 'RootCauseAnalysis': {
      const confidence = field(input.data, 'confidence');
      if (confidence === null) {
        return null;
      }
      return confidence === 'low' && !input.attemptOnLowConfidence ? 'questions' : 'approve';
    }
    default:
      // Every other artifact type — and a stage that produces none — has no verdict channel. The
      // stage produced what its template asked for, and that is the approval.
      return 'approve';
  }
};

/** Longest unrecognised verdict the platform repeats back; model output is unbounded (BD-022). */
export const MAX_RAW_VERDICT_CHARS = 64;

/**
 * What the artifact *said* when {@link stageVerdict} could not map it.
 *
 * The pipeline escalates either way, and the difference is only in what the human is told: "its
 * verdict was missing" is wrong and confusing when the model actually wrote `"decision": "ship it"`.
 * The value is untrusted model output, so it is capped before it reaches an event payload.
 */
export const rawVerdict = (input: VerdictInput): string | null => {
  const value =
    input.artifactType === 'RefinedSpec'
      ? field(input.data, 'decision')
      : input.artifactType === 'RootCauseAnalysis'
        ? field(input.data, 'confidence')
        : field(input.data, 'verdict');
  return value === null ? null : value.slice(0, MAX_RAW_VERDICT_CHARS);
};

/**
 * The questions an artifact asks, as `{text, blocking}` pairs.
 *
 * `RefinedSpec` and `RootCauseAnalysis` both carry `questions[]` (technical/12). Anything that is
 * not a well-formed question entry is dropped rather than guessed at: this is model output
 * (BD-022), and a malformed entry must not become a blocking question with an empty body.
 */
export interface ArtifactQuestionDraft {
  readonly text: string;
  readonly blocking: boolean;
  readonly options: readonly string[] | null;
}

export const artifactQuestions = (data: JsonValue | null): readonly ArtifactQuestionDraft[] => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return [];
  }
  const raw = (data as Record<string, JsonValue | undefined>).questions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const drafts: ArtifactQuestionDraft[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, JsonValue | undefined>;
    const text = record.text;
    if (typeof text !== 'string' || text.length === 0) {
      continue;
    }
    const options = record.options;
    drafts.push({
      text,
      // A question whose `blocking` flag is missing is treated as blocking: product/04 makes
      // questions a normal outcome and non-blocking ones the exception ("Non-blocking assumptions
      // are stated explicitly and proceed"), so the fail-closed reading is "wait for the human".
      blocking: record.blocking !== false,
      options: Array.isArray(options)
        ? options.filter((option): option is string => typeof option === 'string')
        : null,
    });
  }
  return drafts;
};

/**
 * A stable digest of what a stage decided, for convergence detection (product/04 S4 and S5).
 *
 * The digest has to be identical for two rounds that say the same thing and different otherwise,
 * so it is built from the *structured* fields — a review's finding ids and severities, a CI gate's
 * failing job names — and never from free text a model rewrites every round.
 */
export const roundSignature = (parts: readonly string[]): string => parts.slice().sort().join('|');

/** The finding signature of a `ReviewVerdict`, for `isRepeatOfPreviousRound`. */
export const reviewFindingSignature = (data: JsonValue | null): string => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return '';
  }
  const findings = (data as Record<string, JsonValue | undefined>).findings;
  if (!Array.isArray(findings)) {
    return '';
  }
  const parts: string[] = [];
  for (const finding of findings) {
    if (typeof finding !== 'object' || finding === null || Array.isArray(finding)) {
      continue;
    }
    const record = finding as Record<string, JsonValue | undefined>;
    const id = typeof record.id === 'string' ? record.id : '?';
    const file = typeof record.file === 'string' ? record.file : '?';
    const severity = typeof record.severity === 'string' ? record.severity : '?';
    parts.push(`${severity}:${file}:${id}`);
  }
  return roundSignature(parts);
};
