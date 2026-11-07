/**
 * The pieces the Integrations list, an integration's own page and the add-integration wizard share
 * (S-23.11a): each field's control, the configuration editor, the credential re-seal, the retire
 * confirmation, the refused deliveries, the setup guide, and the `···` menu that opens them.
 *
 * ## A credential is never typed into a form here
 *
 * `secret_refs` is field → the **name of an environment variable** the server reads for itself
 * (TD-020, BD-002), and the name must be on the operator-declared `APP_INTEGRATION_SECRET_ENV`
 * allow-list — empty by default, because a caller-chosen name could otherwise be `APP_SECRET_KEY`.
 * So a create or a re-seal can fail for a reason that is not about the form, and the server's own
 * message is rendered rather than replaced.
 *
 * ## The fields come from the server's catalogue, never from a copy (WP-100)
 *
 * `GET /api/integrations/providers` publishes each provider's fields read off its own schema — the
 * name, whether it is required, its `kind` — and the controls below are drawn from it, one per field
 * of a kind the catalogue names (WP-114: a boolean is a yes/no choice sent as a boolean, a number a
 * number, a list a list, a choice one of its values; an optional field left empty is not sent, and
 * a field of kind `other` has no control and stays reachable through the `PATCH`). A schema copied
 * into the SPA would be a second list to keep true, and importing `@platform/integrations` into the
 * browser bundle would pull every adapter past TD-013's budget.
 *
 * **Labels are human, the key is in the hint** (research/19 § 5.2): `site_url` is labelled *Site
 * URL* (`configFieldLabel`), and its hint names `site_url`, because that key is what the operator
 * guide and the server's refusals ("refused … at: site_url") name.
 *
 * ## Repair, re-seal and retire (WP-100, WP-114)
 *
 * *Edit configuration* sends the `PATCH` a `config_refusal` names — the required fields, any optional
 * field the operator changed, and the removal of every key the provider does not declare (or that
 * the operator cleared). *Replace credentials* names new environment variables for the fields to
 * rotate. *Retire* destroys the credentials and keeps the row, listed as retired with no controls.
 * Each opens in a `Dialog`: a human's multi-field or destructive action (research/19 § 3.9).
 */
import type { IntegrationProvider, IntegrationSummary } from '@platform/contracts';
import { INTEGRATION_HEALTH_STALE_AFTER_HOURS } from '@platform/contracts';
import { KebabHorizontalIcon } from '@primer/octicons-react/KebabHorizontalIcon';
import { type ReactElement, useId, useState } from 'react';
import { useOnboardingCommands, useRefusedDeliveries } from '../app/queries.js';
import { ActionMenu, ActionMenuItem, ActionMenuSeparator } from '../ui/action-menu.js';
import { ForAdministrators } from '../ui/admin-notes.js';
import { Button, IconButton } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { choiceLabel, configFieldLabel } from '../ui/humanize.js';
import { ErrorNotice, Field, formatDateTime } from '../ui/kit.js';
import { ListBox, ListRow } from '../ui/list-box.js';
import { Select } from '../ui/select.js';
import { Skeleton } from '../ui/skeleton.js';
import type { Status } from '../ui/status.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import {
  INTEGRATION_CURRENT_HEALTH_LABEL,
  type IntegrationCurrentHealthStatus,
} from '../ui/words/integrations.js';

export type ConfigField = IntegrationProvider['config_fields'][number];

// ── Health ───────────────────────────────────────────────────────────────────

const HEALTH_STATUS: Readonly<Record<IntegrationCurrentHealthStatus, Status>> = {
  working: 'success',
  degraded: 'waiting',
  failing: 'failure',
  not_checked_recently: 'idle',
  never_checked: 'queued',
};

const STALE_AFTER_MS = INTEGRATION_HEALTH_STALE_AFTER_HOURS * 60 * 60 * 1000;

/**
 * `current_health.status` as of **the browser's** clock (S-25.5): the server decided it against the
 * stale bound when it answered, and a page left open — or a cached read — can outlive that. So a
 * `working` whose evidence (`current_health.at`) is older than the bound is said as *Not checked
 * recently*, never *Working*: the one word a row may not claim on old evidence.
 */
