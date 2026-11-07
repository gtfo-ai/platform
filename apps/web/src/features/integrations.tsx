/**
 * Integrations (`/integrations`) — the organisation's connected systems as a list box, GitHub's
 * settings list (research/19 § 5.2 "Integrations", TD-033 § 1).
 *
 * Grouped by what an integration does for a project — *Tickets*, *Code & merge requests*, *Chat*,
 * *Errors*, *Logs* (S-25.3, product/08's 2026-11-06 amendment) — one row per integration: its
 * health **now** as a status icon and word, its name (the way into its own page,
 * `/integrations/$id`), its provider as a role glyph and its name (`ui/provider-icon.tsx`, never a
 * brand logo; the screen carries the trademark line), what decided the health and how long ago, and
 * the projects that use it, linked. The health is the server's (`current_health`): read from the
 * integration's traffic — the newest call and the newest verified delivery — with the last probe as
 * one data point, and nothing older than `INTEGRATION_HEALTH_STALE_AFTER_HOURS` ever reads
 * *Working*. A row that reads *Not checked recently* offers *Test again* in place, to someone who may
 * test (a row command: the row keeps its stretched link and the button sits above it, TD-033's
 * 2026-11-06 amendment). The row's `···` holds *Test connection*, *Setup guide*, *Edit configuration*, *Replace
 * credentials* and *Retire* (`integration-forms.tsx`); the header's one primary action is **New
 * integration**, the four-step wizard (`integration-wizard.tsx`). The writes are an administrator's
 * (`integration.write`): the list read's `can_write` decides whether they are offered at all, and a
 * maintainer is told who adds and changes integrations (S-23.23).
 *
 * **The create and test controls are reached from here** (WP-30, PROGRESS backlog 55): they were
 * served by WP-21 and called by nothing, so `POST /api/integrations` could only be reached with
 * `curl` while every check stayed green. The wizard is now where the create lives; this list keeps
 * the probe, whose answer is drawn under the row it is about.
 *
 * **What a row may not say.** A configuration the provider's schema would refuse
 * (`config_refusal`, WP-100) and an organisation account whose credentials cannot be decrypted
 * (`credentials_readable: false`, WP-157 (a)) are named on the row, in the server's own words; a
 * retired integration (WP-114) is listed as retired with no menu, because it refuses every write.
 * "Used by *Autix*" is the list read's own `used_by` (S-25.3) — before it, every project's bindings
 * read, one request per project.
 */
import type { IntegrationProvider, IntegrationSummary } from '@platform/contracts';
import { PlugIcon } from '@primer/octicons-react/PlugIcon';
import { Link, useNavigate } from '@tanstack/react-router';
import { Fragment, type ReactElement, useState } from 'react';
import { invalidSettingsSentence, readErrorDetail } from '../api/read-error.js';
import { useIntegrationProviders, useIntegrations, useOnboardingCommands } from '../app/queries.js';
import { useServices } from '../app/services.js';
import { Blankslate } from '../ui/blankslate.js';
import { Button, buttonClassName } from '../ui/button.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { DetailsDisclosure } from '../ui/details.js';
import { ErrorNotice, formatDateTime, formatInteger } from '../ui/kit.js';
import { ListBox, ListRow } from '../ui/list-box.js';
import { PageHeader } from '../ui/page-header.js';
import { PROVIDER_TRADEMARK_NOTICE, ProviderIcon } from '../ui/provider-icon.js';
import { formatAgo } from '../ui/relative-time.js';
import { rowLink } from '../ui/row-link.js';
import { Skeleton } from '../ui/skeleton.js';
import { StatusIcon } from '../ui/status.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { INTEGRATION_ROLE_GROUPS } from '../ui/words/integrations.js';
import { ConnectionTestResult } from './connection-test-result.js';
import {
  currentHealthStatus,
  IntegrationActions,
  type IntegrationDialog,
  integrationStatus,
} from './integration-forms.js';

/**
 * "Not used by a project", or "Used by N projects" where names do not fit (the retire dialog's
 * count) — the vocabulary's one word for a project's integrations, *Connections* (S-23.23, the UX
 * audit's § 4).
 */
export const boundText = (count: number): string =>
  count === 0
    ? 'Not used by a project'
    : `Used by ${count === 1 ? '1 project' : `${formatInteger(count)} projects`}`;

