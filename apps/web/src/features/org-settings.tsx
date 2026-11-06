/**
 * The organisation settings document — `GET/PATCH /api/org` (WP-93, product/10 § "Settings (org)").
 *
 * Since S-23.11b it is two settings pages rather than one card, each with **one Save**:
 *
 *  - **Policies** — the maximums every project is held to:
 *    - the **command maximum** (BD-025 §2) — every run's command policy is intersected with it;
 *    - the **autonomy maximum** — the highest dial position a project may select; a project already
 *      above a lowered maximum runs at it from the next read, and a task keeps the dial it froze;
 *    - the **parallel tasks maximum** (*WIP maximum* until S-25.6) — a project's `pipeline.wip` may
 *      state less, never more;
 *  - **Notifications** — the organisation's quiet hours, digest time and **default chat account**
 *    (Q103 (c)).
 *
 * `PATCH` replaces the sections it names and keeps the rest, so a Save sends **only the sections
 * whose draft differs from what the server holds** — a page with three sections and one Save must
 * not rewrite the two nobody touched (or race another administrator's change to them). A Save with
 * nothing changed is disabled. The drafts are compared with what the *current* document would
 * produce, so after a save is read back the same draft is no longer a change.
 *
 * Saving is an administrator's (`org.settings.write`); anybody who can read the organisation sees
 * the document, and a refused save shows the server's reason. Every string from the server — the
 * command lists, an account's name — is rendered through `ui/untrusted.tsx` (BD-022), and the
 * textareas hold it as a value, never as markup.
 */
import type { CappedProject, OrganisationSettings } from '@platform/contracts';
import { type ReactElement, type ReactNode, useId, useState } from 'react';
import { useBindableIntegrations, useOrgSettings, useSettingsCommands } from '../app/queries.js';
import { Button } from '../ui/button.js';
import { AUTONOMY_LEVEL_LABEL } from '../ui/humanize.js';
import { Card, ErrorNotice, Field, formatDateTime, Loading } from '../ui/kit.js';
import { Select } from '../ui/select.js';
import { UntrustedText } from '../ui/untrusted.js';

const LEVELS = ['observe', 'assist', 'supervised', 'autonomous'] as const;
const LIST_KINDS = ['allow', 'ask', 'block'] as const;

/** What each command list does, as the field's label says it. */
const LIST_LABEL: Readonly<Record<(typeof LIST_KINDS)[number], string>> = {
  allow: 'Allowed',
  ask: 'Ask first',
  block: 'Blocked',
};

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

type Patch = Parameters<ReturnType<typeof useSettingsCommands>['patchOrgSettings']['mutate']>[0];

/**
 * The document's read, its loading and failure, around a page's form — and the **card** the form
 * sits in (S-25.10b): the page is the canvas, a form is a box on the card ground, as Budgets' is.
 */
const OrgDocument = ({
  children,
}: {
  readonly children: (settings: OrganisationSettings, updatedAt: string | null) => ReactNode;
}): ReactElement => {
  const document = useOrgSettings();
  return (
    <>
      {document.isPending ? <Loading label="Loading the organisation settings…" /> : null}
      {document.isError ? (
        <ErrorNotice
          title="The organisation settings could not be loaded."
          error={document.error}
        />
      ) : null}
      {document.isSuccess ? (
        <Card className="flex flex-col gap-4">
          <p className="text-xs text-fg-muted">
            Saving needs the administrator role.
            {document.data.updated_at === null
              ? ' Nothing has been set yet.'
              : ` Last changed ${formatDateTime(document.data.updated_at)}.`}
          </p>
          {children(document.data.settings, document.data.updated_at)}
        </Card>
      ) : null}
    </>
  );
};

/** The sections of `next` whose value differs from `stored`'s — what one Save sends. */
const changedSections = (next: Patch, stored: Patch): Patch => {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(value) !== JSON.stringify((stored as Record<string, unknown>)[key])) {
      changed[key] = value;
    }
  }
  return changed as Patch;
};

