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

/**
 * **What a returned stage is told** when an agent verdict sent the task back (WP-55, the agent half
 * of PROGRESS backlog 159).
 *
 * The interpreter is pure and never sees the artifact, so its return reason for `request_changes`
 * is the literal `requested changes` — which is what the `return_feedback` block carried on every
 * review return, the pipeline's main correction loop. This builds the reason from the verdict's
 * **own findings**, where the verdict is at hand: the saga's `step`, which reads the stage's latest
 * artifact after `interpret` and before `applyDecision` records the return. `null` for anything
 * that is not a verdict with findings to state, and the caller keeps the interpreter's words.
 *
 * - `ReviewVerdict`: `[summary] <summary>`, then one line per finding — `[severity] file:line — explanation`
 *   — blockers and majors first, in the reviewer's order within a severity.
 * - `AcceptanceVerdict`: each criterion that is `not_met` with its evidence, then `missing` and
 *   `scope_creep` entries.
 *
 * **One finding is one line, and the model cannot forge a line.** Every model-written field is
 * placed with its line separators — `\r`, `\n`, U+0085, U+2028, U+2029, vertical tab, form feed —
 * collapsed to a space, so a finding whose explanation carries `\n[blocker] src/x.ts:1 — …` stays
 * on its own line with that text inside it; every line therefore begins with a tag the platform
 * wrote — `[summary]`, `[<severity>]`, `[not met]`, `[missing]`, `[scope creep]` — and the summary
 * is tagged for exactly that reason: untagged, it is a first line the model chooses in full.
 *
 * **No cut here.** The only cut is the assembler's: `return_feedback` is capped at
 * `MAX_FEEDBACK_CHARS` and a cut is announced as `truncated="true"` on the block's marker, never as
 * a line in the body (technical/04, technical/07's forgeable-marker requirement) — which a notice
 * written here would have been, and which the model could have written itself. Blockers-first
 * ordering is what keeps the blockers inside that cut.
 *
 * **Stored unbounded, and why that is not a new unbounded store**: the reason is a projection of
 * the artifact row it is read from, which is stored whole; every reader bounds it at its own
 * consumer — the prompt (above), `get_task_context` (its per-answer cap) — and the task-detail DTO
 * does not publish `return_reason` at all. The `task.stage.returned` event carries a second copy of
 * the same size; that residual is stated, not bounded here.
 *
 * **Redaction**: the input is the *stored* artifact `data`, which every writer redacts before the
 * insert (TD-012, WP-52 — `StoredArtifact.data`), so nothing here re-reads unredacted model output.
 */
// `\v` and `\f` are vertical tab and form feed, spelled as escapes (biome refuses `\u000b`).
const LINE_SEPARATORS = /[\r\n\v\f\u0085\u2028\u2029]+/g;

/** One model-written field, on one line. */
const oneLine = (value: JsonValue | undefined): string =>
  String(value ?? '').replaceAll(LINE_SEPARATORS, ' ');

const SEVERITY_ORDER: Readonly<Record<string, number>> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

const joined = (head: string | null, items: readonly string[]): string | null => {
  const text = [...(head === null ? [] : [head]), ...items].join('\n').trim();
  return text.length === 0 ? null : text;
};

const record = (data: JsonValue | null): Record<string, JsonValue | undefined> | null =>
  typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, JsonValue | undefined>)
    : null;

const strings = (value: JsonValue | undefined): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

export const verdictReturnReason = (
  artifactType: ArtifactType | null,
  data: JsonValue | null,
): string | null => {
  const body = record(data);
  if (body === null) {
    return null;
  }
  if (artifactType === 'ReviewVerdict') {
    const findings = (Array.isArray(body.findings) ? body.findings : [])
      .map(record)
      .filter((entry): entry is Record<string, JsonValue | undefined> => entry !== null)
      .map((entry, index) => ({ entry, index }))
      .sort(
        (a, b) =>
          (SEVERITY_ORDER[String(a.entry.severity)] ?? 4) -
            (SEVERITY_ORDER[String(b.entry.severity)] ?? 4) || a.index - b.index,
      )
      .map(({ entry }) => {
        const where =
          typeof entry.file === 'string'
            ? ` ${oneLine(entry.file)}${typeof entry.line === 'number' ? `:${String(entry.line)}` : ''}`
            : '';
        return `[${oneLine(entry.severity ?? 'finding')}]${where} — ${oneLine(entry.explanation)}`;
      });
    const summary = typeof body.summary === 'string' ? `[summary] ${oneLine(body.summary)}` : null;
    return joined(summary, findings);
  }
  if (artifactType === 'AcceptanceVerdict') {
    const unmet = (Array.isArray(body.criteria) ? body.criteria : [])
      .map(record)
      .filter((entry) => entry !== null && entry.status === 'not_met')
      .map((entry) => `[not met] ${oneLine(entry?.id)} — ${oneLine(entry?.evidence)}`);
    return joined(null, [
      ...unmet,
      ...strings(body.missing).map((entry) => `[missing] ${oneLine(entry)}`),
      ...strings(body.scope_creep).map((entry) => `[scope creep] ${oneLine(entry)}`),
    ]);
  }
  return null;
};