/** How many projects a row names before "+N" (S-25.3: "Autix, Demo +2"). */
export const USED_BY_NAMED = 2;

const PROJECT_LINK = cx('rounded-sm text-link hover:underline', FOCUS_RING);

/**
 * "Used by *Autix*", "Used by *Autix*, *Demo*", "Used by *Autix*, *Demo* +2" — each named project
 * a link to its board; the rest are counted, and named in the count's tooltip. Project names are
 * operator text, rendered as text.
 */
export const UsedBy = ({
  users,
}: {
  readonly users: IntegrationSummary['used_by'];
}): ReactElement => {
  if (users.length === 0) {
    return <span data-used-by="none">{boundText(0)}</span>;
  }
  const named = users.slice(0, USED_BY_NAMED);
  const rest = users.slice(USED_BY_NAMED);
  return (
    <span data-used-by="">
      Used by{' '}
      {named.map((user, index) => (
        <Fragment key={user.project_id}>
          {index === 0 ? null : ', '}
          <Link to="/projects/$key" params={{ key: user.project_key }} className={PROJECT_LINK}>
            <UntrustedText value={user.project_name} />
          </Link>
        </Fragment>
      ))}
      {rest.length === 0 ? null : (
        <span
          data-used-by-rest={rest.length}
          title={sanitiseUntrusted(rest.map((user) => user.project_name).join(', '))}
        >{` +${formatInteger(rest.length)}`}</span>
      )}
    </span>
  );
};

/** The provider's display name, or its id for one this build does not ship. */
export const providerName = (
  integration: IntegrationSummary,
  provider: IntegrationProvider | undefined,
): string => provider?.display_name ?? integration.provider;

/**
 * What decided the row's health, and how long ago (S-25.3): "last call 5 m ago", "last call failed
 * 2 h ago", "last delivery 1 h ago", "tested 32 d ago", "tested with warnings 2 h ago" (a pass, as
 * the page's *Passed with warnings*), "test failed 3 h ago" — or "no calls or
 * deliveries yet", or "retired 1 Oct 2026, 09:00". Every word is the server's evidence: the basis
 * and the instant are `current_health`'s, and whether a call failed is `activity.last_call`'s.
 */
export const healthText = (integration: IntegrationSummary, nowMs: number): string => {
  if (integration.retired_at !== null) {
    return `retired ${formatDateTime(integration.retired_at)}`;
  }
  const { basis, at } = integration.current_health;
  if (basis === null || at === null) {
    return 'no calls or deliveries yet';
  }
  const what =
    basis === 'call'
      ? integration.activity.last_call?.ok === false
        ? 'last call failed'
        : 'last call'
      : basis === 'delivery'
        ? 'last delivery'
        : integration.health.status === 'down'
          ? 'test failed'
          : // One meaning on the row and the page (review of PR #75): *Passed with warnings*.
            integration.health.status === 'degraded'
            ? 'tested with warnings'
            : 'tested';
  const ago = formatAgo(at, nowMs);
  return `${what} ${ago ?? formatDateTime(at)}`;
};

const PROBLEM_ACTION = cx('rounded-sm text-link underline hover:no-underline', FOCUS_RING);

/**
 * What is wrong with a stored integration — on the row and on its page — in a sentence built from
 * the refusal's paths, with the server's own text behind *Technical details* (S-23.22), and the
 * dialog that repairs it one click away.
 * Nothing for one that loads.
 */
