/**
 * What an approval card **says** (S-25.1; BD-006's 2026-11-06 amendment; TD-035 decision 7): why it
 * was asked, what each answer does next, and — per reason — how to stop being asked for it.
 *
 * The reasons arrive as a closed vocabulary keyed by `code`, and **every word is written here**,
 * never by the server: a server sentence could be neither linked to the setting that retires it nor
 * kept in step with the screen. Each reason names the lever that retires it and the settings section
 * that holds the lever; the platform states the lever, it never pulls it. The intent is BD-006's:
 * approvals exist where trust is not yet earned, and should become rarer by a maintainer's visible
 * choice, so the card is where that trade-off is shown.
 *
 * Pure functions, so `approval-text.test.ts` holds every code to a sentence and a section — the set
 * is enumerated off the schema, so a code added to the vocabulary and forgotten here fails there.
 */
import type {
  ApprovalKind,
  ApprovalReason,
  ApprovalSubject,
  RiskFactor,
} from '@platform/contracts';
import { formatUsd } from '../ui/kit.js';

/** The project settings section that holds the lever a reason names. */
export type RetirementSection = 'policies' | 'repository';

export interface ReasonCopy {
  /** Why it was asked, as a sentence. */
  readonly why: string;
  /** How to stop being asked for this reason, as a sentence that names the lever. */
  readonly stop: string;
  /** Where the lever is: the project settings section, and the words for the link. */
  readonly section: RetirementSection;
  readonly link: string;
}

const listOf = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** The words for the low-risk rule's setting, where a reason's link points (S-28.8). */
const LOW_RISK_LINK = 'Low-risk plans';

/**
 * What each risk factor means, as the end of a sentence that starts *"The plan …"* (S-28.8). The
 * chat message words the same factors on the server (`notify/approval-text.ts`).
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

/** One reason, in words, with its lever (TD-035 decision 7). */
export const reasonCopy = (reason: ApprovalReason): ReasonCopy => {
  switch (reason.code) {
    case 'risk_class':
      return {
        why:
          reason.classes.length === 1
            ? `The plan touches ${reason.classes[0]}, an area this project marks as sensitive, and this project asks a person to approve plans that do.`
            : `The plan touches ${listOf(reason.classes)}, areas this project marks as sensitive, and this project asks a person to approve plans that do.`,
        stop: 'To stop being asked for this, change the plan-approval rule for sensitive areas in the project’s policies. Keeping it is recommended: a sensitive area is about the change, not about trust in the agents.',
        section: 'policies',
        link: 'Sensitive areas',
      };
    case 'probation': {
      const left = Math.max(0, reason.of - reason.completed);
      return {
        why: `This project’s first ${reason.of} tasks get extra checks, and ${reason.completed} of them are done.`,
        stop: `The extra checks end by themselves after ${reason.of} completed tasks (${left} to go), or a maintainer ends them under How much agents do alone.`,
        section: 'policies',
        link: 'How much agents do alone',
      };
    }
    case 'policy_always':
      return reason.source === 'stage_override'
        ? {
            why: 'This stage’s override in the repository configuration asks for every plan.',
            stop: 'To be asked less, change this stage’s plan-approval setting in the project’s repository configuration.',
            section: 'repository',
            link: 'Repository configuration',
          }
        : {
            why: 'This project’s How much agents do alone setting asks a person to approve every plan.',
            stop: 'To be asked less, set How much agents do alone to Supervised (large plans only) or Autonomous.',
            section: 'policies',
            link: 'How much agents do alone',
          };
    case 'size_at_or_above':
      return reason.source === 'stage_override'
        ? {
            why: `The plan’s size is ${reason.size}, at or above the threshold of ${reason.threshold} this stage’s override asks at.`,
            // The override asks, whether it set the threshold or only turned `above_size` on, so the
            // override is the lever — the dial's threshold alone would not stop it (review of PR #76).
            stop: 'To be asked less, raise this stage’s size threshold, or change its plan-approval setting, in the project’s repository configuration.',
            section: 'repository',
            link: 'Repository configuration',
          }
        : {
            why: `The plan’s size is ${reason.size}, at or above the project’s threshold of ${reason.threshold}.`,
            stop: 'To be asked less, raise the size threshold or How much agents do alone in the project’s policies.',
            section: 'policies',
            link: 'How much agents do alone',
          };
    case 'estimate_above_threshold':
      return {
        why: `The estimate, ${formatUsd(reason.estimate_usd)}, is above this project’s threshold of ${formatUsd(reason.threshold_usd)}.`,
        stop: 'To be asked less, set How much agents do alone to a position with a higher threshold, or none.',
        section: 'policies',
        link: 'How much agents do alone',
      };
    // S-28.8: the project's low-risk rule. Who found a factor is said, because a platform finding
    // cannot be argued away and the agent's own is the agent's word.
    case 'risk_factor':
      return {
        why: `The plan ${listOf(reason.factors.map((factor) => RISK_FACTOR_WORDS[factor]))} (${
          reason.source === 'platform' ? 'found by the platform' : 'the agent’s own assessment'
        }).`,
        stop: 'To be asked less, take these from the list of things that always wait for you under Low-risk plans. Keeping them is recommended.',
        section: 'policies',
        link: LOW_RISK_LINK,
      };
    case 'confidence_below':
      return {
        why: `The agent’s confidence in the plan is ${reason.confidence} (its own assessment); this project lets a plan go ahead only at ${reason.minimum === 'high' ? 'high' : 'medium or high'} confidence.`,
        stop: 'To be asked less, lower the confidence a plan needs under Low-risk plans.',
        section: 'policies',
        link: LOW_RISK_LINK,
      };
    case 'risk_level_above':
      return {
        why: `The agent rates the plan’s risk ${reason.risk_level} (its own assessment); this project lets a plan go ahead only at ${reason.maximum === 'low' ? 'low' : 'low or medium'} risk.`,
        stop: 'To be asked less, raise the risk a plan may have under Low-risk plans.',
        section: 'policies',
        link: LOW_RISK_LINK,
      };
    case 'size_above':
      return {
        why: `The plan’s size is ${reason.size}, above the largest size (${reason.maximum}) this project lets go ahead without approval.`,
        stop: 'To be asked less, raise the largest size under Low-risk plans.',
        section: 'policies',
        link: LOW_RISK_LINK,
      };
    case 'open_questions':
      return {
        why:
          reason.count === 1
            ? 'The agent left one question open in the plan.'
            : `The agent left ${reason.count} questions open in the plan.`,
        stop: 'Answer them by approving with a note or sending the plan back; a plan with open questions always waits.',
        section: 'policies',
        link: LOW_RISK_LINK,
      };
    case 'assessment_missing':
      return {
        why: 'The plan does not say how sure the agent is or how risky it is, so it cannot go ahead without you.',
        stop: 'A plan written by the current agents says both; one that does not always waits.',
        section: 'policies',
        link: LOW_RISK_LINK,
      };
    case 'low_risk_auto':
      return {
        why: `The plan went ahead without approval: ${reason.risk_level} risk, ${reason.confidence} confidence, size ${reason.size}, ${reason.files === 1 ? '1 file' : `${reason.files} files`}.`,
        stop: 'To have every plan wait for you again, turn off Low-risk plans go ahead.',
        section: 'policies',
        link: LOW_RISK_LINK,
      };
  }
};