export const currentHealthStatus = (
  integration: Pick<IntegrationSummary, 'current_health'>,
  nowMs: number,
): IntegrationCurrentHealthStatus => {
  const { status, at } = integration.current_health;
  return status === 'working' && at !== null && nowMs - Date.parse(at) > STALE_AFTER_MS
    ? 'not_checked_recently'
    : status;
};

/**
 * The status icon and its word for a row: its health **now** — read by the server from its traffic
 * and the last probe against the stale bound (S-25.3), never the probe alone, and held to the bound
 * by this clock ({@link currentHealthStatus}) — or *Retired*.
 */
export const integrationStatus = (
  integration: IntegrationSummary,
  nowMs: number,
): { readonly status: Status; readonly word: string } => {
  if (integration.retired_at !== null) {
    return { status: 'cancelled', word: 'Retired' };
  }
  const current = currentHealthStatus(integration, nowMs);
  return { status: HEALTH_STATUS[current], word: INTEGRATION_CURRENT_HEALTH_LABEL[current] };
};

// ── Values ───────────────────────────────────────────────────────────────────

/** The non-empty values, trimmed — an empty input is a field left out, which the server names. */
export const filled = (values: Readonly<Record<string, string>>, names: readonly string[]) =>
  Object.fromEntries(
    names
      .map((name) => [name, (values[name] ?? '').trim()] as const)
      .filter(([, value]) => value !== ''),
  );

/** The optional fields a form offers a control for — every kind but `other` (WP-114). */
export const optionalFieldsOf = (provider: IntegrationProvider): ConfigField[] =>
  provider.config_fields.filter((field) => !field.required && field.kind !== 'other');

/** A stored value as the text its control holds; `''` is "not set". */
export const textOf = (stored: unknown): string => {
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
export const typedValues = (
  values: Readonly<Record<string, string>>,
  fields: readonly ConfigField[],
): Record<string, unknown> =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const value = typedValueOf(field, values[field.name] ?? '');
      return value === undefined ? [] : [[field.name, value] as const];
    }),
  );

// ── Controls ─────────────────────────────────────────────────────────────────

/**
 * What switching a field costs, said beside its control (WP-282): a field whose value is a trust
 * decision carries the residual the decision accepts, in platform text, so the administrator reads
 * it where the choice is made. Keyed by field name; a field without one shows only its hint.
 */
export const CONFIG_FIELD_RESIDUALS: Readonly<Record<string, string>> = {
  // TD-031 decision 5, Q124 (a), BD-032's residual — default `deny`.
  remote_run_credential:
    'With allow, a remote worker runs this project with its static run token or its deploy key: a static token sits on a developer’s machine for the run’s life and is valid for up to 90 days on the project; a deploy key makes this core sign for the run, and its reach is every project the key is enabled on. Neither can be revoked per run. Minted run credentials need no opt-in. Default: deny.',
};

/**
 * One configuration field's control, by its declared kind (WP-114, backlog 332): a select for a
 * boolean and a choice — whose first option, for an optional field, is the provider's default — a
 * number input for a number, and text otherwise. Labelled in words, with the key in the hint.
 */
export const ConfigFieldControl = ({
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
  const id = useId();
  const label = configFieldLabel(field.name);
  const hint = `${
    field.required
      ? `Required by ${provider.display_name}.`
      : `Optional — left empty, ${provider.display_name}'s default applies.`
  } Key: ${field.name}.`;
  if (field.kind === 'boolean' || field.kind === 'choice') {
    const options =
      field.kind === 'boolean'
        ? [
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]
        : field.choices.map((choice) => ({ value: String(choice), label: choiceLabel(choice) }));
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <Select
          id={id}
          aria-describedby={`${id}-hint`}
          data-config-kind={field.kind}
          data-config-key={field.name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{field.required ? 'Choose a value' : 'Provider default'}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <p id={`${id}-hint`} className="text-xs text-fg-muted">
          {hint}
        </p>
        {CONFIG_FIELD_RESIDUALS[field.name] === undefined ? null : (
          <p className="text-xs text-fg-muted" data-config-residual={field.name}>
            {CONFIG_FIELD_RESIDUALS[field.name]}
          </p>
        )}
      </div>
    );
  }
  return (
    <Field
      label={label}
      hint={field.kind === 'string_list' ? `${hint} Comma-separated.` : hint}
      data-config-kind={field.kind}
      data-config-key={field.name}
      {...(field.kind === 'integer' || field.kind === 'number'
        ? { type: 'number', step: field.kind === 'integer' ? '1' : 'any' }
        : {})}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
};

/** A credential field: the environment variable's **name**, labelled in words (`api_token` → API token). */
export const SecretEnvField = ({
  field,
  value,
  onChange,
  replacing = false,
}: {
  readonly field: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly replacing?: boolean;
}): ReactElement => (
  <Field
    label={`${replacing ? 'New environment variable' : 'Environment variable'} for ${configFieldLabel(field)}`}
    hint={`Key: ${field}. The variable's name only, never its value; an administrator must allow the name first.`}
    data-secret-key={field}
    autoComplete="off"
    spellCheck={false}
    value={value}
    onChange={(event) => onChange(event.target.value)}
  />
);