export const IntegrationProblems = ({
  integration,
  onEditConfiguration,
  onReplaceCredentials,
}: {
  readonly integration: IntegrationSummary;
  /** Opens *Edit configuration*; left out where no dialog is at hand. */
  readonly onEditConfiguration?: () => void;
  readonly onReplaceCredentials?: () => void;
}): ReactElement | null => {
  const refusal = integration.config_refusal;
  const unreadable = integration.credentials_readable === false;
  if (refusal === null && !unreadable) {
    return null;
  }
  return (
    <span className="flex flex-col gap-0.5 text-danger">
      {refusal === null ? null : (
        <span data-config-refusal={integration.id} className="flex flex-col gap-0.5">
          <span>
            <span className="font-semibold">This configuration would not load. </span>
            {/* S-23.22: the sentence is built from the paths; the server's text is a diagnostic. */}
            {invalidSettingsSentence(refusal.paths)}
            {onEditConfiguration === undefined ? null : (
              <>
                {' '}
                <button type="button" className={PROBLEM_ACTION} onClick={onEditConfiguration}>
                  Edit configuration
                </button>
              </>
            )}
          </span>
          <DetailsDisclosure summary="Technical details">
            <p className="font-mono text-xs [overflow-wrap:anywhere]">
              <UntrustedText value={refusal.message} />
            </p>
          </DetailsDisclosure>
        </span>
      )}
      {unreadable ? (
        // WP-157 (a), backlog 413: the account's own row says it, once.
        <span data-credentials-unreadable={integration.id}>
          <span className="font-semibold">These credentials can no longer be read.</span>
          {/* The server's sentence only (rule 3); none invented here when it sends none. */}
          {integration.credentials_consequence === null ? null : (
            <>
              {' '}
              <UntrustedText value={integration.credentials_consequence} />
            </>
          )}
          {onReplaceCredentials === undefined ? null : (
            <>
              {' '}
              <button type="button" className={PROBLEM_ACTION} onClick={onReplaceCredentials}>
                Replace credentials
              </button>
            </>
          )}
        </span>
      ) : null}
    </span>
  );
};

