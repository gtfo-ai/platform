/**
 * What became of the steers, take-over stops and cancels sent to a run — WP-85, TD-028 decision 9
 * (and decision 11 for the cancel, WP-101).
 *
 * A command is **accepted** by the process that answered the request and **applied or refused** by
 * the process holding the run, which on the shipped topology is never the same process. So the run
 * screen cannot say "sent" and stop: it reads `GET /api/runs/:id/commands` and says, per command,
 * which of the three it is — in words, because a badge reading `refused` without its reason would
 * leave the person guessing whether to press the button again.
 *
 * A steer's text is the person's own words as the platform stored them (redacted, TD-012) and is
 * rendered as text (BD-022).
 */
import type { RunCommandRecord } from '@platform/contracts';
import type { ReactElement } from 'react';
import { Badge, formatDateTime, SectionHeading } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

/** The sentence that says where one command stands — never a bare state name (standing rule 18). */
export const runCommandStateText = (
  command: Pick<RunCommandRecord, 'kind' | 'state' | 'applied_at' | 'refused_reason'>,
): string => {
  const what = command.kind === 'steer' ? 'message' : 'stop';
  switch (command.state) {
    case 'pending':
      return `Accepted — waiting for the process running the agent to apply this ${what}.`;
    case 'applied':
      return `Applied${command.applied_at === null ? '' : ` at ${formatDateTime(command.applied_at)}`} — ${APPLIED[command.kind]}`;
    default:
      switch (command.refused_reason) {
        case 'run_ended':
          return `Refused — the run ended before this ${what} could be applied, and it will not be applied later.`;
        case 'delivery_failed':
          return `Refused — the live session did not take this ${what} (it was closing), and it will not be retried.`;
        case 'undecodable':
          return `Refused — this ${what} was stored in a form this version of the platform cannot read.`;
        default:
          return `Refused — the process holding the run found no live session to apply this ${what} to.`;
      }
  }
};

/** What an applied command did, per kind — a record per kind so a new kind is a type error here. */
const APPLIED: Record<RunCommandRecord['kind'], string> = {
  steer: 'delivered to the live session as a turn.',
  take_over: 'the run was asked to stop and export its workspace.',
  cancel: 'the session was asked to stop; the run ends cancelled with what it had cost.',
};

/** The command's name on the screen. */
const LABEL: Record<RunCommandRecord['kind'], string> = {
  steer: 'Steer',
  take_over: 'Take-over stop',
  cancel: 'Cancel',
};

const TONE = { pending: 'warning', applied: 'success', refused: 'danger' } as const;

export const RunCommandLog = ({
  commands,
}: {
  readonly commands: readonly RunCommandRecord[];
}): ReactElement | null => {
  if (commands.length === 0) {
    return null;
  }
  return (
    <section aria-label="Commands sent to this run" className="flex flex-col gap-2">
      <SectionHeading>Commands sent to this run</SectionHeading>
      <ul className="flex flex-col gap-1 text-xs">
        {commands.map((command) => (
          <li key={command.id} className="flex flex-col gap-0.5" data-command-state={command.state}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={TONE[command.state]}>{command.state}</Badge>
              <span className="font-medium">{LABEL[command.kind]}</span>
              <span className="text-fg-muted">{formatDateTime(command.created_at)}</span>
            </div>
            {command.message === null ? null : (
              <UntrustedText className="font-mono" value={command.message} />
            )}
            <span className="text-fg-muted">{runCommandStateText(command)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
};
