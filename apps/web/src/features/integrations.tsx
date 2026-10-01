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
 *
 * **Optional fields are offered too, each with a control of its declared type** (WP-114, PROGRESS
 * backlog 332): the catalogue publishes every field's `kind` read off the provider's schema, so a
 * boolean is a true/false choice and is sent as a boolean, a number as a number, a list as a list,
 * a choice as one of its values. An optional field left empty is not sent — the provider's default
 * applies. A value the control cannot type (a number that is not one) is sent as typed text, and
 * the server refuses it by path rather than this form guessing. A field of a kind the catalogue
 * calls `other` has no control and stays reachable through the `PATCH`.
 *
 * ## Re-seal and retire (WP-114, PROGRESS backlog 331)
 *
 * *Replace credentials* names new environment variables for the fields to rotate (the server reads
 * and seals them, exactly as the create does), and *Retire* destroys the credentials and keeps the
 * row, which the list then shows as retired with no controls: it refuses every write.
 *
 * ## A stored configuration that would not load says so, and can be repaired here
 *
 * `config_refusal` is the server's reading of a row written before the create parsed (criterion 4):
 * the card shows its message and *Edit configuration* sends the `PATCH` it names — the required
 * fields, any optional field the operator changed, and the removal of every key the provider does
 * not declare (or that the operator cleared).
 */
import type { IntegrationProvider, IntegrationSummary } from '@platform/contracts';
import { type ReactElement, useState } from 'react';
import { readErrorDetail } from '../api/read-error.js';
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

type ConfigField = IntegrationProvider['config_fields'][number];

/** The non-empty values, trimmed — an empty input is a field left out, which the server names. */
const filled = (values: Readonly<Record<string, string>>, names: readonly string[]) =>
  Object.fromEntries(
    names
      .map((name) => [name, (values[name] ?? '').trim()] as const)
      .filter(([, value]) => value !== ''),
  );

/** The optional fields this form offers a control for — every kind but `other` (WP-114). */
const optionalFieldsOf = (provider: IntegrationProvider): ConfigField[] =>
  provider.config_fields.filter((field) => !field.required && field.kind !== 'other');

/** A stored value as the text its control holds; `''` is "not set". */
const textOf = (stored: unknown): string => {
  if (typeof stored === 'string') {
    return stored;
  }
  if (typeof stored === 'number' || typeof stored === 'boolean') {
    return String(stored);
  }
  if (Array.isArray(stored)) {
    return stored.filter((entry) => typeof entry === 'string').join(', ');
  }
  return '';
};

/**
 * The typed value a control's text stands for, or `undefined` for an empty control (WP-114, backlog
 * 332). A text the kind cannot read is sent as itself, so the server refuses it **by path** — a
 * guess here (a `NaN` sent as `null`, an unknown choice dropped) would be a value nobody typed.
 */
const typedValueOf = (field: ConfigField, text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed === '') {
    return undefined;
  }
  switch (field.kind) {
    case 'boolean':
      return trimmed === 'true' ? true : trimmed === 'false' ? false : trimmed;
    case 'integer':
    case 'number': {
      const number = Number(trimmed);
      return Number.isFinite(number) ? number : trimmed;
    }
    case 'string_list':
      return trimmed
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
    case 'choice':
      return field.choices.find((choice) => String(choice) === trimmed) ?? trimmed;
    default:
      return trimmed;
  }
};

/** The typed values of every non-empty control among `fields`. */
const typedValues = (
  values: Readonly<Record<string, string>>,
  fields: readonly ConfigField[],
): Record<string, unknown> =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const value = typedValueOf(field, values[field.name] ?? '');
      return value === undefined ? [] : [[field.name, value] as const];
    }),
  );

/**
 * One configuration field's control, by its declared kind (WP-114, backlog 332): a select for a
 * boolean and a choice — whose first option, for an optional field, is the provider's default — a
 * number input for a number, and text otherwise. Labelled by the field's own name.
 */
