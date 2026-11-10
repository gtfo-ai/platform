/**
 * What a chat approval **says** (S-25.9, BD-006's 2026-11-06 amendment, TD-035 decisions 6 and 7):
 * the plan it is about, why it was asked, and the way to the task page — and, when a press is
 * refused, why nothing was approved.
 *
 * The task page words the same closed vocabulary in `apps/web` (`approval-text.ts`); the server may
 * not import web code, so this is its own small table, held to the vocabulary by
 * `approval-text.test.ts`, which enumerates the codes off the schema — a code added to
 * `approvalReasonSchema` and forgotten here fails there. Plain words, no decision or spec names:
 * the reader is a maintainer in a channel.
 *
 * ## Untrusted text (BD-022)
 *
 * The plan is model output: its approach, paths and risks are **redacted by the caller** (the
 * binding's redactor, before anything here cuts — WP-30's order), then bounded here, each item
 * collapsed to one line (a newline inside a risk would write a line that reads as the platform's),
 * and its markdown links unlabelled (`unlabelledLinks`, WP-65). The message is `markdown` only, so
 * the provider's converter neutralises mentions and broadcasts, as for every notification. A risk
 * class name is project configuration and is bounded the same way.
 *
 * **Links are unlabelled once more after every join** (review of PR #82). A link's label may span
 * a comma and a newline — the converter's pattern is `\[([^\]]*)\]\(…\)`, and `[^\]]` matches
 * both — so two items that are each harmless can make one when they are joined: the paths
 * `["[Approve safely", "](https://evil.example/approve)"]` became
 * `<https://evil.example/approve|Approve safely, >` beside the real Approve button. Per item is
 * therefore not enough; every body this module builds is passed through `unlabelledLinks` whole,
 * after the join, which no platform line is affected by (none contains `[…](…)`).
 *
 * Pure and total: no clock, no I/O, no provider.
 */
import {
  type ApprovalKind,
  type ApprovalReason,
  type ImplementationPlanData,
  implementationPlanDataSchema,
  type JsonValue,
  type RiskFactor,
} from '@platform/contracts';
import type { ApprovalSubjectRefusal } from '../pipeline/commands.js';
import type { MessageBody } from '../ports/integrations/communication.js';
import {
  boundText,
  boundUrl,
  NOTIFICATION_KEY_MAX,
  NOTIFICATION_TITLE_MAX,
  type NotificationDraft,
  unlabelledLinks,
} from './render.js';

/** The caps on the plan's own words, chosen so the whole message stays well under one section. */
export const APPROVAL_PLAN_APPROACH_MAX = 280;
export const APPROVAL_PLAN_PATH_MAX = 100;
export const APPROVAL_PLAN_FILES_SHOWN = 6;
export const APPROVAL_PLAN_RISK_MAX = 160;
export const APPROVAL_PLAN_RISKS_SHOWN = 3;
/** A risk class name inside a reason: a short configured label, not a paragraph. */
export const APPROVAL_RISK_CLASS_MAX = 48;

/** One untrusted item, as one bounded line with its links unlabelled. */
const oneLine = (value: string, max: number): string =>
  boundText(unlabelledLinks(value.replace(/\s+/g, ' ').trim()), max);

const usd = (value: number): string => `$${value.toFixed(2)}`;

const listOf = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * What each risk factor means, as the end of a sentence that starts *"The plan …"* (S-28.8). The
 * task page words the same factors in `apps/web` (`approval-text.ts`).
 */
export const RISK_FACTOR_WORDS: Readonly<Record<RiskFactor, string>> = {
  schema_migration: 'touches database migrations or stored data',
  auth_security: 'touches sign-in, permissions or security code',
  payments: 'touches payments or billing',
  public_api: 'changes a public API',
  infra_ci: 'changes CI, deployment or infrastructure',
  data_deletion: 'deletes data',
  many_files: 'changes many files',
  unclear_requirements: 'rests on requirements that are not clear yet',
  new_dependency: 'adds or changes a dependency',
  other: 'has another risk the agent named',
  protected_paths: 'changes protected files (tests, CI or agent configuration)',
  split_proposed: 'proposes splitting the ticket',
};