/** The one line every credential form says, before its fields. */
export const CREDENTIAL_SENTENCE =
  'The credential itself never crosses the browser: name the environment variable that holds it, and the server reads and seals the value itself.';

// ── Edit configuration ───────────────────────────────────────────────────────

/**
 * *Edit configuration* — the `PATCH /api/integrations/:id` a `config_refusal` names (WP-100), and
 * every optional field with its typed control (WP-114).
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
  formId,
  onSaved,
}: {
  readonly integration: IntegrationSummary;
  readonly provider: IntegrationProvider;
  readonly formId: string;
  readonly onSaved: () => void;
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
      id={formId}
      className="flex flex-col gap-3"
      aria-label={`Configuration of ${sanitiseUntrusted(integration.name)}`}
      onSubmit={(event) => {
        event.preventDefault();
        commands.patchIntegration.mutate(
          {
            integrationId: integration.id,
            config: { ...typedValues(values, required), ...typedValues(values, changed) },
            remove: [...undeclared, ...cleared],
          },
          { onSuccess: onSaved },
        );
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
      {commands.patchIntegration.isError ? (
        <ErrorNotice
          title="The configuration was not saved."
          error={commands.patchIntegration.error}
        />
      ) : null}
    </form>
  );
};

// ── Replace credentials ──────────────────────────────────────────────────────

/**
 * *Replace credentials* — `POST /api/integrations/:id/secrets` (WP-114, PROGRESS backlog 331). One
 * input per credential field, each taking the **name** of the environment variable the server reads
 * the new value from (TD-020, BD-002); a field left empty keeps its sealed value.
 */