const ConfigFieldControl = ({
  field,
  provider,
  value,
  onChange,
}: {
  readonly field: ConfigField;
  readonly provider: IntegrationProvider;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement => {
  const hint = field.required
    ? `Required by ${provider.display_name}.`
    : `Optional — left empty, ${provider.display_name}'s default applies.`;
  if (field.kind === 'boolean' || field.kind === 'choice') {
    const options = field.kind === 'boolean' ? ['true', 'false'] : field.choices.map(String);
    return (
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{field.name}</span>
        <select
          aria-label={field.name}
          data-config-kind={field.kind}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
        >
          <option value="">{field.required ? 'Choose a value' : 'Provider default'}</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <span className="text-xs text-fg-muted">{hint}</span>
      </label>
    );
  }
  return (
    <Field
      label={field.name}
      hint={field.kind === 'string_list' ? `${hint} Comma-separated.` : hint}
      data-config-kind={field.kind}
      {...(field.kind === 'integer' || field.kind === 'number'
        ? { type: 'number', step: field.kind === 'integer' ? '1' : 'any' }
        : {})}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
};

/**
 * *Edit configuration* — the `PATCH /api/integrations/:id` a `config_refusal` names (WP-100), and
 * since WP-114 every optional field with its typed control.
 *
 * It sets the provider's required fields, prefilled with what the row holds; an optional field is
 * sent only when the operator **changed** it (a field cleared that held a value is removed), so a
 * stored value nobody touched is never rewritten; and every stored key the provider does not
 * declare is **removed** — the operator guide's old `host` for GitLab, the British `organisation`
 * for Sentry — so the repair of a row the old form or the old guide wrote is one press.
 */
const ConfigEditor = ({
  integration,
  provider,
}: {
  readonly integration: IntegrationSummary;
  readonly provider: IntegrationProvider;
}): ReactElement => {
  const commands = useOnboardingCommands();
  const required = provider.config_fields.filter((field) => field.required);
  const optional = optionalFieldsOf(provider);
  const declared = new Set(provider.config_fields.map((field) => field.name));
  const undeclared = Object.keys(integration.config).filter((key) => !declared.has(key));
  const stored = Object.fromEntries(
    [...required, ...optional].map((field) => [field.name, textOf(integration.config[field.name])]),
  );
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...stored }));
  const changed = optional.filter((field) => (values[field.name] ?? '') !== stored[field.name]);
  const cleared = changed
    .filter((field) => (values[field.name] ?? '').trim() === '' && field.name in integration.config)
    .map((field) => field.name);
  return (
    <form
      className="flex flex-col gap-2"
      aria-label={`Configuration of ${integration.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        commands.patchIntegration.mutate({
          integrationId: integration.id,
          config: { ...typedValues(values, required), ...typedValues(values, changed) },
          remove: [...undeclared, ...cleared],
        });
      }}
    >
      {[...required, ...optional].map((field) => (
        <ConfigFieldControl
          key={field.name}
          field={field}
          provider={provider}
          value={values[field.name] ?? ''}
          onChange={(value) => setValues({ ...values, [field.name]: value })}
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
 * *Replace credentials* — `POST /api/integrations/:id/secrets` (WP-114, PROGRESS backlog 331). One
 * input per credential field, each taking the **name** of the environment variable the server reads
 * the new value from (TD-020, BD-002); a field left empty keeps its sealed value.
 */
const CredentialResealer = ({
  integration,
  provider,
}: {
  readonly integration: IntegrationSummary;
  readonly provider: IntegrationProvider;
}): ReactElement => {
  const commands = useOnboardingCommands();
  const [names, setNames] = useState<Record<string, string>>({});
  const secretRefs = Object.fromEntries(
    provider.secret_fields
      .map((field) => [field, (names[field] ?? '').trim()] as const)
      .filter(([, name]) => name !== ''),
  );
  return (
    <form
      className="flex flex-col gap-2"
      aria-label={`Credentials of ${integration.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        commands.resealIntegrationSecrets.mutate({ integrationId: integration.id, secretRefs });
      }}
    >
      <p className="text-xs text-fg-muted">
        Name the environment variable the server should read each new value from; a field left empty
        keeps its current credential. The old sealed value is deleted.
      </p>
      {provider.secret_fields.map((field) => (
        <Field
          key={field}
          label={`New environment variable for ${field}`}
          hint="The variable's name only, never its value. It must be on APP_INTEGRATION_SECRET_ENV."
          value={names[field] ?? ''}
          onChange={(event) => setNames({ ...names, [field]: event.target.value })}
        />
      ))}
      <div>
        <Button
          type="submit"
          tone="primary"
          disabled={
            Object.keys(secretRefs).length === 0 || commands.resealIntegrationSecrets.isPending
          }
        >
          Re-seal credentials
        </Button>
      </div>
      {commands.resealIntegrationSecrets.isError ? (
        <ErrorNotice
          title="The credentials were not replaced."
          detail={String(commands.resealIntegrationSecrets.error)}
        />
      ) : null}
      {commands.resealIntegrationSecrets.isSuccess ? (
        <p className="text-xs" role="status">
          {`Re-sealed ${commands.resealIntegrationSecrets.data.sealed_fields.join(', ')}. Test the connection to check the new value.`}
        </p>
      ) : null}
    </form>
  );
};

