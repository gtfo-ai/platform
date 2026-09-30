/**
 * Integrations (product/10: "per-type cards with health, test connection, project-level settings").
 *
 * **The create and test controls are here** (WP-30, PROGRESS backlog 55). They were served by
 * WP-21 and called by nothing: the wizard's step 1 *binds* integrations that already exist and this
 * screen's own docblock attributed the create to the wizard, so `POST /api/integrations` could only
 * be reached with `curl` — and every check in the repository was green, because a client that
 * carries a call no component makes passes all of them (`endpoints.ts` names the path, so the
 * census sees it; `verify:ui` renders components and `verify:web-e2e` drives a fake backend, and
 * neither asks whether an exported endpoint has a caller). `endpoint-callers.test.tsx` is the guard
 * that closes the recurrence.
 *
 * ## A credential is never typed into this form
 *
 * `secret_refs` is field → the **name of an environment variable** the server reads for itself
 * (TD-020, BD-002), and the name must be on the operator-declared `APP_INTEGRATION_SECRET_ENV`
 * allow-list — empty by default, because a caller-chosen name could otherwise be `APP_SECRET_KEY`.
 * So a create can fail for a reason that is not about this form, and the server's own message is
 * rendered rather than replaced.
 *
 * ## The fields come from the server's catalogue, never from a copy (WP-100)
 *
 * Until WP-100 the provider was free text and the form sent `config: {}` whatever it named — and
 * every shipped provider's schema requires a key, so every integration created here answered 201
 * and then failed at *Test connection* and at every binding load (PROGRESS backlog 328). The form
 * now reads `GET /api/integrations/providers` — each provider's required non-credential fields and
 * its credential fields, read off the provider's own schema by the server — and renders one input
 * per field. A schema copied into the SPA would be a second list to keep true, and importing
 * `@platform/integrations` into the browser bundle would pull every adapter past TD-013's budget.
 * Every value is sent as text: the five shipped providers' required fields are all strings, and a
 * future non-string one is refused by the server by path rather than guessed at here.
 *
 * ## A stored configuration that would not load says so, and can be repaired here
 *
 * `config_refusal` is the server's reading of a row written before the create parsed (criterion 4):
 * the card shows its message and *Edit configuration* sends the `PATCH` it names — the required
 * fields, and the removal of every key the provider does not declare.
 */
import type { IntegrationProvider, IntegrationSummary } from '@platform/contracts';
import { type ReactElement, useState } from 'react';
import {
  useIntegrationProviders,
  useIntegrations,
  useOnboardingCommands,
  useRefusedDeliveries,
} from '../app/queries.js';
import { useServices } from '../app/services.js';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  formatDateTime,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { CopyableUrl, UntrustedProse, UntrustedText } from '../ui/untrusted.js';

const HEALTH_TONE: Record<string, BadgeTone> = {
  ok: 'success',
  degraded: 'warning',
  down: 'danger',
  unknown: 'neutral',
};

/** The provider's required non-credential fields, in the schema's own order. */
const requiredFieldsOf = (provider: IntegrationProvider): string[] =>
  provider.config_fields.filter((field) => field.required).map((field) => field.name);

/** The non-empty values, trimmed — an empty input is a field left out, which the server names. */
const filled = (values: Readonly<Record<string, string>>, names: readonly string[]) =>
  Object.fromEntries(
    names
      .map((name) => [name, (values[name] ?? '').trim()] as const)
      .filter(([, value]) => value !== ''),
  );

/**
 * *Edit configuration* — the `PATCH /api/integrations/:id` a `config_refusal` names (WP-100).
 *
 * It sets the provider's required fields, prefilled with what the row holds, and **removes** every
 * stored key the provider does not declare — the operator guide's old `host` for GitLab, the
 * British `organisation` for Sentry — so the repair of a row the old form or the old guide wrote is
 * one press. Optional fields keep their stored values: a key the form does not name is kept.
 */
