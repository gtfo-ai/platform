/**
 * The fleet as lists (TD-033 decision 8 (b)'s plain view, and the one that must always tell the
 * whole truth): every live run as a row — its status icon first, project · ticket · title, the
 * stage, `PhaseTrack`, what the agent is doing, its seat, the model, how long it has run, what it
 * has cost, and a `···` menu with *Open run*, *Open task* and *Cancel run*; then what needs you,
 * each a link to its task; then the seats with their slots.
 *
 * The rows are in attention order (`fleet.runs`): what needs a person, then what is stuck, then the
 * rest oldest first — and after them a run that ended while the page watched, *just finished* or
 * *just ended*, for as long as the map and the office keep it at its desk. Pressing a row's title opens the run's dialog, as a card on the map and a desk
 * in the office do. Every string a person, a tracker or an agent wrote is a sanitised React text
 * node; inside a button or a link it is plain text, never `UntrustedText`, whose links would nest.
 */
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { useRunCommands } from '../../app/queries.js';
import { reviewVerb } from '../../features/approval-text.js';
import { ActionMenu, ActionMenuItem, ActionMenuSeparator } from '../../ui/action-menu.js';
import { Avatar } from '../../ui/avatar.js';
import { Button, buttonClassName } from '../../ui/button.js';
import { Counter } from '../../ui/counter.js';
import { cx, FOCUS_RING } from '../../ui/cx.js';
import { Dialog } from '../../ui/dialog.js';
import { ErrorNotice, formatElapsed, formatRunCost } from '../../ui/kit.js';
import { ListBox, ListBoxHeader, ListRow } from '../../ui/list-box.js';
import { PhaseTrack } from '../../ui/phase-track.js';
import { rowLink } from '../../ui/row-link.js';
import { StatusIcon } from '../../ui/status.js';
import { sanitiseUntrusted } from '../../ui/untrusted-text.js';
import {
  activityWords,
  type Fleet,
  type FleetNeed,
  type FleetRun,
  type FleetSeat,
  seatTitle,
  seatWords,
  slotsWords,
} from './model.js';

/** "demo · DEMO-1 · Checkout flow", leaving out what is not known yet; sanitised. */
export const runListTitle = (run: FleetRun): string =>
  [run.projectKey, run.ticketKey, run.title]
    .filter((part): part is string => part !== null)
    .map(sanitiseUntrusted)
    .join(' · ') || 'Loading the task…';

const CANCELLABLE: ReadonlySet<FleetRun['run']['status']> = new Set(['running', 'starting']);

const RunRow = ({
  run,
  seat,
  now,
  onOpen,
}: {
  readonly run: FleetRun;
  readonly seat: FleetSeat | null;
  readonly now: number;
  readonly onOpen: (runId: string) => void;
}): ReactElement => {
  const commands = useRunCommands(run.id);
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const key = run.ticketKey === null ? 'this run' : sanitiseUntrusted(run.ticketKey);
  return (
    <ListRow
      leading={<StatusIcon status={run.meta.icon} label={run.meta.label} />}
      title={
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => {
            onOpen(run.id);
          }}
          data-fleet-row={run.id}
          // The row's stretched control (S-23.26): a click anywhere on the row opens the dialog.
          {...rowLink('rounded-sm text-left hover:text-link hover:underline')}
        >
          {runListTitle(run)}
        </button>
      }
      meta={
        <span className="flex flex-col gap-1">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span>{run.stageName}</span>
            <span aria-hidden="true">·</span>
            <span className="font-medium text-fg">
              {run.ended
                ? run.activity.activity === 'done'
                  ? 'just finished'
                  : `just ended: ${activityWords(run)}`
                : activityWords(run)}
            </span>
            <span aria-hidden="true">·</span>
            <span>{seatWords(seat)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{sanitiseUntrusted(run.run.model)}</span>
          </span>
          {run.phases.length === 0 ? null : (
            <PhaseTrack
              stages={run.phases}
              activity={run.activity.activity}
              detail={run.activity.detail}
              size="sm"
            />
          )}
          {commands.cancel.isError ? (
            <ErrorNotice title="That cancel was refused." error={commands.cancel.error} />
          ) : null}
          {commands.cancel.isSuccess ? (
            <span className="text-fg">
              Cancel accepted — the run ends once the process running it stops the agent.
            </span>
          ) : null}
        </span>
      }
      trailing={
        <>
          <span className="tabular-nums" title="How long the run has gone">
            {formatElapsed(
              run.run.started_at,
              run.ended ? Date.parse(run.run.ended_at ?? '') || now : now,
            )}
          </span>
          <span className="tabular-nums" title="What the run has cost so far">
            {formatRunCost(run.run.cost, { estimate: true })}
          </span>
        </>
      }
      actions={
        <>
          <ActionMenu label={`Actions for ${key}`}>
            <ActionMenuItem
              onSelect={() => {
                void navigate({ to: '/runs/$runId', params: { runId: run.id } });
              }}
            >
              Open run
            </ActionMenuItem>
            <ActionMenuItem
              onSelect={() => {
                void navigate({ to: '/tasks/$taskId', params: { taskId: run.taskId } });
              }}
            >
              Open task
            </ActionMenuItem>
            <ActionMenuSeparator />
            <ActionMenuItem
              tone="danger"
              disabled={!CANCELLABLE.has(run.run.status) || commands.cancel.isPending}
              onSelect={() => {
                setConfirming(true);
              }}
            >
              Cancel run…
            </ActionMenuItem>
          </ActionMenu>
          <Dialog
            open={confirming}
            onOpenChange={setConfirming}
            title={`Cancel ${key}?`}
            description="The process running the agent stops it and ends the run with what it cost so far. The task stops at this stage and waits for a person."
            footer={
              <>
                <Button
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  Keep it running
                </Button>
                <Button
                  tone="danger"
                  disabled={commands.cancel.isPending}
                  onClick={() => {
                    commands.cancel.mutate('cancelled from the Agents page');
                    setConfirming(false);
                  }}
                >
                  Cancel run
                </Button>
              </>
            }
          />
        </>
      }
    />
  );
};