/**
 * *Retire* — `DELETE /api/integrations/:id` (WP-114). Two presses, because it destroys the
 * credentials; the server's own refusal (still bound, a live minted credential) is shown as it is.
 */
const RetireControl = ({
  integration,
}: {
  readonly integration: IntegrationSummary;
}): ReactElement => {
  const commands = useOnboardingCommands();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      {confirming ? (
        <div className="flex flex-col gap-1 text-xs" data-retire-confirm>
          <p>
            Retiring deletes this integration's credentials. The row stays, listed as retired, so
            the audit can still name it; nothing can load or change it again.
          </p>
          <div className="flex gap-2">
            <Button
              tone="danger"
              disabled={commands.retireIntegration.isPending}
              onClick={() => {
                commands.retireIntegration.mutate(integration.id);
              }}
            >
              Retire integration
            </Button>
            <Button
              tone="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            tone="ghost"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Retire
          </Button>
        </div>
      )}
      {commands.retireIntegration.isError ? (
        <ErrorNotice
          title="The integration was not retired."
          detail={String(commands.retireIntegration.error)}
        />
      ) : null}
    </div>
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
  const fields =
    provider === undefined
      ? []
      : [
          ...provider.config_fields.filter((field) => field.required),
          ...optionalFieldsOf(provider),
        ];
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
          config: typedValues(draft.config, fields),
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
        : fields.map((field) => (
            <ConfigFieldControl
              key={field.name}
              field={field}
              provider={provider}
              value={draft.config[field.name] ?? ''}
              onChange={(value) =>
                setDraft({ ...draft, config: { ...draft.config, [field.name]: value } })
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
  const [resealing, setResealing] = useState<string | null>(null);
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
          // Only a 403 is the role (WP-114, backlog 327's reading, `readErrorDetail`).
          detail={readErrorDetail(
            integrations.error,
            'Reading integration configuration needs the maintainer role (Q36).',
          )}
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
              {integration.retired_at === null ? (
                <Badge tone={HEALTH_TONE[integration.health.status] ?? 'neutral'}>
                  {integration.health.status}
                </Badge>
              ) : (
                <Badge tone="neutral">retired</Badge>
              )}
            </div>
            {integration.retired_at === null ? null : (
              <p className="text-xs text-fg-muted" data-integration-retired={integration.id}>
                Retired {formatDateTime(integration.retired_at)}: its credentials are deleted and
                nothing loads or changes it. It stays listed because the audit names it.
              </p>
            )}
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
            {integration.retired_at !== null ? null : (
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
                {providerOf(integration) !== undefined ? (
                  <Button
                    tone="ghost"
                    onClick={() => {
                      setResealing(resealing === integration.id ? null : integration.id);
                    }}
                  >
                    {resealing === integration.id ? 'Close credentials' : 'Replace credentials'}
                  </Button>
                ) : null}
              </div>
            )}
            {(() => {
              const provider = providerOf(integration);
              return editing !== integration.id ||
                provider === undefined ||
                integration.retired_at !== null ? null : (
                <ConfigEditor integration={integration} provider={provider} />
              );
            })()}
            {(() => {
              const provider = providerOf(integration);
              return resealing !== integration.id ||
                provider === undefined ||
                integration.retired_at !== null ? null : (
                <CredentialResealer integration={integration} provider={provider} />
              );
            })()}
            {integration.retired_at === null ? <RetireControl integration={integration} /> : null}
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