const ConfigEditor = ({
  integration,
  provider,
}: {
  readonly integration: IntegrationSummary;
  readonly provider: IntegrationProvider;
}): ReactElement => {
  const commands = useOnboardingCommands();
  const required = requiredFieldsOf(provider);
  const declared = new Set(provider.config_fields.map((field) => field.name));
  const undeclared = Object.keys(integration.config).filter((key) => !declared.has(key));
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      required.map((name) => {
        const stored = integration.config[name];
        return [name, typeof stored === 'string' ? stored : ''];
      }),
    ),
  );
  return (
    <form
      className="flex flex-col gap-2"
      aria-label={`Configuration of ${integration.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        commands.patchIntegration.mutate({
          integrationId: integration.id,
          config: filled(values, required),
          remove: undeclared,
        });
      }}
    >
      {required.map((name) => (
        <Field
          key={name}
          label={name}
          hint={`Required by ${provider.display_name}.`}
          value={values[name] ?? ''}
          onChange={(event) => setValues({ ...values, [name]: event.target.value })}
        />
      ))}
      {undeclared.length === 0 ? null : (
        <p className="text-xs text-fg-muted" data-config-remove>
          Saving removes the keys {provider.display_name} does not declare:{' '}
          <UntrustedText value={undeclared.join(', ')} />
        </p>
      )}
      <div>
        <Button type="submit" tone="primary" disabled={commands.patchIntegration.isPending}>
          Save configuration
        </Button>
      </div>
      {commands.patchIntegration.isError ? (
        <ErrorNotice
          title="The configuration was not saved."
          detail={String(commands.patchIntegration.error)}
        />
      ) : null}
    </form>
  );
};

/**
 * *Add an integration* — one input per field the chosen provider asks for (WP-100, backlog 328).
 *
 * The credential is still never typed here: each credential field takes the **name** of the
 * environment variable the server reads it from (`secret_refs`, TD-020), on the operator-declared
 * `APP_INTEGRATION_SECRET_ENV` allow-list.
 */
const CreateIntegrationForm = ({
  providers,
}: {
  readonly providers: readonly IntegrationProvider[];
}): ReactElement => {
  const commands = useOnboardingCommands();
  const [draft, setDraft] = useState<{
    providerId: string;
    name: string;
    config: Record<string, string>;
    secretEnv: Record<string, string>;
  }>({ providerId: '', name: '', config: {}, secretEnv: {} });
  const provider = providers.find((entry) => entry.id === draft.providerId);
  const required = provider === undefined ? [] : requiredFieldsOf(provider);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (provider === undefined) {
          return;
        }
        commands.createIntegration.mutate({
          type: provider.type,
          provider: provider.id,
          name: draft.name.trim(),
          config: filled(draft.config, required),
          secret_refs: filled(draft.secretEnv, provider.secret_fields),
        });
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        Provider
        <select
          aria-label="Provider"
          value={draft.providerId}
          onChange={(event) =>
            // A different provider asks for different fields: the typed values do not carry over.
            setDraft({ ...draft, providerId: event.target.value, config: {}, secretEnv: {} })
          }
          className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
        >
          <option value="">Choose a provider</option>
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.display_name} ({entry.type})
            </option>
          ))}
        </select>
      </label>
      <Field
        label="Name"
        hint="Yours — what this account is called in the platform."
        value={draft.name}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      {provider === undefined
        ? null
        : required.map((name) => (
            <Field
              key={name}
              label={name}
              hint={`Required by ${provider.display_name}.`}
              value={draft.config[name] ?? ''}
              onChange={(event) =>
                setDraft({ ...draft, config: { ...draft.config, [name]: event.target.value } })
              }
            />
          ))}
      {provider === undefined
        ? null
        : provider.secret_fields.map((field) => (
            <Field
              key={field}
              label={`Environment variable for ${field}`}
              hint="The variable's name only, never its value. Its _FILE companion is read too (TD-020)."
              value={draft.secretEnv[field] ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  secretEnv: { ...draft.secretEnv, [field]: event.target.value },
                })
              }
            />
          ))}
      <div>
        <Button
          type="submit"
          tone="primary"
          disabled={provider === undefined || commands.createIntegration.isPending}
        >
          Add integration
        </Button>
      </div>
      {/* The server's own words: it names the path it refused, the variable, or the host. */}
      {commands.createIntegration.isError ? (
        <ErrorNotice
          title="The integration was not created."
          detail={String(commands.createIntegration.error)}
        />
      ) : null}
    </form>
  );
};

/**
 * What this integration's inbound half refused, and why (WP-44, PROGRESS backlog 198) — refusals
 * only since WP-73b (backlog 206): an ordinary ignore is filtered out by the server on its code.
 *
 * A chat click refused as `unmapped_identity` or `decision_refused: not_permitted` used to be
 * visible only in SQL and in the API process's log, so an operator debugging a dead button had no
 * surface. Fetched when opened; every line is `inbox.error` — redacted at the write, provider-derived
 * all the same (BD-022) — and the accounts named are the ones the identities screen offers to map.
 */
const RefusedDeliveries = ({ integrationId }: { readonly integrationId: string }): ReactElement => {
  const [open, setOpen] = useState(false);
  const refused = useRefusedDeliveries(integrationId, open);
  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button
          tone="ghost"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? 'Hide refused deliveries' : 'Refused deliveries'}
        </Button>
      </div>
      {!open ? null : refused.isPending ? (
        <Loading label="Loading refused deliveries…" />
      ) : refused.isError ? (
        <ErrorNotice
          title="The refused deliveries could not be loaded."
          detail={String(refused.error)}
        />
      ) : refused.data.items.length === 0 ? (
        <p className="text-xs text-fg-muted">Nothing this integration delivered was refused.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs" aria-label="Refused deliveries">
          {refused.data.items.map((delivery) => (
            <li
              key={delivery.delivery_id}
              className="flex flex-col gap-0.5 border-t border-line pt-1"
            >
              <span className="text-fg-muted">{formatDateTime(delivery.received_at)}</span>
              <UntrustedText value={delivery.error} />
              {delivery.reasons === null ? (
                <span className="text-fg-muted">
                  Received before the platform recorded reason codes, so it is listed whether it was
                  a refusal or an ordinary ignore.
                </span>
              ) : null}
              {delivery.unmapped === null ? (
                <span className="text-fg-muted">
                  Received before the platform recorded which account was refused.
                </span>
              ) : delivery.unmapped.length === 0 ? null : (
                <span>
                  Unmapped:{' '}
                  <UntrustedText
                    value={delivery.unmapped
                      .map((account) => `${account.provider}:${account.external_id}`)
                      .join(', ')}
                  />{' '}
                  — map them under Settings, Provider identities.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const IntegrationsScreen = (): ReactElement => {
  const integrations = useIntegrations();
  const commands = useOnboardingCommands();
  const { endpoints } = useServices();
  const [guide, setGuide] = useState<{
    id: string;
    markdown: string;
    title: string;
    webhookUrl: string | null;
  } | null>(null);
  const [guideError, setGuideError] = useState(false);
  const providers = useIntegrationProviders();
  const [editing, setEditing] = useState<string | null>(null);
  /** The catalogue entry for this row, or `undefined` for a provider this build does not ship. */
  const providerOf = (integration: IntegrationSummary): IntegrationProvider | undefined =>
    providers.data?.items.find((entry) => entry.id === integration.provider);

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>Integrations</SectionHeading>
      {integrations.isPending ? <Loading label="Loading integrations…" /> : null}
      {integrations.isError ? (
        <ErrorNotice
          title="Integrations could not be loaded."
          detail="Reading integration configuration needs the maintainer role (Q36)."
        />
      ) : null}
      {integrations.isSuccess && integrations.data.items.length === 0 ? (
        <EmptyState
          title="No integrations configured"
          hint="An integration connects one external system — a ticket board, a git host, a chat workspace, an error tracker, a log store. Credentials live in the environment or the secret store; they never come through the browser."
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {(integrations.data?.items ?? []).map((integration) => (
          <Card key={integration.id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">
                <UntrustedText value={integration.name} />
              </span>
              <Badge tone="accent">{integration.type}</Badge>
              <Badge>{integration.provider}</Badge>
              <Badge tone={HEALTH_TONE[integration.health.status] ?? 'neutral'}>
                {integration.health.status}
              </Badge>
            </div>
            {integration.health.checked_at === null ? null : (
              <p className="text-xs text-fg-muted">
                checked {formatDateTime(integration.health.checked_at)}
              </p>
            )}
            {integration.health.detail === null ? null : (
              <p className="text-xs">
                <UntrustedText value={integration.health.detail} />
              </p>
            )}
            {integration.config_refusal === null ? null : (
              <ErrorNotice
                title="This configuration would not load."
                detail={integration.config_refusal.message}
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                tone="primary"
                disabled={commands.testIntegration.isPending}
                onClick={() => {
                  commands.testIntegration.mutate(integration.id);
                }}
              >
                Test connection
              </Button>
              <Button
                onClick={() => {
                  setGuideError(false);
                  void endpoints
                    .integrationSetupGuide(integration.id)
                    .then((response) => {
                      setGuide({
                        id: integration.id,
                        markdown: response.markdown,
                        title: response.title,
                        webhookUrl: response.webhook_url,
                      });
                    })
                    .catch(() => {
                      setGuideError(true);
                    });
                }}
              >
                Setup guide
              </Button>
              {providerOf(integration) !== undefined ? (
                <Button
                  tone="ghost"
                  onClick={() => {
                    setEditing(editing === integration.id ? null : integration.id);
                  }}
                >
                  {editing === integration.id ? 'Close configuration' : 'Edit configuration'}
                </Button>
              ) : null}
            </div>
            {(() => {
              const provider = providerOf(integration);
              return editing !== integration.id || provider === undefined ? null : (
                <ConfigEditor integration={integration} provider={provider} />
              );
            })()}
            <RefusedDeliveries integrationId={integration.id} />
          </Card>
        ))}
      </div>

      {commands.testIntegration.isError ? (
        <ErrorNotice
          title="The connection test could not be run."
          detail={String(commands.testIntegration.error)}
        />
      ) : null}
      {commands.testIntegration.isSuccess ? (
        <Card className="flex flex-col gap-1 text-xs">
          <p className="font-semibold">
            Last test: {commands.testIntegration.data.ok ? 'passed' : 'failed'}
          </p>
          {commands.testIntegration.data.checks.map((check) => (
            <p key={check.name}>
              <Badge tone={check.ok ? 'success' : 'danger'}>{check.name}</Badge>{' '}
              {/* The provider's own words about the operator's own instance (BD-022). */}
              <UntrustedText value={check.detail} />
            </p>
          ))}
        </Card>
      ) : null}

      <Card className="flex flex-col gap-2">
        <SectionHeading>Add an integration</SectionHeading>
        <p className="text-xs text-fg-muted">
          The credential itself never comes through the browser: name the{' '}
          <strong>environment variable</strong> the server should read it from, and the server seals
          the value it reads (TD-020, BD-002). The name has to be on the operator-declared{' '}
          <code>APP_INTEGRATION_SECRET_ENV</code> allow-list, which is empty by default, and every
          URL must name a host on <code>APP_INTEGRATION_HOSTS</code>.
        </p>
        {providers.isPending ? <Loading label="Loading the shipped providers…" /> : null}
        {providers.isError ? (
          <ErrorNotice
            title="The shipped providers could not be loaded."
            detail={String(providers.error)}
          />
        ) : null}
        {providers.isSuccess ? <CreateIntegrationForm providers={providers.data.items} /> : null}
      </Card>

      {guideError ? <ErrorNotice title="That setup guide could not be loaded." /> : null}
      {guide === null ? null : (
        <Card className="flex flex-col gap-2">
          <SectionHeading
            actions={
              <Button
                tone="ghost"
                onClick={() => {
                  setGuide(null);
                }}
              >
                Close
              </Button>
            }
          >
            <UntrustedText value={guide.title} />
          </SectionHeading>
          {/*
            WP-95, PROGRESS backlog 272: the URL an operator pastes into the provider. The API has
            published it since WP-21 and this card kept only the guide's text, so the guides told the
            operator to call the API for it. It is copied, never followed (`CopyableUrl` says why),
            and a provider with no inbound half has none — which the card says rather than drawing
            an empty field.
          */}
          {guide.webhookUrl === null ? (
            <p className="text-xs text-fg-muted" data-webhook-url="none">
              This provider has no inbound half on this build, so there is no webhook URL to paste.
            </p>
          ) : (
            <CopyableUrl url={guide.webhookUrl} label="Webhook URL" />
          )}
          {/* A provider's own guide text: paragraphs and code fences, never HTML (BD-022). */}
          <UntrustedProse value={guide.markdown} />
        </Card>
      )}
    </div>
  );
};