/** What rejecting an approval of this kind does, in one sentence (the saga's own branches). */
export const rejectConsequence = (kind: ApprovalKind): string =>
  kind === 'plan'
    ? 'The plan goes back to Architecture with your reason, which costs another run of that stage. A rejection cannot be undone.'
    : kind === 'budget'
      ? 'The task stops and waits for a person; nothing more is spent on it until someone hands it back. A rejection cannot be undone.'
      : 'The task does not go on with what was asked; your reason is recorded with the decision. A rejection cannot be undone.';

/** What *Approve* does next, per kind (the saga's own branches). */
export const approveConsequence = (kind: ApprovalKind): string => {
  switch (kind) {
    case 'plan':
      return 'Approve: Implementation starts on this plan.';
    case 'budget':
      return 'Approve: the task goes on to Implementation and may spend what was estimated.';
    default:
      return 'Approve: the task goes on with what was asked.';
  }
};

/** What *Reject* does next, in one line (the dialog says it in full). */
export const rejectNext = (kind: ApprovalKind): string => {
  switch (kind) {
    case 'plan':
      return 'Reject: the plan goes back to Architecture with your reason.';
    case 'budget':
      return 'Reject: the task stops and waits for a person; nothing more is spent on it.';
    default:
      return 'Reject: the task does not go on with what was asked.';
  }
};

/** The verb Home and the Inbox use for an approval row: it opens the task, never decides. */
export const reviewVerb = (kind: ApprovalKind): string =>
  kind === 'plan' ? 'Review plan' : kind === 'budget' ? 'Review budget' : 'Review';

/**
 * A one-line name for the subject, without its body: the version and, when known, the size and
 * the number of files (Home and the Inbox; research/21 S06 — "Plan for DEMO-1 · size M · 6 files").
 */
export const subjectLine = (
  kind: ApprovalKind,
  subject: ApprovalSubject | null | undefined,
  plan?: { readonly size: string | null; readonly files: number | null },
): string => {
  if (subject === null || subject === undefined) {
    return kind === 'plan'
      ? 'Plan approval · the plan it is about was not recorded'
      : kind === 'budget'
        ? 'Budget approval · the figures were not recorded'
        : 'Approval · what it is about was not recorded';
  }
  if (subject.kind === 'budget') {
    return `Budget · estimate ${formatUsd(subject.estimate_usd)}, over the ${formatUsd(subject.threshold_usd)} threshold`;
  }
  const parts = [`Plan v${subject.artifact_version}`];
  if (plan?.size !== null && plan?.size !== undefined) {
    parts.push(`size ${plan.size}`);
  }
  if (plan?.files !== null && plan?.files !== undefined) {
    parts.push(plan.files === 1 ? '1 file' : `${plan.files} files`);
  }
  return parts.join(' · ');
};
