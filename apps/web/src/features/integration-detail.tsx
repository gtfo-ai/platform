/**
 * One integration's page (`/integrations/$integrationId`, S-23.11a; research/19 § 5.2) — GitHub's
 * settings page for one installed app: a header with its health, provider and the one primary
 * action, **Test connection**; the `···` with the rest (`integration-forms.tsx`); and an
 * UnderlineNav of three tabs, each addressable as `?tab=`:
 *
 * - **Overview** — what is wrong with it, if anything (the server's words), its non-secret
 *   configuration under human labels with the key beside each, and the projects that bind it;
 * - **Setup guide** — the provider's own guide and the webhook URL to paste into the provider
 *   (WP-95, PROGRESS backlog 272), copied and never followed; a provider with no inbound half says
 *   it has none;
 * - **Refused deliveries** — what its inbound half refused, and why (WP-44).
 *
 * It reads nothing new: the row comes from the list read (`GET /api/integrations` has no read by
 * id), the guide and the refusals from their own endpoints when their tab is open, the bound
 * projects from each project's bindings read. An id the list does not hold is said plainly.
 */
import type { IntegrationProvider } from '@platform/contracts';
import { PlugIcon } from '@primer/octicons-react/PlugIcon';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import {
  useIntegrationProviders,
  useIntegrationSetupGuide,
  useIntegrations,
  useOnboardingCommands,
  useProjects,
  useProjectsByIntegration,
} from '../app/queries.js';
import { useServices } from '../app/services.js';
import { Blankslate } from '../ui/blankslate.js';
import { Button, buttonClassName } from '../ui/button.js';
import { configFieldLabel, INTEGRATION_TYPE_LABEL } from '../ui/humanize.js';
import { ErrorNotice } from '../ui/kit.js';
import type { NavLinkProps } from '../ui/nav-item.js';
import { PageHeader } from '../ui/page-header.js';
import { Skeleton } from '../ui/skeleton.js';
import { StateLabel } from '../ui/status.js';
import { UnderlineNav } from '../ui/underline-nav.js';
import { CodeText, CopyableUrl, UntrustedProse, UntrustedText } from '../ui/untrusted.js';
import { ConnectionTestResult } from './connection-test-result.js';
import { IntegrationActions, integrationStatus, RefusedDeliveries } from './integration-forms.js';
import { boundText, checkedText, IntegrationProblems, providerName } from './integrations.js';

export const INTEGRATION_TABS = ['overview', 'setup-guide', 'refused-deliveries'] as const;
export type IntegrationTab = (typeof INTEGRATION_TABS)[number];

const TAB_LABEL: Readonly<Record<IntegrationTab, string>> = {
  overview: 'Overview',
  'setup-guide': 'Setup guide',
  'refused-deliveries': 'Refused deliveries',
};

const BACK = 'rounded-sm text-sm text-link hover:underline';

/** A stored configuration value as text: a scalar as itself, a list joined, anything else as JSON. */
const valueText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.join(', ');
  }
  return JSON.stringify(value);
};

const SetupGuide = ({ integrationId }: { readonly integrationId: string }): ReactElement => {
  const guide = useIntegrationSetupGuide(integrationId, true);
  if (guide.isPending) {
    return <Skeleton label="Loading the setup guide…" lines={4} />;
  }
  if (guide.isError) {
    return <ErrorNotice title="That setup guide could not be loaded." error={guide.error} />;
  }
  return (
    <div className="flex flex-col gap-3" data-setup-guide={integrationId}>
      <h2 className="text-base font-semibold">
        <UntrustedText value={guide.data.title} />
      </h2>
      {guide.data.webhook_url === null ? (
        <p className="text-sm text-fg-muted" data-webhook-url="none">
          This provider has no inbound half on this build, so there is no webhook URL to paste.
        </p>
      ) : (
        // Copied, never followed: the webhook route answers a provider's signed POST.
        <CopyableUrl url={guide.data.webhook_url} label="Webhook URL" />
      )}
      {/* A provider's own guide text: paragraphs and code fences, never HTML (BD-022). */}
      <UntrustedProse value={guide.data.markdown} />
    </div>
  );
};

