/**
 * The organisation settings document — `GET/PATCH /api/org` (WP-93, product/10 § "Settings (org)").
 *
 * Four sections, each saved on its own (`PATCH` replaces the sections it names and keeps the rest),
 * each a **maximum** or an organisation-scoped default:
 *
 *  - the **command maximum** (BD-025 §2) — every run's command policy is intersected with it;
 *  - the **autonomy maximum** — the highest dial position a project may select; a project already
 *    above a lowered maximum runs at it from the next read, and a task keeps the dial it froze;
 *  - the **WIP maximum** — a project's `pipeline.wip` may state less, never more;
 *  - the organisation's **quiet hours**, digest time and **default chat account** (Q103 (c)).
 *
 * Saving is an administrator's (`org.settings.write`); anybody who can read the organisation sees
 * the document, and a refused save shows the server's reason. Every string from the server — the
 * command lists, an account's name — is rendered through `ui/untrusted.tsx` (BD-022), and the
 * textareas hold it as a value, never as markup.
 */
import type { CappedProject, OrganisationSettings } from '@platform/contracts';
import { type ReactElement, useState } from 'react';
import { useIntegrations, useOrgSettings, useSettingsCommands } from '../app/queries.js';
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Field,
  formatDateTime,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

const LEVELS = ['observe', 'assist', 'supervised', 'autonomous'] as const;
const LIST_KINDS = ['allow', 'ask', 'block'] as const;

/** One entry per line, blank lines dropped; `undefined` for an empty list (the key is omitted). */
const linesOf = (text: string): string[] | undefined => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length === 0 ? undefined : lines;
};

const numberOrUndefined = (text: string): number | undefined =>
  text.trim() === '' ? undefined : Number(text.trim());

export const OrganisationSettingsPanel = (): ReactElement => {
  const document = useOrgSettings();
  const commands = useSettingsCommands();
  const patch = commands.patchOrgSettings;

  return (
    <section>
      <SectionHeading>Organisation settings</SectionHeading>
      {document.isPending ? <Loading label="Loading the organisation settings…" /> : null}
      {document.isError ? (
        <ErrorNotice
          title="The organisation settings could not be loaded."
          detail={String(document.error)}
        />
      ) : null}
      {document.isSuccess ? (
        <Card className="flex flex-col gap-4 text-sm">
          <p className="text-xs text-fg-muted">
            Maximums every project is held to. A lowered maximum applies at the next read — the next
            run, the next task — and never moves a task that is already running. Saving needs the
            administrator role.
            {document.data.updated_at === null
              ? ' Nothing has been set yet.'
              : ` Last changed ${formatDateTime(document.data.updated_at)}.`}
          </p>
          <SettingsForm
            // Remount on a new document, so the drafts start from what the server now holds.
            key={document.data.updated_at ?? 'unset'}
            settings={document.data.settings}
            pending={patch.isPending}
            onSave={(body) => commands.patchOrgSettings.mutate(body)}
          />
          {patch.isSuccess && patch.data.capped_projects !== null ? (
            <CappedProjects capped={patch.data.capped_projects} />
          ) : null}
          {patch.error === null || patch.error === undefined ? null : (
            <ErrorNotice
              title="The organisation settings were not saved."
              detail={String(patch.error)}
            />
          )}
        </Card>
      ) : null}
    </section>
  );
};

type Patch = Parameters<ReturnType<typeof useSettingsCommands>['patchOrgSettings']['mutate']>[0];

/** The setting a capped row names, in the screen's words. */
const CAPPED_SETTING_LABEL: Readonly<Record<CappedProject['setting'], string>> = {
  autonomy: 'autonomy level',
  'pipeline.wip.max_parallel_tasks': 'parallel tasks',
  'pipeline.wip.max_tasks_in_pipeline': 'tasks in the pipeline',
};

/**
 * What the save just capped — `PATCH /api/org`'s `capped_projects` (WP-113, PROGRESS backlog 318):
 * every project whose autonomy level or WIP limit in force fell, before and after. The project's own
 * choice is kept, so raising the maximum again restores it; the list says so.
 */
const CappedProjects = ({ capped }: { readonly capped: readonly CappedProject[] }): ReactElement =>
  capped.length === 0 ? (
    <p className="text-xs text-fg-muted">This change lowers no project’s value in force.</p>
  ) : (
    <div className="flex flex-col gap-1 text-xs">
      <p>
        This change caps {capped.length === 1 ? 'one value' : `${capped.length} values`} in force —
        each project’s own choice is kept, and raising the maximum again restores it:
      </p>
      <ul aria-label="Projects this change caps" className="flex flex-col gap-0.5">
        {capped.map((entry) => (
          <li key={`${entry.project_id}:${entry.setting}`}>
            <UntrustedText value={entry.project_key} /> — {CAPPED_SETTING_LABEL[entry.setting]}{' '}
            {String(entry.before)} → {String(entry.after)}
          </li>
        ))}
      </ul>
    </div>
  );