/**
 * The row's verb. An approval's is *Review plan*, as on Home and in the Inbox (S-25.1): the row
 * opens the task, where the plan is on screen beside *Approve* — it never approves in one click.
 */
const needAction = (need: FleetNeed): string =>
  need.kind === 'question'
    ? 'Answer'
    : need.kind === 'approval'
      ? reviewVerb(need.approvalKind ?? 'plan')
      : 'Open';

const seatOf = (fleet: Fleet, id: string | null): FleetSeat | null =>
  id === null ? null : (fleet.seats.find((seat) => seat.id === id) ?? null);

export const FleetList = ({
  fleet,
  now,
  onOpen,
}: {
  readonly fleet: Fleet;
  readonly now: number;
  readonly onOpen: (runId: string) => void;
}): ReactElement => {
  // The runs that ended while the page watched: the map and the office keep them at their seat for
  // a moment, so the list says them too, after the live ones.
  const ended = fleet.seats.flatMap((seat) => seat.endings);
  const rows = [...fleet.runs, ...ended];
  return (
    <div className="flex flex-col gap-4">
      <ListBox
        label="Runs"
        header={
          <ListBoxHeader>
            <h2 className="inline-flex items-center gap-2 font-semibold text-fg">
              Runs{' '}
              <Counter
                count={rows.length}
                label={`${fleet.runs.length} live runs${ended.length === 0 ? '' : `, ${ended.length} just ended`}`}
              />
            </h2>
          </ListBoxHeader>
        }
      >
        {rows.length === 0 ? (
          <li className="px-4 py-3 text-sm text-fg-muted">No run is live right now.</li>
        ) : null}
        {rows.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            seat={seatOf(fleet, run.seatId)}
            now={now}
            onOpen={onOpen}
          />
        ))}
      </ListBox>

      {fleet.needs.length === 0 ? null : (
        <ListBox
          label="Needs you"
          header={
            <ListBoxHeader
              actions={
                <Link
                  to="/inbox"
                  className={cx('rounded-sm text-sm text-link hover:underline', FOCUS_RING)}
                >
                  View inbox →
                </Link>
              }
            >
              <h2 className="inline-flex items-center gap-2 font-semibold text-fg">
                Needs you <Counter count={fleet.needs.length} />
              </h2>
            </ListBoxHeader>
          }
        >
          {fleet.needs.map((need) => (
            <ListRow
              key={need.id}
              leading={<StatusIcon status="needs_you" />}
              title={need.untrusted ? sanitiseUntrusted(need.text) : need.text}
              meta={[
                need.projectKey === null ? null : sanitiseUntrusted(need.projectKey),
                need.ticketKey === null ? null : sanitiseUntrusted(need.ticketKey),
                `${formatElapsed(need.at, now)} ago`,
              ]
                .filter((part): part is string => part !== null)
                .join(' · ')}
              actions={
                <Link
                  to="/tasks/$taskId"
                  params={{ taskId: need.taskId }}
                  // The row's link (S-23.26): the title is text, so a click anywhere opens the task.
                  {...rowLink(buttonClassName('default', 'sm'))}
                >
                  {needAction(need)}
                  <span className="sr-only">{` ${need.ticketKey === null ? 'this task' : sanitiseUntrusted(need.ticketKey)}`}</span>
                </Link>
              }
            />
          ))}
        </ListBox>
      )}

      <ListBox
        label="Machines"
        header={
          <ListBoxHeader>
            <h2 className="font-semibold text-fg">Machines</h2>
            <span
              className="text-fg-muted"
              title="Free slots on active, unpaused workers. The platform server does not report its capacity."
            >
              {`${fleet.counts.freeSeats} free`}
            </span>
          </ListBoxHeader>
        }
      >
        {fleet.seats.map((seat) => (
          <ListRow
            key={seat.id}
            leading={
              seat.kind === 'server' ? undefined : (
                <Avatar name={seatTitle(seat)} size={20} decorative />
              )
            }
            title={seat.kind === 'server' ? 'Platform server' : seatTitle(seat)}
            meta={[
              seat.kind === 'server'
                ? 'runs agents on the platform’s own server'
                : seat.owner === null
                  ? 'worker'
                  : `worker · ${sanitiseUntrusted(seat.owner)}`,
              slotsWords(seat),
              seat.state === 'active' ? null : seat.state === 'paused' ? 'paused' : 'revoked',
            ]
              .filter((part): part is string => part !== null)
              .join(' · ')}
          />
        ))}
      </ListBox>
    </div>
  );
};
