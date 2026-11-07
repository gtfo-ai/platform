/**
 * **Why the task waits, and what you can do about it** (S-26.8b part 2, the M26 UX spec § 4): the
 * task callout's slot for an open offer nobody takes now — the long form of `./waiting-words.tsx`
 * and the next steps the reader's role allows:
 *
 * - *Take it* and *Assign…*, exactly as the read's `can_take` / `can_assign` offer them — the owner
 *   control of the header (`./task-owner.tsx`), shared, so a confirmation or the picker opens once;
 * - *Open Workers*, for the machine's owner on a machine-side reason, with "Update it from its
 *   page." for a machine that needs an update;
 * - *Open Instance*, for an administrator, when the platform's run images are what it waits on;
 * - *Link account…*, for an administrator, when the tracker assignee isn't linked;
 * - and for everyone else, the sentence alone.
 *
 * Every step is a **secondary** button or link: the page's one amber primary stays the header's
 * (TD-033). It asks nothing of the reader by itself, so it is information (`tone="info"`), never
 * *Needs you*.
 */
import type { TaskDetailResponse } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { buttonClassName } from '../ui/button.js';
import { Flash } from '../ui/flash.js';
import { Button } from '../ui/kit.js';
import { OWNER_WORDS, trackerName } from '../ui/words/owners.js';
import { isOrgSectionFor } from './settings-sections.js';
import type { OwnerControl } from './task-owner.js';
import { WaitingWords, waitingLong, waitingReason, waitingSteps } from './waiting-words.js';

/** The two owner actions a waiting task offers; *Unassign* would not move it. */
const NEXT_LABEL: Readonly<Record<string, string>> = {
  take: OWNER_WORDS['owner.action.take'],
  assign: OWNER_WORDS['owner.action.assign'],
};

const STEP = buttonClassName('default', 'sm');

export const WaitingNotice = ({
  detail,
  owner,
  projectName,
  nowMs,
}: {
  readonly detail: TaskDetailResponse;
  /** The header's owner control; without it no owner action is offered. */
  readonly owner?: OwnerControl | undefined;
  /** The project's name, for "no machine takes unassigned tasks in Autix". */
  readonly projectName: string | null;
  readonly nowMs: number;
}): ReactElement | null => {
  const { task } = detail;
  const viewer = owner?.viewer ?? null;
  const viewerId = viewer?.id ?? null;
  const parts = waitingLong(task.waiting, {
    viewerId,
    nowMs,
    project: projectName,
    tracker: trackerName(task.ticket.provider),
  });
  if (parts === null) {
    return null;
  }
  const steps = waitingSteps(task.waiting, viewerId, isOrgSectionFor('identities', viewer?.role));
  const actions = (owner?.offers ?? []).filter((action) => Object.hasOwn(NEXT_LABEL, action));
  const any = actions.length > 0 || steps.workers || steps.instance || steps.link;
  return (
    <section aria-label="Why it waits" data-testid="waiting-notice">
      <Flash tone="info">
        <div className="flex flex-col gap-2">
          <p data-waiting={waitingReason(task.waiting) ?? 'none'}>
            <WaitingWords parts={parts} />
          </p>
          {steps.update ? <p data-waiting-update="">Update it from its page.</p> : null}
          {any ? (
            <div className="flex flex-wrap items-center gap-2" data-waiting-steps="">
              {actions.map((action) => (
                <Button
                  key={action}
                  size="sm"
                  data-waiting-action={action}
                  disabled={owner?.command.isPending === true}
                  onClick={() => {
                    owner?.run(action);
                  }}
                >
                  {NEXT_LABEL[action]}
                </Button>
              ))}
              {steps.workers ? (
                <Link to="/workers" className={STEP} data-waiting-step="workers">
                  Open Workers
                </Link>
              ) : null}
              {steps.instance ? (
                <Link
                  to="/settings/$section"
                  params={{ section: 'instance' }}
                  className={STEP}
                  data-waiting-step="instance"
                >
                  Open Instance
                </Link>
              ) : null}
              {steps.link ? (
                <Link
                  to="/settings/$section"
                  params={{ section: 'identities' }}
                  className={STEP}
                  data-waiting-step="link"
                >
                  {OWNER_WORDS['owner.action.link']}
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      </Flash>
    </section>
  );
};