const CredentialResealer = ({
  integration,
  provider,
  formId,
}: {
  readonly integration: IntegrationSummary;
  readonly provider: IntegrationProvider;
  readonly formId: string;
}): ReactElement => {
  const commands = useOnboardingCommands();
  const [names, setNames] = useState<Record<string, string>>({});
  const secretRefs = filled(names, provider.secret_fields);
  return (
    <form
      id={formId}
      className="flex flex-col gap-3"
      aria-label={`Credentials of ${sanitiseUntrusted(integration.name)}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (Object.keys(secretRefs).length === 0) {
          return;
        }
        commands.resealIntegrationSecrets.mutate({ integrationId: integration.id, secretRefs });
      }}
    >
      <p className="text-xs text-fg-muted">
        {`${CREDENTIAL_SENTENCE} A field left empty keeps its current credential; the old sealed value is deleted.`}
      </p>
      {provider.secret_fields.map((field) => (
        <SecretEnvField
          key={field}
          field={field}
          replacing
          value={names[field] ?? ''}
          onChange={(value) => setNames({ ...names, [field]: value })}
        />
      ))}
      <ForAdministrators note="secret_env" />
      {commands.resealIntegrationSecrets.isError ? (
        <ErrorNotice
          title="The credentials were not replaced."
          error={commands.resealIntegrationSecrets.error}
        />
      ) : null}
      {commands.resealIntegrationSecrets.isSuccess ? (
        <p className="text-xs" role="status">
          {`Re-sealed ${commands.resealIntegrationSecrets.data.sealed_fields
            .map(configFieldLabel)
            .join(
              ', ',
            )} (${commands.resealIntegrationSecrets.data.sealed_fields.join(', ')}). Test the connection to check the new value.`}
        </p>
      ) : null}
    </form>
  );
};

// ── The menu and its dialogs ─────────────────────────────────────────────────

/** Which of an integration's dialogs is open; `null` for none. */
export type IntegrationDialog = 'configuration' | 'credentials' | 'retire' | null;
type OpenDialog = IntegrationDialog;

/**
 * The `···` of an integration: *Test connection* and *Setup guide* when the caller offers them (the
 * list does; the integration's own page has them as its primary button and its tab), then *Edit
 * configuration* and *Replace credentials* — for a provider this build ships, the only ones whose
 * fields it knows — and *Retire*. A retired integration has no menu at all: it refuses every write.
 *
 * **Only an administrator writes integrations** (`integration.write`, S-23.23): for anyone else
 * (`canWrite: false`, the list read's `can_write`) the menu keeps only the reads — the setup guide —
 * and draws nothing when there is none.
 */
export const IntegrationActions = ({
  integration,
  provider,
  boundProjects,
  onTest,
  onSetupGuide,
  dialog,
  onDialogChange,
  canWrite,
}: {
  readonly integration: IntegrationSummary;
  readonly provider: IntegrationProvider | undefined;
  /** How many projects bind it, or `null` when that is not known. */
  readonly boundProjects: number | null;
  /** The list read's `can_write`: the test, edit, credentials and retire are offered only then. */
  readonly canWrite: boolean;
  readonly onTest?: () => void;
  readonly onSetupGuide?: () => void;
  /**
   * The open dialog, when the caller holds it — so a problem line's *Edit configuration* opens the
   * same dialog as the menu (S-23.22). Left out, the menu holds it itself.
   */
  readonly dialog?: OpenDialog;
  readonly onDialogChange?: (dialog: OpenDialog) => void;
}): ReactElement | null => {
  const [ownOpen, setOwnOpen] = useState<OpenDialog>(null);
  const open = dialog === undefined ? ownOpen : dialog;
  const setOpen = onDialogChange ?? setOwnOpen;
  // A dialog's form is mounted afresh each time it opens, so a closed one keeps nothing typed.
  const [generation, setGeneration] = useState(0);
  const configFormId = useId();
  const credentialsFormId = useId();
  const commands = useOnboardingCommands();
  if (integration.retired_at !== null || (!canWrite && onSetupGuide === undefined)) {
    return null;
  }
  const name = sanitiseUntrusted(integration.name);
  if (!canWrite) {
    return (
      <ActionMenu
        trigger={
          <IconButton
            aria-label={`Actions for ${name}`}
            icon={<KebabHorizontalIcon size={16} />}
            tone="invisible"
          />
        }
      >
        <ActionMenuItem onSelect={onSetupGuide}>Setup guide</ActionMenuItem>
      </ActionMenu>
    );
  }
  const show = (dialog: OpenDialog): void => {
    setGeneration(generation + 1);
    commands.retireIntegration.reset();
    setOpen(dialog);
  };
  const onOpenChange = (next: boolean): void => {
    if (!next) {
      setOpen(null);
    }
  };
  return (
    <>
      <ActionMenu
        trigger={
          <IconButton
            aria-label={`Actions for ${name}`}
            icon={<KebabHorizontalIcon size={16} />}
            tone="invisible"
          />
        }
      >
        {onTest === undefined ? null : (
          <ActionMenuItem onSelect={onTest}>Test connection</ActionMenuItem>
        )}
        {onSetupGuide === undefined ? null : (
          <ActionMenuItem onSelect={onSetupGuide}>Setup guide</ActionMenuItem>
        )}
        {provider === undefined ? null : (
          <>
            <ActionMenuItem onSelect={() => show('configuration')}>
              Edit configuration
            </ActionMenuItem>
            <ActionMenuItem onSelect={() => show('credentials')}>
              Replace credentials
            </ActionMenuItem>
          </>
        )}
        {onTest === undefined && onSetupGuide === undefined && provider === undefined ? null : (
          <ActionMenuSeparator />
        )}
        <ActionMenuItem tone="danger" onSelect={() => show('retire')}>
          Retire
        </ActionMenuItem>
      </ActionMenu>

      {provider === undefined ? null : (
        <Dialog
          open={open === 'configuration'}
          onOpenChange={onOpenChange}
          title={`Edit the configuration of ${name}`}
          description="Only what you change is sent; a key the provider does not declare is removed."
          footer={
            <>
              <Button onClick={() => setOpen(null)}>Cancel</Button>
              <Button type="submit" form={configFormId} tone="primary">
                Save configuration
              </Button>
            </>
          }
        >
          <ConfigEditor
            key={generation}
            integration={integration}
            provider={provider}
            formId={configFormId}
            onSaved={() => setOpen(null)}
          />
        </Dialog>
      )}

      {provider === undefined ? null : (
        <Dialog
          open={open === 'credentials'}
          onOpenChange={onOpenChange}
          title={`Replace the credentials of ${name}`}
          footer={
            <>
              <Button onClick={() => setOpen(null)}>Close</Button>
              <Button type="submit" form={credentialsFormId} tone="primary">
                Re-seal credentials
              </Button>
            </>
          }
        >
          <CredentialResealer
            key={generation}
            integration={integration}
            provider={provider}
            formId={credentialsFormId}
          />
        </Dialog>
      )}

      <Dialog
        open={open === 'retire'}
        onOpenChange={onOpenChange}
        title={`Retire ${name}?`}
        description="Its credentials are deleted, and nothing can load or change it again. It stays listed, as retired, because the audit names it."
        footer={
          <>
            <Button onClick={() => setOpen(null)}>Cancel</Button>
            <Button
              tone="danger"
              disabled={commands.retireIntegration.isPending}
              onClick={() => {
                commands.retireIntegration.mutate(integration.id, {
                  onSuccess: () => setOpen(null),
                });
              }}
            >
              Retire integration
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3" data-retire-confirm>
          <p>
            {boundProjects === null || boundProjects === 0
              ? 'A project that still binds it, or a run credential it minted that is still live, refuses the retire.'
              : `It is bound to ${boundProjects === 1 ? 'one project' : `${boundProjects} projects`}: remove it from each project's connections first, or the retire is refused.`}
          </p>
          {commands.retireIntegration.isError ? (
            <ErrorNotice
              title="The integration was not retired."
              error={commands.retireIntegration.error}
            />
          ) : null}
        </div>
      </Dialog>
    </>
  );
};

// ── Refused deliveries ───────────────────────────────────────────────────────

/**
 * What this integration's inbound half refused, and why (WP-44, PROGRESS backlog 198) — titled
 * *Rejected webhooks* since S-25.3 (research/21 S10), the words a person reads it in — refusals
 * only since WP-73b (backlog 206): an ordinary ignore is filtered out by the server on its code.
 *
 * A chat click refused as `unmapped_identity` or `decision_refused: not_permitted` used to be
 * visible only in SQL and in the API process's log, so an operator debugging a dead button had no
 * surface. Fetched when its tab opens; every line is `inbox.error` — redacted at the write,
 * provider-derived all the same (BD-022) — and the accounts named are the ones the identities screen
 * offers to map.
 */
export const RefusedDeliveries = ({
  integrationId,
}: {
  readonly integrationId: string;
}): ReactElement => {
  const refused = useRefusedDeliveries(integrationId, true);
  if (refused.isPending) {
    return <Skeleton label="Loading rejected webhooks…" lines={2} />;
  }
  if (refused.isError) {
    return <ErrorNotice title="The rejected webhooks could not be loaded." error={refused.error} />;
  }
  if (refused.data.items.length === 0) {
    return (
      <p className="text-sm text-fg-muted" data-refused-deliveries="none">
        Nothing this integration delivered was rejected.
      </p>
    );
  }
  return (
    <ListBox label="Rejected webhooks">
      {refused.data.items.map((delivery) => (
        <ListRow
          key={delivery.delivery_id}
          title={<UntrustedText value={delivery.error} />}
          meta={
            <span className="flex flex-col gap-0.5">
              <span>{formatDateTime(delivery.received_at)}</span>
              {delivery.reasons === null ? (
                <span>
                  Received before the platform recorded reason codes, so it is listed whether it was
                  a refusal or an ordinary ignore.
                </span>
              ) : null}
              {delivery.unmapped === null ? (
                <span>Received before the platform recorded which account was refused.</span>
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
            </span>
          }
        />
      ))}
    </ListBox>
  );
};
