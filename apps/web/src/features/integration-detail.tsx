/**
 * One integration's page (`/integrations/$integrationId`, S-23.11a; research/19 § 5.2) — GitHub's
 * settings page for one installed app: a header with its health, provider and the one primary
 * action, **Test connection**; the `···` with the rest (`integration-forms.tsx`); and an
 * UnderlineNav of three tabs, each addressable as `?tab=`:
 *
 * - **Overview** — what is wrong with it, if anything (the server's words); its health now and the
 *   evidence it was read from — the last call, the last delivery, the last test — each with its age
 *   (S-25.3); the projects that use it, each with what it uses it for ("Tickets from AUT · Picked
 *   up with label agentic"); and its non-secret configuration under human labels only — the raw
 *   keys are the server's refusals' and the edit dialog's hints, not this page's (research/21 S10);
 * - **Setup guide** — the provider's own guide and the webhook URL to paste into the provider
 *   (WP-95, PROGRESS backlog 272), copied and never followed; a provider with no inbound half says
 *   it has none;
 * - **Rejected webhooks** — what its inbound half refused, and why (WP-44); the tab's address is
 *   still `?tab=refused-deliveries`, so a link saved before S-25.3 opens it.
 *
 * It reads nothing new: the row comes from the list read (`GET /api/integrations` has no read by
 * id) — its health and its projects included since S-25.3 — and the guide and the refusals from
 * their own endpoints when their tab is open. An id the list does not hold is said plainly.
 */
import type { IntegrationProvider, IntegrationSummary } from '@platform/contracts';
import { INTEGRATION_HEALTH_STALE_AFTER_HOURS } from '@platform/contracts';
import { PlugIcon } from '@primer/octicons-react/PlugIcon';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import {
  useIntegrationProviders,
  useIntegrationSetupGuide,
  useIntegrations,
  useOnboardingCommands,
} from '../app/queries.js';
import { useServices } from '../app/services.js';
import { Blankslate } from '../ui/blankslate.js';
import { Button, buttonClassName } from '../ui/button.js';
import {
  configFieldLabel,
  INTEGRATION_HEALTH_LABEL,
  INTEGRATION_TYPE_LABEL,
} from '../ui/humanize.js';
import { ErrorNotice, formatDateTime } from '../ui/kit.js';
import type { NavLinkProps } from '../ui/nav-item.js';
import { PageHeader } from '../ui/page-header.js';
import { PROVIDER_TRADEMARK_NOTICE, ProviderIcon } from '../ui/provider-icon.js';
import { formatAgo } from '../ui/relative-time.js';
import { Skeleton } from '../ui/skeleton.js';
import { StateLabel } from '../ui/status.js';
import { UnderlineNav } from '../ui/underline-nav.js';
import { CopyableUrl, UntrustedProse, UntrustedText } from '../ui/untrusted.js';
import { ConnectionTestResult } from './connection-test-result.js';
import {
  IntegrationActions,
  type IntegrationDialog,
  integrationStatus,
  RefusedDeliveries,
} from './integration-forms.js';
import { healthText, IntegrationProblems, providerName, UsedBy } from './integrations.js';

export const INTEGRATION_TABS = ['overview', 'setup-guide', 'refused-deliveries'] as const;
export type IntegrationTab = (typeof INTEGRATION_TABS)[number];

