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
 * The provider field is free text and the server's refusal names every shipped provider. That is
 * deliberate: a catalogue copied into the SPA would be a second list to keep true, and importing
 * `@platform/integrations` into the browser bundle would pull every adapter past TD-013's budget.
 */
import { type ReactElement, useState } from 'react';
import { useIntegrations, useOnboardingCommands } from '../app/queries.js';
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
import { UntrustedProse, UntrustedText } from '../ui/untrusted.js';

const HEALTH_TONE: Record<string, BadgeTone> = {
  ok: 'success',
  degraded: 'warning',
  down: 'danger',
  unknown: 'neutral',
};

/** The five integration types technical/03 defines; the server refuses a mismatch by name. */
const INTEGRATION_TYPES = ['task_management', 'git', 'communication', 'logs', 'errors'] as const;

export const IntegrationsScreen = (): ReactElement => {
  const integrations = useIntegrations();
  const commands = useOnboardingCommands();
  const { endpoints } = useServices();
  const [guide, setGuide] = useState<{ id: string; markdown: string; title: string } | null>(null);
  const [guideError, setGuideError] = useState(false);
  const [draft, setDraft] = useState({
    type: 'task_management' as (typeof INTEGRATION_TYPES)[number],
    provider: '',
    name: '',
    secretField: '',
    secretEnv: '',
  });

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
                      });
                    })
                    .catch(() => {
                      setGuideError(true);
                    });
                }}
              >
                Setup guide
              </Button>
            </div>
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
          <code>APP_INTEGRATION_SECRET_ENV</code> allow-list, which is empty by default.
        </p>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            commands.createIntegration.mutate({
              type: draft.type,
              provider: draft.provider.trim(),
              name: draft.name.trim(),
              config: {},
              ...(draft.secretField.trim() === '' || draft.secretEnv.trim() === ''
                ? { secret_refs: {} }
                : { secret_refs: { [draft.secretField.trim()]: draft.secretEnv.trim() } }),
            });
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            Type
            <select
              aria-label="Integration type"
              value={draft.type}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  type: event.target.value as (typeof INTEGRATION_TYPES)[number],
                })
              }
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
            >
              {INTEGRATION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="Provider"
            hint="A provider id this build ships, such as jira-cloud or gitlab. Send an unknown one and the server names every shipped provider."
            value={draft.provider}
            onChange={(event) => setDraft({ ...draft, provider: event.target.value })}
          />
          <Field
            label="Name"
            hint="Yours — what this account is called in the platform."
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <Field
            label="Credential field"
            hint="The provider's own field name, for example api_token or webhook_secret."
            value={draft.secretField}
            onChange={(event) => setDraft({ ...draft, secretField: event.target.value })}
          />
          <Field
            label="Environment variable"
            hint="The name only. Its _FILE companion is read too (TD-020)."
            value={draft.secretEnv}
            onChange={(event) => setDraft({ ...draft, secretEnv: event.target.value })}
          />
          <div>
            <Button type="submit" tone="primary" disabled={commands.createIntegration.isPending}>
              Add integration
            </Button>
          </div>
        </form>
        {commands.createIntegration.isError ? (
          <ErrorNotice
            title="The integration was not created."
            detail={String(commands.createIntegration.error)}
          />
        ) : null}
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
          {/* A provider's own guide text: paragraphs and code fences, never HTML (BD-022). */}
          <UntrustedProse value={guide.markdown} />
        </Card>
      )}
    </div>
  );
};
