/**
 * **A plan that went ahead without approval says so** (S-28.8, the M28 ruling amending BD-006).
 *
 * A project that switches on *Low-risk plans go ahead* lets a plan the platform's own facts and the
 * agent's assessment both call low-risk start Implementation with nobody asked. The task page then
 * says it — *"Plan went ahead without approval: low risk, high confidence, 2 files."* — with what the
 * rule saw, the plan one click away, and the two ways a person can still stop it while it is being
 * implemented: *Pause* and *Send back…* (a return to an earlier stage, Architecture included). Both
 * are accepted on a task that is running (`task.pause`, `task.return_to_stage`), and each is offered
 * only to a reader the route would admit (`can_pause`, `can_return`).
 *
 * Information, never *Needs you*: nothing is asked of the reader. It shows while the task is
 * running Implementation on that plan — after that the plan's approval is history, and the task's
 * own state says what happens next.
 */
import type { ApprovalView, TaskDetailResponse } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { DetailsDisclosure } from '../ui/details.js';
import { Flash } from '../ui/flash.js';
import { Button } from '../ui/kit.js';
import { PlanBody } from './approval-card.js';
import { lowRiskAutoOf, wentAheadLine } from './approval-text.js';
import type { TaskDialog } from './task-dialogs.js';

/** The stage a plan approval lets the task into, on every template that has one. */
const IMPLEMENTATION = 'implementation';

/**
 * The plan approval the platform decided itself, when the task is implementing that plan now —
 * the newest plan approval, `auto_decided` — or `null`.
 */
export const planWentAhead = (detail: TaskDetailResponse): ApprovalView | null => {
  if (detail.task.state !== 'active' || detail.task.current_stage !== IMPLEMENTATION) {
    return null;
  }
  const newest = detail.approvals
    .filter((approval) => approval.kind === 'plan')
    .reduce<ApprovalView | null>(
      (latest, approval) =>
        latest === null || approval.requested_at > latest.requested_at ? approval : latest,
      null,
    );
  return newest?.auto_decided === true && newest.status === 'approved' ? newest : null;
};

export const PlanWentAheadNotice = ({
  detail,
  approval,
  projectKey,
  onOpen,
}: {
  readonly detail: TaskDetailResponse;
  readonly approval: ApprovalView;
  readonly projectKey: string | null;
  readonly onOpen: (dialog: TaskDialog) => void;
}): ReactElement => {
  const subject = approval.subject?.kind === 'plan' ? approval.subject : null;
  return (
    <section aria-label="What happens next" data-testid="plan-went-ahead">
      <Flash tone="info">
        <div className="flex flex-col gap-2">
          <p className="text-sm" data-plan-went-ahead="">
            {wentAheadLine(lowRiskAutoOf(approval.reasons))}
          </p>
          <p className="text-xs text-fg-muted">
            This project lets a plan go ahead when the platform finds no risk in it and the agent
            judges it low-risk and is sure of it. Risk classes and the first tasks’ extra checks
            still wait for you.{' '}
            {projectKey === null ? null : (
              <Link
                to="/projects/$key/settings/$section"
                params={{ key: projectKey, section: 'policies' }}
                className="text-accent underline underline-offset-2"
              >
                Low-risk plans
              </Link>
            )}
          </p>
          {subject === null ? null : (
            <DetailsDisclosure summary="See plan">
              <div className="pt-2">
                <PlanBody taskId={detail.task.id} subject={subject} />
              </div>
            </DetailsDisclosure>
          )}
          {detail.can_pause || detail.can_return ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-fg-muted">To stop it:</span>
              {detail.can_pause ? (
                <Button
                  size="sm"
                  onClick={() => {
                    onOpen('pause');
                  }}
                >
                  Pause
                </Button>
              ) : null}
              {detail.can_return ? (
                <Button
                  size="sm"
                  onClick={() => {
                    onOpen('return');
                  }}
                >
                  Send back…
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </Flash>
    </section>
  );
};