const SaveRow = ({
  label,
  disabled,
  dirty,
  onSave,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly dirty: boolean;
  readonly onSave: () => void;
}): ReactElement => (
  <div className="flex items-center gap-3 border-t border-line pt-3">
    <Button tone="primary" disabled={disabled || !dirty} onClick={onSave}>
      {label}
    </Button>
    {dirty ? null : <span className="text-xs text-fg-muted">Nothing has changed.</span>}
  </div>
);

// ── Policies ─────────────────────────────────────────────────────────────────

interface PolicyDrafts {
  readonly lists: Record<(typeof LIST_KINDS)[number], string>;
  readonly maximum: string;
  readonly parallel: string;
  readonly inPipeline: string;
}

const policyDraftsOf = (settings: OrganisationSettings): PolicyDrafts => ({
  lists: {
    allow: (settings.commands?.allow ?? []).join('\n'),
    ask: (settings.commands?.ask ?? []).join('\n'),
    block: (settings.commands?.block ?? []).join('\n'),
  },
  maximum: settings.autonomy?.maximum ?? '',
  parallel: String(settings.pipeline?.wip?.max_parallel_tasks ?? ''),
  inPipeline: String(settings.pipeline?.wip?.max_tasks_in_pipeline ?? ''),
});

/** The three policy sections a set of drafts writes — `null` removes a section. */
const policyPatchOf = (drafts: PolicyDrafts): Patch => {
  const allow = linesOf(drafts.lists.allow);
  const ask = linesOf(drafts.lists.ask);
  const block = linesOf(drafts.lists.block);
  const maxParallel = numberOrUndefined(drafts.parallel);
  const maxInPipeline = numberOrUndefined(drafts.inPipeline);
  return {
    commands:
      allow === undefined && ask === undefined && block === undefined
        ? null
        : {
            ...(allow === undefined ? {} : { allow }),
            ...(ask === undefined ? {} : { ask }),
            ...(block === undefined ? {} : { block }),
          },
    autonomy: drafts.maximum === '' ? null : { maximum: drafts.maximum as (typeof LEVELS)[number] },
    pipeline:
      maxParallel === undefined && maxInPipeline === undefined
        ? null
        : {
            wip: {
              ...(maxParallel === undefined ? {} : { max_parallel_tasks: maxParallel }),
              ...(maxInPipeline === undefined ? {} : { max_tasks_in_pipeline: maxInPipeline }),
            },
          },
  };
};

/** The setting a capped row names, in the screen's words. */
const CAPPED_SETTING_LABEL: Readonly<Record<CappedProject['setting'], string>> = {
  autonomy: 'autonomy level',
  'pipeline.wip.max_parallel_tasks': 'parallel tasks',
  'pipeline.wip.max_tasks_in_pipeline': 'tasks in the pipeline',
};

/** A capped value in words: an autonomy level by its dial name, a limit as its number. */
const cappedValue = (value: CappedProject['before']): string =>
  typeof value === 'string' && Object.hasOwn(AUTONOMY_LEVEL_LABEL, value)
    ? AUTONOMY_LEVEL_LABEL[value as (typeof LEVELS)[number]]
    : String(value);

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
            {cappedValue(entry.before)} → {cappedValue(entry.after)}
          </li>
        ))}
      </ul>
    </div>
  );

export const OrganisationPolicies = (): ReactElement => {
  const commands = useSettingsCommands();
  const patch = commands.patchOrgSettings;
  return (
    <OrgDocument>
      {(settings, updatedAt) => (
        <>
          <PolicyForm
            // Remount on a new document, so the drafts start from what the server now holds.
            key={updatedAt ?? 'unset'}
            settings={settings}
            pending={patch.isPending}
            onSave={(body) => commands.patchOrgSettings.mutate(body)}
          />
          {patch.isSuccess && patch.data.capped_projects !== null ? (
            <CappedProjects capped={patch.data.capped_projects} />
          ) : null}
          {patch.error === null || patch.error === undefined ? null : (
            <ErrorNotice title="The organisation settings were not saved." error={patch.error} />
          )}
        </>
      )}
    </OrgDocument>
  );
};

