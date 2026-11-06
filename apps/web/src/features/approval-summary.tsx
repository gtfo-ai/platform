/**
 * An approval's one-line name for Home and the Inbox (S-25.1; research/21 S01/S06): **what** it
 * approves — "Plan v2 · size L · 6 files", or the budget's figures — rather than "Plan approval is
 * waiting for you". The row's verb is *Review plan* and opens the task, where the plan is shown open
 * beside the buttons; no row approves in one click (BD-006's 2026-11-06 amendment).
 *
 * The size and the file count are read off the plan artifact the approval names (`subject`), the
 * same read the task page's card makes, so opening the row reads nothing twice. Both are model
 * output (BD-022): the line is rendered as text, and a value that is not the shape it should be is
 * left out rather than guessed.
 */
import type { ApprovalView } from '@platform/contracts';
import type { ReactElement } from 'react';
import { useArtifactBody } from '../app/queries.js';
import { UntrustedText } from '../ui/untrusted.js';
import { subjectLine } from './approval-text.js';

const SIZES: ReadonlySet<string> = new Set(['S', 'M', 'L', 'XL']);

/** The plan's size and number of files, from its stored data — `null` for what is not there. */
export const planFacts = (
  data: unknown,
): { readonly size: string | null; readonly files: number | null } => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { size: null, files: null };
  }
  const record = data as Record<string, unknown>;
  const size = typeof record.estimated_size === 'string' ? record.estimated_size : null;
  const files = Array.isArray(record.files_to_change) ? record.files_to_change.length : null;
  return { size: size !== null && SIZES.has(size) ? size : null, files };
};

export const ApprovalSummary = ({
  approval,
  className,
}: {
  readonly approval: ApprovalView;
  readonly className?: string;
}): ReactElement => {
  const subject = approval.subject ?? null;
  const planId = subject?.kind === 'plan' ? subject.artifact_id : null;
  const body = useArtifactBody(approval.task_id, planId);
  const line = subjectLine(
    approval.kind,
    subject,
    body.data === undefined ? undefined : planFacts(body.data.data),
  );
  return (
    <span data-approval-summary={approval.kind}>
      <UntrustedText value={line} {...(className === undefined ? {} : { className })} />
    </span>
  );
};
