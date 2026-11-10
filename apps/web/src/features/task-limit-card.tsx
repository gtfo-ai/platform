/**
 * **Your limit** — a person's limit on their tasks in flight, on the Workers screen (S-28.6, the
 * M28 ruling B on BD-010). The owner's feedback: the limit "should be per worker (user), each can
 * have a separate limit, configurable", and the person must always understand the rule.
 *
 * - The sentence says the limit and **the counting rule in words**: *At most 3 of your tasks are
 *   worked on at once. Paused tasks and tasks waiting for a person to unblock them do not count;
 *   tasks waiting for your approval or answer do.* Then what counts now, the tasks holding the
 *   places (each a link) and how many of yours wait.
 * - **Change** opens a number field with the organisation's maximum named, *Save*, and *Use the
 *   default*; a refusal is said in words (`task_limit_above_maximum` names the maximum).
 * - **An administrator** also sees every person's limit and may set it (`GET /api/org/task-limits`,
 *   `PUT /api/org/users/:id/task-limit`). Nothing of it is asked for anybody else.
 *
 * Ticket keys and names are stored text and are rendered as text (BD-022).
 */
import type { MyTaskLimitResponse, OrgTaskLimitsResponse } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { errorSentence, loadErrorSentences } from '../api/read-error.js';
import { useMyTaskLimit, useOrgTaskLimits, useSettingsCommands } from '../app/queries.js';
import { Button, Card } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

/** The limit's sentence with the counting rule, to the person themself. */
export const myLimitSentence = (limit: MyTaskLimitResponse): string =>
  `At most ${limit.limit} of your tasks ${limit.limit === 1 ? 'is' : 'are'} worked on at once. ` +
  'Paused tasks and tasks waiting for a person to unblock them do not count; tasks waiting for ' +
  'your approval or answer do.';

/** "You have 2 in flight and 1 queued." */
export const myLoadSentence = (limit: MyTaskLimitResponse): string =>
  `You have ${limit.in_flight} in flight${
    limit.queued === 0 ? '' : ` and ${limit.queued} queued, waiting for a place`
  }.`;

/** Where the number comes from and how high it may go. */
export const limitSourceSentence = (limit: {
  readonly max_tasks_in_flight: number | null;
  readonly default: number;
  readonly maximum: number;
  readonly organisation_states: boolean;
}): string => {
  const own =
    limit.max_tasks_in_flight === null
      ? `This is the default (${limit.default}).`
      : `You set ${limit.max_tasks_in_flight}; the default is ${limit.default}.`;
  return `${own} ${
    limit.organisation_states
      ? `The organisation allows at most ${limit.maximum}.`
      : `It may be up to ${limit.maximum}.`
  } A project may hold its tasks to a lower number.`;
};

const LimitForm = ({
  current,
  maximum,
  onSave,
  onCancel,
}: {
  readonly current: number;
  readonly maximum: number;
  readonly onSave: (next: number | null) => Promise<void>;
  readonly onCancel: () => void;
}): ReactElement => {
  const [value, setValue] = useState(String(current));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum;
  const save = async (next: number | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
    } catch (refusal) {
      // The sentence table is loaded on demand; a refusal names the organisation's maximum.
      await loadErrorSentences().catch(() => undefined);
      setError(errorSentence(refusal).sentence);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2" data-task-limit-form="">
      <label className="flex items-center gap-2 text-sm">
        <span>Tasks in flight at once</span>
        <input
          type="number"
          min={1}
          max={maximum}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="w-20 rounded-md border border-line px-2 py-1"
        />
      </label>
      {valid ? null : (
        <p className="text-xs text-fg-muted">{`Choose a number from 1 to ${maximum}.`}</p>
      )}
      {error === null ? null : (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          tone="primary"
          disabled={!valid || busy}
          onClick={() => void save(parsed)}
        >
          Save
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void save(null)}>
          Use the default
        </Button>
        <Button size="sm" tone="invisible" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
};

const PeopleLimits = ({ data }: { readonly data: OrgTaskLimitsResponse }): ReactElement => {
  const commands = useSettingsCommands();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <details className="text-sm" data-people-limits="">
      <summary className="cursor-pointer">Everyone’s limit</summary>
      <ul className="mt-2 flex flex-col gap-2">
        {data.items.map((person) => (
          <li
            key={person.user_id}
            className="flex flex-col gap-1"
            data-person-limit={person.user_id}
          >
            <span>
              <UntrustedText value={person.name ?? person.email} />
              {` · at most ${person.limit}${person.max_tasks_in_flight === null ? ' (the default)' : ''} · ${person.in_flight} in flight, ${person.queued} queued `}
              {editing === person.user_id ? null : (
                <Button size="sm" tone="invisible" onClick={() => setEditing(person.user_id)}>
                  Change
                </Button>
              )}
            </span>
            {editing === person.user_id ? (
              <LimitForm
                current={person.limit}
                maximum={data.maximum}
                onCancel={() => setEditing(null)}
                onSave={async (next) => {
                  await commands.setTaskLimit.mutateAsync({
                    userId: person.user_id,
                    max_tasks_in_flight: next,
                  });
                  setEditing(null);
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
};

/** The card. `admin`: the reader may set anybody's limit (`org.users.manage`). */
export const TaskLimitCard = ({ admin }: { readonly admin: boolean }): ReactElement | null => {
  const mine = useMyTaskLimit();
  const people = useOrgTaskLimits(admin);
  const commands = useSettingsCommands();
  const [editing, setEditing] = useState(false);
  if (mine.isError) {
    return (
      <p className="text-xs text-fg-muted" data-task-limit-unavailable="">
        Your limit on tasks in flight could not be loaded. Reload the page to try again.
      </p>
    );
  }
  if (mine.data === undefined) return null;
  const limit = mine.data;
  return (
    <Card className="flex flex-col gap-2" data-task-limit="">
      <h2 className="text-base font-semibold">Your limit</h2>
      <p className="text-sm" data-task-limit-sentence="">
        {myLimitSentence(limit)}
      </p>
      <p className="text-sm text-fg-muted">
        {myLoadSentence(limit)}
        {limit.holders.length === 0 ? null : ' Holding your places: '}
        {limit.holders.map((holder, index) => (
          <span key={holder.task_id}>
            {index === 0 ? '' : ', '}
            <Link
              to="/tasks/$taskId"
              params={{ taskId: holder.task_id }}
              className="text-link underline"
            >
              <UntrustedText value={holder.ticket_key} />
            </Link>
          </span>
        ))}
      </p>
      <p className="text-xs text-fg-muted">{limitSourceSentence(limit)}</p>
      {editing ? (
        <LimitForm
          current={limit.limit}
          maximum={limit.maximum}
          onCancel={() => setEditing(false)}
          onSave={async (next) => {
            await commands.setTaskLimit.mutateAsync({ userId: null, max_tasks_in_flight: next });
            setEditing(false);
          }}
        />
      ) : (
        <div>
          <Button size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
        </div>
      )}
      {admin && people.data !== undefined ? <PeopleLimits data={people.data} /> : null}
    </Card>
  );
};
