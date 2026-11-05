/**
 * Integrations (`/integrations`) — the organisation's connected systems as a list box, GitHub's
 * settings list (research/19 § 5.2 "Integrations", TD-033 § 1).
 *
 * One row per integration: its health as a status icon and word, its name (the way into its own
 * page, `/integrations/$id`), its provider and kind, when it was last checked, and how many projects
 * bind it. The row's `···` holds *Test connection*, *Setup guide*, *Edit configuration*, *Replace
 * credentials* and *Retire* (`integration-forms.tsx`); the header's one primary action is **New
 * integration**, the four-step wizard (`integration-wizard.tsx`).
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
 * "Bound to N projects" is every project's bindings read (`useProjectsByIntegration`) and is left out
 * until all of them have answered — a count from half the reads would be a wrong number.
 */
import type { IntegrationProvider, IntegrationSummary } from '@platform/contracts';
import { PlugIcon } from '@primer/octicons-react/PlugIcon';
import { Link, useNavigate } from '@tanstack/react-router';
import { Fragment, type ReactElement, useState } from 'react';
import { readErrorDetail } from '../api/read-error.js';
import {
  useIntegrationProviders,
  useIntegrations,
  useOnboardingCommands,
  useProjects,
  useProjectsByIntegration,
} from '../app/queries.js';
import { useServices } from '../app/services.js';
import { Blankslate } from '../ui/blankslate.js';
import { buttonClassName } from '../ui/button.js';
import { INTEGRATION_TYPE_LABEL } from '../ui/humanize.js';
import { ErrorNotice, formatDateTime, formatInteger } from '../ui/kit.js';
import { ListBox, ListBoxHeader, ListRow } from '../ui/list-box.js';
import { PageHeader } from '../ui/page-header.js';
import { formatAgo } from '../ui/relative-time.js';
import { Skeleton } from '../ui/skeleton.js';
import { StatusIcon } from '../ui/status.js';
import { UntrustedText } from '../ui/untrusted.js';
import { ConnectionTestResult } from './connection-test-result.js';
import { IntegrationActions, integrationStatus } from './integration-forms.js';

/** "Bound to 2 projects", "Not bound", or nothing while the count is not known. */
export const boundText = (count: number | null): string | null =>
  count === null
    ? null
    : count === 0
      ? 'Not bound'
      : `Bound to ${count === 1 ? '1 project' : `${formatInteger(count)} projects`}`;

/** The provider's display name, or its id for one this build does not ship. */
export const providerName = (
  integration: IntegrationSummary,
  provider: IntegrationProvider | undefined,
): string => provider?.display_name ?? integration.provider;

/** "checked 5 m ago", "never checked", or "retired 1 Oct 2026, 09:00". */
export const checkedText = (integration: IntegrationSummary, nowMs: number): string => {
  if (integration.retired_at !== null) {
    return `retired ${formatDateTime(integration.retired_at)}`;
  }
  const checked = integration.health.checked_at;
  if (checked === null) {
    return 'never checked';
  }
  const ago = formatAgo(checked, nowMs);
  return ago === null ? `checked ${formatDateTime(checked)}` : `checked ${ago}`;
};

/**
 * What is wrong with a stored integration, in the server's words — on the row and on its page.
 * Nothing for one that loads.
 */
export const IntegrationProblems = ({
  integration,
}: {
  readonly integration: IntegrationSummary;
}): ReactElement | null => {
  const refusal = integration.config_refusal;
  const unreadable = integration.credentials_readable === false;
  if (refusal === null && !unreadable) {
    return null;
  }
  return (
    <span className="flex flex-col gap-0.5 text-danger">
      {refusal === null ? null : (
        <span data-config-refusal={integration.id}>
          <span className="font-semibold">This configuration would not load. </span>
          {/* Platform text naming the paths and the PATCH that repairs them; never a value. */}
          <UntrustedText value={refusal.message} />
        </span>
      )}
      {unreadable ? (
        // WP-157 (a), backlog 413: the account's own row says it, once.
        <span data-credentials-unreadable={integration.id}>
          <span className="font-semibold">These credentials cannot be decrypted.</span>
          {/* The server's sentence only (rule 3); none invented here when it sends none. */}
          {integration.credentials_consequence === null ? null : (
            <>
              {' '}
              <UntrustedText value={integration.credentials_consequence} />.
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
  const projects = useProjects();
  const bound = useProjectsByIntegration(projects.data?.items);
  const commands = useOnboardingCommands();
  const navigate = useNavigate();
  const { now } = useServices();
  const nowMs = now();
  /** Which row's *Test connection* the shared probe answer is drawn under. */
  const [tested, setTested] = useState<string | null>(null);
  const items = integrations.data?.items ?? [];
  const providerOf = (integration: IntegrationSummary): IntegrationProvider | undefined =>
    providers.data?.items.find((entry) => entry.id === integration.provider);
  const live = items.filter((integration) => integration.retired_at === null).length;

  const newIntegration = (tone: 'primary' | 'default') => (
    <Link to="/integrations/new" className={buttonClassName(tone)}>
      New integration
    </Link>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Integrations" divider={false} actions={newIntegration('primary')} />
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
        <Blankslate
          size="spacious"
          icon={<PlugIcon size={24} />}
          title="No integrations yet"
          hint="An integration connects one external system — a ticket tracker, a git host, a chat workspace, an error tracker, a log store. Its credentials stay in the server's environment; they never come through the browser."
          action={newIntegration('default')}
        />
      ) : null}
      {items.length === 0 ? null : (
        <ListBox
          label="Integrations"
          header={
            <ListBoxHeader>
              <span className="font-semibold text-fg">{`${formatInteger(live)} connected`}</span>
              {items.length === live ? null : (
                <span className="text-fg-muted">{`${formatInteger(items.length - live)} retired`}</span>
              )}
            </ListBoxHeader>
          }
        >
          {items.map((integration) => {
            const provider = providerOf(integration);
            const { status, word } = integrationStatus(integration);
            const count = bound === null ? null : (bound.get(integration.id)?.length ?? 0);
            const boundLine = integration.retired_at === null ? boundText(count) : null;
            return (
              <Fragment key={integration.id}>
                <ListRow
                  leading={<StatusIcon status={status} label={word} />}
                  title={
                    <Link
                      to="/integrations/$integrationId"
                      params={{ integrationId: integration.id }}
                      className="hover:text-link hover:underline"
                    >
                      <UntrustedText value={integration.name} />
                    </Link>
                  }
                  meta={
                    <span className="flex flex-col gap-0.5" data-integration={integration.id}>
                      <span>
                        <UntrustedText value={providerName(integration, provider)} />
                        {` · ${INTEGRATION_TYPE_LABEL[integration.type]} · ${word} · ${checkedText(
                          integration,
                          nowMs,
                        )}`}
                      </span>
                      {integration.retired_at === null ? null : (
                        <span data-integration-retired={integration.id}>
                          Its credentials are deleted and nothing loads or changes it. It stays
                          listed because the audit names it.
                        </span>
                      )}
                      <IntegrationProblems integration={integration} />
                    </span>
                  }
                  {...(boundLine === null ? {} : { trailing: <span>{boundLine}</span> })}
                  actions={
                    <IntegrationActions
                      integration={integration}
                      provider={provider}
                      boundProjects={count}
                      onTest={() => {
                        setTested(integration.id);
                        commands.testIntegration.mutate(integration.id);
                      }}
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
      )}
    </div>
  );
};