/** Why an approval was asked, one sentence per reason (TD-035 decision 1's vocabulary). */
export const approvalReasonWords = (reason: ApprovalReason): string => {
  switch (reason.code) {
    case 'risk_class': {
      const classes = reason.classes.map((name) => oneLine(name, APPROVAL_RISK_CLASS_MAX));
      // Unlabelled after the join too: two class names can make one link between them.
      return unlabelledLinks(
        classes.length === 1
          ? `The plan touches the ${classes[0]} risk class, and this project asks a person to approve plans that do.`
          : `The plan touches the ${listOf(classes)} risk classes, and this project asks a person to approve plans that do.`,
      );
    }
    case 'probation':
      return `The project is on probation: ${reason.completed} of its first ${reason.of} tasks are done.`;
    case 'policy_always':
      return reason.source === 'stage_override'
        ? 'This stage’s setting in the repository configuration asks a person to approve every plan.'
        : 'This project’s autonomy dial asks a person to approve every plan.';
    case 'size_at_or_above':
      return reason.source === 'stage_override'
        ? `The plan’s size is ${reason.size}, at or above the threshold of ${reason.threshold} this stage’s setting asks at.`
        : `The plan’s size is ${reason.size}, at or above the project’s threshold of ${reason.threshold}.`;
    case 'estimate_above_threshold':
      return `The estimate, ${usd(reason.estimate_usd)}, is above this project’s threshold of ${usd(reason.threshold_usd)}.`;
    // S-28.8: the project's low-risk rule. Who found a factor is said, because a platform finding
    // cannot be argued away and the agent's own is the agent's word.
    case 'risk_factor':
      return `The plan ${listOf(reason.factors.map((factor) => RISK_FACTOR_WORDS[factor]))} (${
        reason.source === 'platform' ? 'found by the platform' : 'the agent’s own assessment'
      }).`;
    case 'confidence_below':
      return `The agent’s confidence in the plan is ${reason.confidence}; this project lets a plan go ahead without approval only at ${reason.minimum === 'high' ? 'high' : 'medium or high'} confidence.`;
    case 'risk_level_above':
      return `The agent rates the plan’s risk ${reason.risk_level}; this project lets a plan go ahead without approval only at ${reason.maximum === 'low' ? 'low' : 'low or medium'} risk.`;
    case 'size_above':
      return `The plan’s size is ${reason.size}, above the largest size (${reason.maximum}) this project lets go ahead without approval.`;
    case 'open_questions':
      return reason.count === 1
        ? 'The agent left one question open in the plan.'
        : `The agent left ${reason.count} questions open in the plan.`;
    case 'assessment_missing':
      return 'The plan does not say how sure the agent is or how risky it is, so this project’s low-risk rule cannot let it go ahead without approval.';
    case 'low_risk_auto':
      return `The plan went ahead without approval: ${reason.risk_level} risk, ${reason.confidence} confidence, size ${reason.size}, ${reason.files === 1 ? '1 file' : `${reason.files} files`}.`;
  }
};

/** Why a chat *Approve* approved nothing, one sentence per guard refusal (TD-035 decision 6). */
export const APPROVAL_REFUSAL_WORDS: Readonly<Record<ApprovalSubjectRefusal, string>> = {
  approval_subject_mismatch:
    'This button does not name the plan this approval is about — the message may be older than the plan it asks about — so nothing was approved.',
  approval_subject_superseded:
    'The plan this message showed is no longer the task’s latest plan, so nothing was approved. The newer plan is asked about on its own.',
  approval_subject_unrecorded:
    'This approval does not record which plan it is about, so it cannot be approved. Rejecting it asks for a fresh plan.',
};

/** The plan a message shows: what a maintainer needs to decide, already bounded. */
export interface ApprovalPlanSummary {
  readonly version: number;
  readonly size: string;
  readonly approach: string;
  readonly files: readonly string[];
  readonly fileCount: number;
  readonly risks: readonly string[];
  readonly riskCount: number;
}

/**
 * What the message can say about the plan. `shown` is the only state with an Approve: the others
 * are the subject the task page calls *not recorded*, a subject that is no longer the task's latest
 * plan, and a plan whose stored data does not read as a plan.
 */
export type ApprovalPlanView =
  | { readonly kind: 'shown'; readonly artifactId: string; readonly summary: ApprovalPlanSummary }
  | { readonly kind: 'unrecorded' | 'superseded' | 'unreadable' };

/**
 * The summary of a stored plan's data — **already redacted by the caller** — or `null` when the
 * data is not an `ImplementationPlan` (an older schema, a damaged row): a plan that cannot be read
 * is a plan the message cannot show, never one it guesses at.
 */
export const planSummaryOf = (version: number, data: JsonValue): ApprovalPlanSummary | null => {
  const parsed = implementationPlanDataSchema.safeParse(data);
  if (!parsed.success) {
    return null;
  }
  const plan: ImplementationPlanData = parsed.data;
  return {
    version,
    size: plan.estimated_size,
    approach: oneLine(plan.approach, APPROVAL_PLAN_APPROACH_MAX),
    files: plan.files_to_change
      .slice(0, APPROVAL_PLAN_FILES_SHOWN)
      .map((file) => oneLine(file.path, APPROVAL_PLAN_PATH_MAX)),
    fileCount: plan.files_to_change.length,
    risks: plan.risks
      .slice(0, APPROVAL_PLAN_RISKS_SHOWN)
      .map((risk) => oneLine(risk, APPROVAL_PLAN_RISK_MAX)),
    riskCount: plan.risks.length,
  };
};