export const IntegrationsScreen = (): ReactElement => {
  const integrations = useIntegrations();
  const providers = useIntegrationProviders();
  const commands = useOnboardingCommands();
  const navigate = useNavigate();
  const { now } = useServices();
  const nowMs = now();
  /** Which row's *Test connection* the shared probe answer is drawn under. */
  const [tested, setTested] = useState<string | null>(null);
  /** Which row's dialog is open — held here so a problem line can open it too (S-23.22). */
  const [dialogFor, setDialogFor] = useState<{
    readonly id: string;
    readonly dialog: IntegrationDialog;
  } | null>(null);
  const items = integrations.data?.items ?? [];
  const providerOf = (integration: IntegrationSummary): IntegrationProvider | undefined =>
    providers.data?.items.find((entry) => entry.id === integration.provider);
  const live = items.filter((integration) => integration.retired_at === null).length;
  // S-23.23: `integration.write` is an administrator's; the list says whether this caller holds it,
  // so a maintainer reads the list without a *New integration* the create would refuse.
  const canWrite = integrations.data?.can_write === true;

  const newIntegration = (tone: 'primary' | 'default') => (
    <Link to="/integrations/new" className={buttonClassName(tone)}>
      New integration
    </Link>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Integrations"
        divider={false}
        {...(canWrite ? { actions: newIntegration('primary') } : {})}
      />
      {integrations.isSuccess && !canWrite ? (
        <p className="text-sm text-fg-muted" data-may-not-write="">
          Administrators add and change integrations.
        </p>
      ) : null}
      {integrations.isPending ? <Skeleton label="Loading integrations…" /> : null}
      {integrations.isError ? (
        <ErrorNotice
          title="Integrations could not be loaded."
          // Only a 403 is the role (WP-114, backlog 327's reading, `readErrorDetail`).
          error={integrations.error}
          detail={readErrorDetail(
            integrations.error,
            'Reading integration configuration needs the maintainer role.',
          )}
        />
      ) : null}
      {integrations.isSuccess && items.length === 0 ? (
        canWrite ? (
          <Blankslate
            size="spacious"
            icon={<PlugIcon size={24} />}
            title="No integrations yet"
            hint="An integration connects one external system — a ticket tracker, a git host, a chat workspace, an error tracker, a log store. Its credentials stay in the server's environment; they never come through the browser."
            action={newIntegration('default')}
          />
        ) : (
          <Blankslate
            informational
            size="spacious"
            icon={<PlugIcon size={24} />}
            title="No integrations yet"
            hint="An integration connects one external system — a ticket tracker, a git host, a chat workspace. Ask an administrator to add one."
          />
        )
      ) : null}
      {items.length === 0 ? null : (
        <p className="text-sm text-fg-muted" data-integration-counts="">
          <span className="font-semibold text-fg">{`${formatInteger(live)} active`}</span>
          {items.length === live ? null : ` · ${formatInteger(items.length - live)} retired`}
        </p>
      )}
      {/* S-25.3: grouped by what an integration does for a project, in product/08's order. */}
      {INTEGRATION_ROLE_GROUPS.map((group) => {
        const rows = items.filter((integration) => integration.type === group.type);
        if (rows.length === 0) {
          return null;
        }
        return (
          <section
            key={group.type}
            aria-labelledby={`integrations-${group.type}`}
            className="flex flex-col gap-2"
            data-integration-group={group.type}
          >
            <h2 id={`integrations-${group.type}`} className="text-base font-semibold">
              {group.label}
            </h2>
            <ListBox label={group.label}>
              {rows.map((integration) => {
                const provider = providerOf(integration);
                const { status, word } = integrationStatus(integration, nowMs);
                const isLive = integration.retired_at === null;
                // S-25.3: a stale verdict offers the probe in place, to someone who may run it.
                const testAgain =
                  isLive &&
                  canWrite &&
                  currentHealthStatus(integration, nowMs) === 'not_checked_recently';
                const test = () => {
                  setTested(integration.id);
                  commands.testIntegration.mutate(integration.id);
                };
                return (
                  <Fragment key={integration.id}>
                    <ListRow
                      leading={<StatusIcon status={status} label={word} />}
                      title={
                        <Link
                          to="/integrations/$integrationId"
                          params={{ integrationId: integration.id }}
                          {...rowLink('hover:text-link hover:underline')}
                        >
                          <UntrustedText value={integration.name} />
                        </Link>
                      }
                      meta={
                        <span className="flex flex-col gap-0.5" data-integration={integration.id}>
                          <span className="inline-flex flex-wrap items-center gap-x-1">
                            <ProviderIcon
                              type={integration.type}
                              name={providerName(integration, provider)}
                            />
                            {` · ${word} · ${healthText(integration, nowMs)}`}
                          </span>
                          {isLive ? null : (
                            <span data-integration-retired={integration.id}>
                              Its credentials are deleted and nothing loads or changes it. It stays
                              listed because the audit names it.
                            </span>
                          )}
                          <IntegrationProblems
                            integration={integration}
                            // The repairs are writes: an administrator's only (S-23.23).
                            {...(provider === undefined || !canWrite
                              ? {}
                              : {
                                  onEditConfiguration: () => {
                                    setDialogFor({ id: integration.id, dialog: 'configuration' });
                                  },
                                  onReplaceCredentials: () => {
                                    setDialogFor({ id: integration.id, dialog: 'credentials' });
                                  },
                                })}
                          />
                        </span>
                      }
                      {...(isLive
                        ? {
                            trailing: (
                              <>
                                {testAgain ? (
                                  <Button
                                    size="sm"
                                    disabled={commands.testIntegration.isPending}
                                    onClick={test}
                                    data-test-again={integration.id}
                                  >
                                    Test again
                                  </Button>
                                ) : null}
                                <UsedBy users={integration.used_by} />
                              </>
                            ),
                          }
                        : {})}
                      actions={
                        <IntegrationActions
                          integration={integration}
                          provider={provider}
                          boundProjects={integration.used_by.length}
                          dialog={dialogFor?.id === integration.id ? dialogFor.dialog : null}
                          onDialogChange={(dialog) => {
                            setDialogFor(dialog === null ? null : { id: integration.id, dialog });
                          }}
                          canWrite={canWrite}
                          onTest={test}
                          onSetupGuide={() => {
                            void navigate({
                              to: '/integrations/$integrationId',
                              params: { integrationId: integration.id },
                              search: { tab: 'setup-guide' },
                            });
                          }}
                        />
                      }
                    />
                    {tested === integration.id ? (
                      <li className="px-4 pb-3 pl-11" data-connection-test-for={integration.id}>
                        {/* WP-155 (backlog 451): the one rendering the wizard's step 1 shares. */}
                        <ConnectionTestResult test={commands.testIntegration} />
                      </li>
                    ) : null}
                  </Fragment>
                );
              })}
            </ListBox>
          </section>
        );
      })}
      {/* research/21 § 8: the providers are named, never drawn with their marks. */}
      <p className="text-xs text-fg-muted" data-trademark-notice="">
        {PROVIDER_TRADEMARK_NOTICE}
      </p>
    </div>
  );
};