const PolicyForm = ({
  settings,
  pending,
  onSave,
}: {
  readonly settings: OrganisationSettings;
  readonly pending: boolean;
  readonly onSave: (body: Patch) => void;
}): ReactElement => {
  const [drafts, setDrafts] = useState<PolicyDrafts>(() => policyDraftsOf(settings));
  const maximumsHint = useId();
  const changed = changedSections(policyPatchOf(drafts), policyPatchOf(policyDraftsOf(settings)));
  const dirty = Object.keys(changed).length > 0;

  return (
    <div className="flex flex-col gap-5 text-sm">
      <fieldset className="flex flex-col gap-2">
        <legend className="font-semibold">Command maximum</legend>
        <p className="text-xs text-fg-muted">
          Every run’s command policy is its role’s baseline intersected with this list, before a
          project narrows it; a command left out of <em>Allowed</em> is removed from every run. One
          entry per line; all three empty removes the maximum.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {LIST_KINDS.map((kind) => (
            <label key={kind} className="flex flex-col gap-1 text-xs">
              {LIST_LABEL[kind]}
              <textarea
                aria-label={`Organisation command ${kind} list`}
                className="min-h-24 rounded-md border border-line-input bg-inset p-2 font-mono text-xs"
                value={drafts.lists[kind]}
                onChange={(event) =>
                  setDrafts({ ...drafts, lists: { ...drafts.lists, [kind]: event.target.value } })
                }
              />
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="font-semibold">Autonomy maximum</legend>
        <p className="text-xs text-fg-muted">
          The highest dial position a project may select. A project above it runs at the maximum
          from its next task; its own choice is kept, so raising the maximum restores it.
        </p>
        <label className="flex w-fit flex-col gap-1 text-sm">
          Maximum
          <Select
            aria-label="Organisation autonomy maximum"
            value={drafts.maximum}
            onChange={(event) => setDrafts({ ...drafts, maximum: event.target.value })}
          >
            <option value="">No maximum</option>
            {LEVELS.map((level) => (
              <option key={level} value={level}>
                {AUTONOMY_LEVEL_LABEL[level]}
              </option>
            ))}
          </Select>
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="font-semibold">Parallel tasks maximum</legend>
        {/* One row (S-25.10b): two equal columns aligned at the top, so the labels share a line and
            the inputs a height and a width, and the hint under both — it is true of both. In a
            flex row aligned at the end, the first field's own hint lifted its label above the
            second's and widened its input. */}
        <div
          className="grid max-w-md grid-cols-2 items-start gap-x-3 gap-y-1"
          data-parallel-maximums=""
        >
          <Field
            label="Parallel tasks"
            aria-describedby={maximumsHint}
            type="number"
            min={1}
            value={drafts.parallel}
            onChange={(event) => setDrafts({ ...drafts, parallel: event.target.value })}
          />
          <Field
            label="Tasks in the pipeline"
            aria-describedby={maximumsHint}
            type="number"
            min={1}
            value={drafts.inPipeline}
            onChange={(event) => setDrafts({ ...drafts, inPipeline: event.target.value })}
          />
          <p id={maximumsHint} className="col-span-2 text-xs text-fg-muted">
            A project may state fewer, never more. Empty is no maximum.
          </p>
        </div>
      </fieldset>

      <p className="text-xs text-fg-muted">
        A lowered maximum applies at the next read — the next run, the next task — and never moves a
        task that is already running.
      </p>
      <SaveRow
        label="Save policies"
        disabled={pending}
        dirty={dirty}
        onSave={() => onSave(changed)}
      />
    </div>
  );
};

// ── Notifications ────────────────────────────────────────────────────────────

interface NotificationDrafts {
  readonly quietFrom: string;
  readonly quietTo: string;
  readonly digestAt: string;
  readonly defaultAccount: string;
}

const notificationDraftsOf = (settings: OrganisationSettings): NotificationDrafts => {
  const quiet = settings.notifications?.quiet_hours ?? null;
  return {
    quietFrom: quiet?.from ?? '',
    quietTo: quiet?.to ?? '',
    digestAt: settings.notifications?.digest_at ?? '',
    defaultAccount: settings.notifications?.organisation_default ?? '',
  };
};

const notificationPatchOf = (drafts: NotificationDrafts): Patch => {
  const window =
    drafts.quietFrom.trim() === '' && drafts.quietTo.trim() === ''
      ? undefined
      : { from: drafts.quietFrom.trim(), to: drafts.quietTo.trim() };
  const digestAt = drafts.digestAt.trim();
  const empty = window === undefined && digestAt === '' && drafts.defaultAccount === '';
  return {
    notifications: empty
      ? null
      : {
          ...(window === undefined ? {} : { quiet_hours: window }),
          ...(digestAt === '' ? {} : { digest_at: digestAt }),
          ...(drafts.defaultAccount === '' ? {} : { organisation_default: drafts.defaultAccount }),
        },
  };
};

export const OrganisationNotifications = (): ReactElement => {
  const commands = useSettingsCommands();
  const patch = commands.patchOrgSettings;
  return (
    <OrgDocument>
      {(settings, updatedAt) => (
        <>
          <NotificationForm
            key={updatedAt ?? 'unset'}
            settings={settings}
            pending={patch.isPending}
            onSave={(body) => commands.patchOrgSettings.mutate(body)}
          />
          {patch.error === null || patch.error === undefined ? null : (
            <ErrorNotice title="The organisation settings were not saved." error={patch.error} />
          )}
        </>
      )}
    </OrgDocument>
  );
};

const NotificationForm = ({
  settings,
  pending,
  onSave,
}: {
  readonly settings: OrganisationSettings;
  readonly pending: boolean;
  readonly onSave: (body: Patch) => void;
}): ReactElement => {
  // A retired account (WP-114) posts nowhere: its credential is destroyed, and the selector leaves
  // it out (WP-122).
  const chatAccounts = useBindableIntegrations('communication').items;
  const [drafts, setDrafts] = useState<NotificationDrafts>(() => notificationDraftsOf(settings));
  const changed = changedSections(
    notificationPatchOf(drafts),
    notificationPatchOf(notificationDraftsOf(settings)),
  );
  const dirty = Object.keys(changed).length > 0;

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-xs text-fg-muted">
        Inside the quiet hours an organisation budget crossing its threshold waits for the
        organisation’s digest; a spent budget is still posted at once. With two chat accounts that
        each name a channel, the default account is the one that speaks for the organisation.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Quiet from"
          placeholder="22:00"
          value={drafts.quietFrom}
          onChange={(event) => setDrafts({ ...drafts, quietFrom: event.target.value })}
        />
        <Field
          label="Quiet until"
          placeholder="07:00"
          value={drafts.quietTo}
          onChange={(event) => setDrafts({ ...drafts, quietTo: event.target.value })}
        />
        <Field
          label="Digest at"
          placeholder="09:00"
          value={drafts.digestAt}
          onChange={(event) => setDrafts({ ...drafts, digestAt: event.target.value })}
        />
      </div>
      <label className="flex w-fit flex-col gap-1 text-sm">
        Default chat account
        <Select
          aria-label="Organisation default chat account"
          value={drafts.defaultAccount}
          onChange={(event) => setDrafts({ ...drafts, defaultAccount: event.target.value })}
        >
          <option value="">None flagged</option>
          {chatAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </Select>
      </label>
      {drafts.defaultAccount === '' ? null : (
        <p className="text-xs text-fg-muted">
          Speaks for the organisation:{' '}
          <UntrustedText
            value={
              chatAccounts.find((account) => account.id === drafts.defaultAccount)?.name ??
              drafts.defaultAccount
            }
          />
        </p>
      )}
      <SaveRow
        label="Save notifications"
        disabled={pending}
        dirty={dirty}
        onSave={() => onSave(changed)}
      />
    </div>
  );
};