const TAB_LABEL: Readonly<Record<IntegrationTab, string>> = {
  overview: 'Overview',
  'setup-guide': 'Setup guide',
  'refused-deliveries': 'Rejected webhooks',
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

/** "5 m ago", or the instant when it is too old for a relative age. */
const agoText = (at: string, nowMs: number): string => formatAgo(at, nowMs) ?? formatDateTime(at);

/**
 * The evidence the health was read from (S-25.3), each fact with its age: the last call that
 * reached the provider, the last verified delivery, the last *Test connection*. "None" is said, not
 * left out, so an empty fact is not mistaken for one that did not load.
 */
const HealthFacts = ({
  integration,
  nowMs,
}: {
  readonly integration: IntegrationSummary;
  readonly nowMs: number;
}): ReactElement => {
  const { last_call: call, last_delivery_at: delivery } = integration.activity;
  const probe = integration.health;
  return (
    <section aria-labelledby="integration-health" className="flex flex-col gap-2">
      <h2 id="integration-health" className="text-base font-semibold">
        Health
      </h2>
      {integration.current_health.status === 'not_checked_recently' ? (
        <p className="text-sm text-fg-muted" data-health-stale="">
          {`Nothing has called it, delivered from it or tested it in the last ${INTEGRATION_HEALTH_STALE_AFTER_HOURS} hours, so its health is not known now.`}
        </p>
      ) : null}
      <dl
        className="grid grid-cols-[minmax(10rem,auto)_1fr] gap-x-4 gap-y-2 rounded-md border border-line p-4 text-sm"
        data-health-facts=""
      >
        <dt className="text-fg-muted">Last call</dt>
        <dd data-health-fact="call">
          {call === null
            ? 'None yet'
            : `${call.ok ? 'Succeeded' : 'Failed'} ${agoText(call.at, nowMs)}`}
        </dd>
        <dt className="text-fg-muted">Last delivery</dt>
        <dd data-health-fact="delivery">
          {delivery === null ? 'None yet' : `Received ${agoText(delivery, nowMs)}`}
        </dd>
        <dt className="text-fg-muted">Last connection test</dt>
        <dd data-health-fact="probe">
          {probe.checked_at === null
            ? 'Never tested'
            : `${INTEGRATION_HEALTH_LABEL[probe.status]} ${agoText(probe.checked_at, nowMs)}`}
        </dd>
      </dl>
      {probe.detail === null ? null : (
        <p className="text-sm">
          <UntrustedText value={probe.detail} />
        </p>
      )}
    </section>
  );
};

const Overview = ({
  integration,
  provider,
  onDialog,
  canWrite,
  nowMs,
}: {
  readonly integration: IntegrationSummary;
  readonly provider: IntegrationProvider | undefined;
  /** The list read's `can_write`: a problem line offers its repair only then (S-23.23). */
  readonly canWrite: boolean;
  /** Opens one of the header menu's dialogs from a problem line (S-23.22). */
  readonly onDialog: (dialog: IntegrationDialog) => void;
  readonly nowMs: number;
}): ReactElement => {
  const entries = Object.entries(integration.config);
  // A value is shown only for a field the provider declares as configuration. The server strips the
  // provider's declared credential fields and nothing else, so a token an operator once stored under
  // a key the provider does not declare would be published as it is: its label is shown, never its
  // value — as the old screen did (it named undeclared keys only).
  const declared = new Set(
    (provider?.config_fields ?? [])
      .map((field) => field.name)
      .filter((name) => !(provider?.secret_fields ?? []).includes(name)),
  );
  return (
    <div className="flex flex-col gap-6">
      <IntegrationProblems
        integration={integration}
        {...(provider === undefined || !canWrite
          ? {}
          : {
              onEditConfiguration: () => {
                onDialog('configuration');
              },
              onReplaceCredentials: () => {
                onDialog('credentials');
              },
            })}
      />
      <HealthFacts integration={integration} nowMs={nowMs} />
      <section aria-labelledby="integration-projects" className="flex flex-col gap-2">
        <h2 id="integration-projects" className="text-base font-semibold">
          Projects
        </h2>
        {integration.used_by.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No project uses it yet. A project picks it in its first wizard step, or in its settings
            under Connections.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" aria-label="Projects that use it">
            {integration.used_by.map((user) => (
              <li key={user.project_id} data-integration-user={user.project_key}>
                <Link
                  to="/projects/$key/settings"
                  params={{ key: user.project_key }}
                  className="text-link hover:underline"
                >
                  <UntrustedText value={user.project_name} />
                </Link>
                {/* S-25.3: what the project uses it for, in the catalogue's words and its values. */}
                {user.uses.map((use) => (
                  <span key={use.label} className="text-fg-muted">
                    {` · ${use.label} `}
                    <UntrustedText value={use.value} />
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="integration-configuration" className="flex flex-col gap-2">
        <h2 id="integration-configuration" className="text-base font-semibold">
          Configuration
        </h2>
        <p className="text-xs text-fg-muted">Secrets are stored encrypted and never shown.</p>
        {entries.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing is configured beyond the credentials.</p>
        ) : (
          <dl className="grid grid-cols-[minmax(10rem,auto)_1fr] gap-x-4 gap-y-2 rounded-md border border-line p-4 text-sm">
            {entries.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-fg-muted">{configFieldLabel(key)}</dt>
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
  const [dialog, setDialog] = useState<IntegrationDialog>(null);
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
  const retired = integration.retired_at !== null;
  const nowMs = now();
  // S-23.23: the test and every write are an administrator's (`integration.write`).
  const canWrite = integrations.data.can_write;

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
            <span className="inline-flex flex-wrap items-center gap-x-1">
              <ProviderIcon type={integration.type} name={providerName(integration, provider)} />
              {` · ${INTEGRATION_TYPE_LABEL[integration.type]} · ${healthText(integration, nowMs)}`}
              {retired ? null : (
                <>
                  {' · '}
                  <UsedBy users={integration.used_by} />
                </>
              )}
            </span>
          }
          {...(retired || !canWrite
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
                      boundProjects={integration.used_by.length}
                      dialog={dialog}
                      onDialogChange={setDialog}
                      canWrite
                    />
                  </>
                ),
              })}
        />
        <UnderlineNav label="Integration" items={items} />
      </div>
      {!retired && !canWrite ? (
        <p className="text-sm text-fg-muted" data-may-not-write="">
          Administrators test and change integrations.
        </p>
      ) : null}
      {retired ? (
        <p className="text-sm text-fg-muted" data-integration-retired={integration.id}>
          Retired: its credentials are deleted and nothing loads or changes it. It stays listed
          because the audit names it.
        </p>
      ) : null}
      {/* WP-155 (backlog 451): the one rendering the list and the wizard share. */}
      <ConnectionTestResult test={commands.testIntegration} />
      {tab === 'overview' ? (
        <Overview
          integration={integration}
          provider={provider}
          onDialog={setDialog}
          canWrite={canWrite && !retired}
          nowMs={nowMs}
        />
      ) : null}
      {tab === 'setup-guide' ? <SetupGuide integrationId={integration.id} /> : null}
      {tab === 'refused-deliveries' ? <RefusedDeliveries integrationId={integration.id} /> : null}
      {/* research/21 § 8: the providers are named, never drawn with their marks. */}
      <p className="text-xs text-fg-muted" data-trademark-notice="">
        {PROVIDER_TRADEMARK_NOTICE}
      </p>
    </div>
  );
};