const more = (shown: number, total: number): string =>
  total > shown ? ` (and ${total - shown} more)` : '';

const planLines = (view: ApprovalPlanView): string[] => {
  switch (view.kind) {
    case 'shown': {
      const plan = view.summary;
      return [
        `**Plan v${plan.version}** · size ${plan.size} · ${plan.fileCount} file${plan.fileCount === 1 ? '' : 's'} to change`,
        `Approach: ${plan.approach}`,
        ...(plan.files.length === 0
          ? []
          : [`Files: ${plan.files.join(', ')}${more(plan.files.length, plan.fileCount)}`]),
        ...(plan.risks.length === 0
          ? ['Risks: none named']
          : [
              `Risks${more(plan.risks.length, plan.riskCount)}:`,
              ...plan.risks.map((risk) => `- ${risk}`),
            ]),
      ];
    }
    case 'unrecorded':
      return [
        'The plan this approval is about was not recorded, so it cannot be approved here. Review it on the task page; Request changes is always allowed.',
      ];
    case 'superseded':
      return [
        'The plan this approval was asked about is no longer the task’s latest plan, so it cannot be approved here. Review it on the task page.',
      ];
    case 'unreadable':
      return [
        'The plan could not be read for this message, so it cannot be approved here. Review it on the task page.',
      ];
  }
};

const reasonLines = (reasons: readonly ApprovalReason[] | null): string[] =>
  reasons === null
    ? ['Why it was asked was not recorded.']
    : [
        'Asked because:',
        ...reasons.map((reason) => `- ${approvalReasonWords(reason)}`),
        'The task page says how to stop being asked for each reason.',
      ];

/** The line that points at the task page, or nothing when the link could not be built safely. */
const reviewLine = (kind: ApprovalKind, url: string | null): string[] => {
  const link = boundUrl(url);
  if (link === null) {
    return [];
  }
  return [
    `${kind === 'plan' ? 'Review the plan' : kind === 'budget' ? 'Review the budget' : 'Review it'} on the task page: ${link}`,
  ];
};

/**
 * The approval request message (S-25.9): the notification's own title and detail, then the plan
 * (for a plan approval), the reasons in words, the task page, and the ticket's link last.
 *
 * `markdown` only, for {@link notificationBody}'s reason: the provider escapes it. `note` is the
 * duty's own sentence for a binding that cannot receive a click.
 */
export const approvalRequestBody = (input: {
  readonly draft: NotificationDraft;
  readonly kind: ApprovalKind;
  /** The plan, for a plan approval; `null` for every other kind. */
  readonly plan: ApprovalPlanView | null;
  readonly reasons: readonly ApprovalReason[] | null;
  /** The task page, from the platform's own base URL; bounded here by `boundUrl`. */
  readonly reviewUrl: string | null;
  readonly note?: string | null;
}): MessageBody => ({
  // The whole body, after the join (module note): a label may span the lines it was joined from.
  markdown: unlabelledLinks(
    [
      `**${input.draft.title}**`,
      ...(input.draft.detail === null ? [] : [input.draft.detail]),
      ...(input.note === undefined || input.note === null ? [] : [input.note]),
      ...(input.plan === null ? [] : planLines(input.plan)),
      ...reasonLines(input.reasons),
      ...reviewLine(input.kind, input.reviewUrl),
      ...(input.draft.url === null ? [] : [input.draft.url]),
    ].join('\n'),
  ),
});

/**
 * The answer in the approval's thread when a press was refused for its subject (S-25.9): what
 * happened, why, and the task page. Platform words only — the code is closed and the subject name
 * is the ticket key, bounded here like every notification's.
 */
export const approvalRefusalBody = (input: {
  /** The ticket key, already redacted. */
  readonly name: string;
  /** The approval's kind, for the link's verb. */
  readonly kind: ApprovalKind;
  readonly refusal: ApprovalSubjectRefusal;
  readonly reviewUrl: string | null;
}): MessageBody => {
  const name = boundText(unlabelledLinks(input.name), NOTIFICATION_KEY_MAX);
  return {
    markdown: unlabelledLinks(
      [
        `**${boundText(`${name}: the approval was not applied`, NOTIFICATION_TITLE_MAX)}**`,
        APPROVAL_REFUSAL_WORDS[input.refusal],
        ...reviewLine(input.kind, input.reviewUrl),
      ].join('\n'),
    ),
  };
};

/** The task page's URL, from the platform's own base URL — never a provider's text. */
export const taskPageUrl = (baseUrl: string, taskId: string): string | null =>
  boundUrl(`${baseUrl.replace(/\/+$/, '')}/tasks/${taskId}`);