const Overview = ({
  integration,
  provider,
  projects,
}: {
  readonly integration: NonNullable<ReturnType<typeof useIntegrations>['data']>['items'][number];
  readonly provider: IntegrationProvider | undefined;
  readonly projects:
    | readonly { readonly id: string; readonly key: string; readonly name: string }[]
    | null;
}): ReactElement => {
  const entries = Object.entries(integration.config);
  // A value is shown only for a field the provider declares as configuration. The server strips the
  // provider's declared credential fields and nothing else, so a token an operator once stored under
  // a key the provider does not declare would be published as it is: its name is shown, never its
  // value — as the old screen did (it named undeclared keys only).
  const declared = new Set(
    (provider?.config_fields ?? [])
      .map((field) => field.name)
      .filter((name) => !(provider?.secret_fields ?? []).includes(name)),
  );
  return (
    <div className="flex flex-col gap-6">
      <IntegrationProblems integration={integration} />
      {integration.health.detail === null ? null : (
        <p className="text-sm">
          <UntrustedText value={integration.health.detail} />
        </p>
      )}
      <section aria-labelledby="integration-configuration" className="flex flex-col gap-2">
        <h2 id="integration-configuration" className="text-base font-semibold">
          Configuration
        </h2>
        <p className="text-xs text-fg-muted">
          Credentials are not shown: the server keeps them sealed and publishes only the rest.
        </p>
        {entries.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing is configured beyond the credentials.</p>
        ) : (
          <dl className="grid grid-cols-[minmax(10rem,auto)_1fr] gap-x-4 gap-y-2 rounded-md border border-line p-4 text-sm">
            {entries.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="flex flex-col text-fg-muted">
                  <span>{configFieldLabel(key)}</span>
                  <CodeText value={key} className="text-xs" />
                </dt>
                {declared.has(key) ? (
                  <dd className="min-w-0 break-words">
                    <UntrustedText value={valueText(value)} />
                  </dd>
                ) : (
                  <dd className="min-w-0 text-fg-muted" data-config-undeclared={key}>
                    Not a field this provider declares; value hidden.
                  </dd>
                )}
              </div>
            ))}
          </dl>
        )}
        {provider === undefined ? (
          <p className="text-xs text-fg-muted">
            This build does not ship this provider, so its fields cannot be edited here.
          </p>
        ) : null}
      </section>
      <section aria-labelledby="integration-projects" className="flex flex-col gap-2">
        <h2 id="integration-projects" className="text-base font-semibold">
          Projects
        </h2>
        {projects === null ? (
          <p className="text-sm text-fg-muted">Which projects bind it could not be read.</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No project binds it yet. A project binds it in its first wizard step, or under its
            settings, Connections.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  to="/projects/$key/settings"
                  params={{ key: project.key }}
                  className="text-link hover:underline"
                >
                  <UntrustedText value={project.name} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export const IntegrationDetailScreen = ({
  integrationId,
  tab,
}: {
  readonly integrationId: string;
  readonly tab: IntegrationTab;
}): ReactElement => {
  const integrations = useIntegrations();
  const providers = useIntegrationProviders();
  const projects = useProjects();
  const bound = useProjectsByIntegration(projects.data?.items);
  const commands = useOnboardingCommands();
  const { now } = useServices();
  const back = (
    <Link to="/integrations" className={BACK}>
      ← Integrations
    </Link>
  );

  if (integrations.isPending) {
    return <Skeleton label="Loading the integration…" lines={4} />;
  }
  if (integrations.isError) {
    return <ErrorNotice title="Integrations could not be loaded." error={integrations.error} />;
  }
  const integration = integrations.data.items.find((item) => item.id === integrationId);
  if (integration === undefined) {
    return (
      <Blankslate
        size="spacious"
        icon={<PlugIcon size={24} />}
        title="No such integration"
        hint="It is not among this organisation's integrations. It may have been created on another instance, or the link is wrong."
        action={
          <Link to="/integrations" className={buttonClassName('default')}>
            Back to integrations
          </Link>
        }
      />
    );
  }
  const provider = providers.data?.items.find((entry) => entry.id === integration.provider);
  const { status, word } = integrationStatus(integration);
  const boundProjects = bound === null ? null : (bound.get(integration.id) ?? []);
  const boundLine =
    integration.retired_at === null ? boundText(boundProjects?.length ?? null) : null;
  const retired = integration.retired_at !== null;

  const items = INTEGRATION_TABS.map((id) => ({
    id,
    label: TAB_LABEL[id],
    current: id === tab,
    render: (props: NavLinkProps) => (
      <Link
        to="/integrations/$integrationId"
        params={{ integrationId }}
        search={id === 'overview' ? {} : { tab: id }}
        {...props}
      />
    ),
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-0">
        <PageHeader
          back={back}
          divider={false}
          title={<UntrustedText value={integration.name} />}
          state={<StateLabel status={status}>{word}</StateLabel>}
          meta={
            <span>
              <UntrustedText value={providerName(integration, provider)} />
              {` · ${INTEGRATION_TYPE_LABEL[integration.type]} · ${checkedText(integration, now())}${
                boundLine === null ? '' : ` · ${boundLine}`
              }`}
            </span>
          }
          {...(retired
            ? {}
            : {
                actions: (
                  <>
                    <Button
                      tone="primary"
                      disabled={commands.testIntegration.isPending}
                      onClick={() => {
                        commands.testIntegration.mutate(integration.id);
                      }}
                    >
                      Test connection
                    </Button>
                    <IntegrationActions
                      integration={integration}
                      provider={provider}
                      boundProjects={boundProjects?.length ?? null}
                    />
                  </>
                ),
              })}
        />
        <UnderlineNav label="Integration" items={items} />
      </div>
      {retired ? (
        <p className="text-sm text-fg-muted" data-integration-retired={integration.id}>
          Retired: its credentials are deleted and nothing loads or changes it. It stays listed
          because the audit names it.
        </p>
      ) : null}
      {/* WP-155 (backlog 451): the one rendering the list and the wizard share. */}
      <ConnectionTestResult test={commands.testIntegration} />
      {tab === 'overview' ? (
        <Overview integration={integration} provider={provider} projects={boundProjects} />
      ) : null}
      {tab === 'setup-guide' ? <SetupGuide integrationId={integration.id} /> : null}
      {tab === 'refused-deliveries' ? <RefusedDeliveries integrationId={integration.id} /> : null}
    </div>
  );
};