const SettingsForm = ({
  settings,
  pending,
  onSave,
}: {
  readonly settings: OrganisationSettings;
  readonly pending: boolean;
  readonly onSave: (body: Patch) => void;
}): ReactElement => {
  const integrations = useIntegrations();
  const chatAccounts = (integrations.data?.items ?? []).filter(
    // A retired account (WP-114) posts nowhere: its credential is destroyed.
    (integration) => integration.type === 'communication' && integration.retired_at === null,
  );
  const [lists, setLists] = useState<Record<(typeof LIST_KINDS)[number], string>>({
    allow: (settings.commands?.allow ?? []).join('\n'),
    ask: (settings.commands?.ask ?? []).join('\n'),
    block: (settings.commands?.block ?? []).join('\n'),
  });
  const [maximum, setMaximum] = useState<string>(settings.autonomy?.maximum ?? '');
  const [parallel, setParallel] = useState(
    String(settings.pipeline?.wip?.max_parallel_tasks ?? ''),
  );
  const [inPipeline, setInPipeline] = useState(
    String(settings.pipeline?.wip?.max_tasks_in_pipeline ?? ''),
  );
  const quiet = settings.notifications?.quiet_hours ?? null;
  const [quietFrom, setQuietFrom] = useState(quiet?.from ?? '');
  const [quietTo, setQuietTo] = useState(quiet?.to ?? '');
  const [digestAt, setDigestAt] = useState(settings.notifications?.digest_at ?? '');
  const [defaultAccount, setDefaultAccount] = useState(
    settings.notifications?.organisation_default ?? '',
  );

  const saveCommands = () => {
    const allow = linesOf(lists.allow);
    const ask = linesOf(lists.ask);
    const block = linesOf(lists.block);
    const none = allow === undefined && ask === undefined && block === undefined;
    onSave({
      commands: none
        ? null
        : {
            ...(allow === undefined ? {} : { allow }),
            ...(ask === undefined ? {} : { ask }),
            ...(block === undefined ? {} : { block }),
          },
    });
  };

  const saveWip = () => {
    const maxParallel = numberOrUndefined(parallel);
    const maxInPipeline = numberOrUndefined(inPipeline);
    onSave({
      pipeline:
        maxParallel === undefined && maxInPipeline === undefined
          ? null
          : {
              wip: {
                ...(maxParallel === undefined ? {} : { max_parallel_tasks: maxParallel }),
                ...(maxInPipeline === undefined ? {} : { max_tasks_in_pipeline: maxInPipeline }),
              },
            },
    });
  };

  const saveNotifications = () => {
    const window =
      quietFrom.trim() === '' && quietTo.trim() === ''
        ? undefined
        : { from: quietFrom.trim(), to: quietTo.trim() };
    const empty = window === undefined && digestAt.trim() === '' && defaultAccount === '';
    onSave({
      notifications: empty
        ? null
        : {
            ...(window === undefined ? {} : { quiet_hours: window }),
            ...(digestAt.trim() === '' ? {} : { digest_at: digestAt.trim() }),
            ...(defaultAccount === '' ? {} : { organisation_default: defaultAccount }),
          },
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium">Command maximum</legend>
        <p className="text-xs text-fg-muted">
          Every run’s command policy is its role’s baseline intersected with this list, before a
          project narrows it; a verb left out of <code>allow</code> is removed from every run. One
          entry per line; all three empty removes the maximum.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {LIST_KINDS.map((kind) => (
            <label key={kind} className="flex flex-col gap-1 text-xs">
              {kind}
              <textarea
                aria-label={`Organisation command ${kind} list`}
                className="min-h-24 rounded-md border border-line bg-surface p-2 font-mono text-xs"
                value={lists[kind]}
                onChange={(event) => setLists({ ...lists, [kind]: event.target.value })}
              />
            </label>
          ))}
        </div>
        <div>
          <Button disabled={pending} onClick={saveCommands}>
            Save command maximum
          </Button>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium">Autonomy maximum</legend>
        <p className="text-xs text-fg-muted">
          The highest dial position a project may select. A project above it runs at the maximum
          from its next task; its own choice is kept, so raising the maximum restores it.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            Maximum
            <select
              aria-label="Organisation autonomy maximum"
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
              value={maximum}
              onChange={(event) => setMaximum(event.target.value)}
            >
              <option value="">No maximum</option>
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={pending}
            onClick={() =>
              onSave({
                autonomy: maximum === '' ? null : { maximum: maximum as (typeof LEVELS)[number] },
              })
            }
          >
            Save autonomy maximum
          </Button>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium">WIP maximum</legend>
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label="Parallel tasks"
            hint="A project may state fewer, never more. Empty is no maximum."
            type="number"
            min={1}
            value={parallel}
            onChange={(event) => setParallel(event.target.value)}
          />
          <Field
            label="Tasks in the pipeline"
            type="number"
            min={1}
            value={inPipeline}
            onChange={(event) => setInPipeline(event.target.value)}
          />
          <Button disabled={pending} onClick={saveWip}>
            Save WIP maximum
          </Button>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium">Organisation notifications</legend>
        <p className="text-xs text-fg-muted">
          Inside the quiet hours an organisation budget crossing its threshold waits for the
          organisation’s digest; a spent budget is still posted at once. With two chat accounts that
          each name a channel, the default account is the one that speaks for the organisation.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label="Quiet from"
            placeholder="22:00"
            value={quietFrom}
            onChange={(event) => setQuietFrom(event.target.value)}
          />
          <Field
            label="Quiet until"
            placeholder="07:00"
            value={quietTo}
            onChange={(event) => setQuietTo(event.target.value)}
          />
          <Field
            label="Digest at"
            placeholder="09:00"
            value={digestAt}
            onChange={(event) => setDigestAt(event.target.value)}
          />
          <label className="flex flex-col gap-1 text-sm">
            Default chat account
            <select
              aria-label="Organisation default chat account"
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
              value={defaultAccount}
              onChange={(event) => setDefaultAccount(event.target.value)}
            >
              <option value="">None flagged</option>
              {chatAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {`${account.provider} / ${account.name}`}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={pending} onClick={saveNotifications}>
            Save notifications
          </Button>
        </div>
        {defaultAccount === '' ? null : (
          <p className="text-xs text-fg-muted">
            Flagged:{' '}
            <UntrustedText
              value={
                chatAccounts.find((account) => account.id === defaultAccount)?.name ??
                defaultAccount
              }
            />{' '}
            <Badge>organisation default</Badge>
          </p>
        )}
      </fieldset>
    </div>
  );
};
