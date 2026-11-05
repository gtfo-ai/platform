/**
 * *New integration* (`/integrations/new`) — a four-step wizard, because adding an integration is a
 * thing done once (TD-033 § 9, research/19 § 3 rule 4 and § 5.2):
 *
 * 1. **Provider** — one card per provider this build ships, each with a one-line purpose;
 * 2. **Configuration** — its name, the provider's required fields, and its optional ones behind a
 *    disclosure, labelled in words with the key in each hint (`integration-forms.tsx`);
 * 3. **Credentials** — the environment-variable name for each credential field, and the one line
 *    saying why the value never crosses the API; *Create integration* sends the create;
 * 4. **Test connection** — the probe against what was just created, then the ending, which offers
 *    the next screen: *Bind it to a project*.
 *
 * The commands and their idempotency are the ones the old form sent: `POST /api/integrations` with
 * one `Idempotency-Key` per intent (PROGRESS backlog 53 — a double-pressed create carries one key, a
 * corrected form a new one), then `POST /api/integrations/:id/test`. The intent keys live in this
 * component, which stays mounted from the first step to the last, so moving between steps is not a
 * new intent.
 *
 * **Steps are addressable** (`?step=`), so the browser's back button moves between them; a step whose
 * earlier steps are not complete shows the first one that is not, and once the integration exists
 * the wizard stays on its last step — going back to the form would create a second one. What is
 * typed lives in this component, so a reload starts again at the first step (resume is BACKLOG 830).
 */
import type { IntegrationProvider } from '@platform/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { useIntegrationProviders, useOnboardingCommands } from '../app/queries.js';
import { Button, buttonClassName } from '../ui/button.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { DetailsDisclosure } from '../ui/details.js';
import { Flash } from '../ui/flash.js';
import { INTEGRATION_TYPE_LABEL, INTEGRATION_TYPE_PURPOSE } from '../ui/humanize.js';
import { ErrorNotice, Field } from '../ui/kit.js';
import { PageHeader } from '../ui/page-header.js';
import { Skeleton } from '../ui/skeleton.js';
import { type Step, Stepper } from '../ui/stepper.js';
import { ConnectionTestResult } from './connection-test-result.js';
import {
  ConfigFieldControl,
  CREDENTIAL_SENTENCE,
  filled,
  optionalFieldsOf,
  SecretEnvField,
  typedValues,
} from './integration-forms.js';

export const WIZARD_STEPS = ['provider', 'configuration', 'credentials', 'test'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

const STEP_LABEL: Readonly<Record<WizardStep, string>> = {
  provider: 'Choose a provider',
  configuration: 'Configure it',
  credentials: 'Name its credentials',
  test: 'Test the connection',
};

interface Draft {
  readonly providerId: string;
  readonly name: string;
  readonly config: Readonly<Record<string, string>>;
  readonly secretEnv: Readonly<Record<string, string>>;
}

const EMPTY: Draft = { providerId: '', name: '', config: {}, secretEnv: {} };

/** Whether a step's own inputs are complete: a provider chosen, a name and every required field. */
const complete = (step: WizardStep, draft: Draft, provider: IntegrationProvider | undefined) => {
  switch (step) {
    case 'provider':
      return provider !== undefined;
    case 'configuration':
      return (
        provider !== undefined &&
        draft.name.trim() !== '' &&
        provider.config_fields
          .filter((field) => field.required)
          .every((field) => (draft.config[field.name] ?? '').trim() !== '')
      );
    default:
      return false;
  }
};

const ProviderStep = ({
  providers,
  draft,
  onChoose,
}: {
  readonly providers: readonly IntegrationProvider[];
  readonly draft: Draft;
  readonly onChoose: (providerId: string) => void;
}): ReactElement => (
  <fieldset className="flex flex-col gap-3">
    <legend className="pb-2 text-sm text-fg-muted">
      Which system are you connecting? One integration is one account on it; projects bind it later.
    </legend>
    <div className="grid gap-3 sm:grid-cols-2">
      {providers.map((provider) => {
        const chosen = draft.providerId === provider.id;
        return (
          <label
            key={provider.id}
            className={cx(
              'flex cursor-pointer gap-3 rounded-md border p-3 has-focus-visible:ring-2 has-focus-visible:ring-link',
              chosen ? 'border-link bg-subtle' : 'border-line hover:bg-subtle',
            )}
          >
            <input
              type="radio"
              name="provider"
              value={provider.id}
              checked={chosen}
              onChange={() => onChoose(provider.id)}
              className="mt-1"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">{provider.display_name}</span>
              <span className="text-xs text-fg-muted">
                {`${INTEGRATION_TYPE_LABEL[provider.type]} — ${INTEGRATION_TYPE_PURPOSE[provider.type]}`}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  </fieldset>
);

export const IntegrationWizardScreen = ({
  step: requested,
}: {
  readonly step: WizardStep | undefined;
}): ReactElement => {
  const providers = useIntegrationProviders();
  const commands = useOnboardingCommands();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [created, setCreated] = useState<{ readonly id: string; readonly name: string } | null>(
    null,
  );
  const [finished, setFinished] = useState(false);
  const provider = providers.data?.items.find((entry) => entry.id === draft.providerId);
  const fields =
    provider === undefined
      ? []
      : [
          ...provider.config_fields.filter((field) => field.required),
          ...optionalFieldsOf(provider),
        ];
  const optional = provider === undefined ? [] : optionalFieldsOf(provider);
  const required = provider === undefined ? [] : provider.config_fields.filter((f) => f.required);

  // The step shown: the one asked for, unless an earlier one is incomplete — and the last once the
  // integration exists.
  const firstIncomplete = WIZARD_STEPS.find((step) => !complete(step, draft, provider)) ?? 'test';
  const step: WizardStep =
    created !== null
      ? 'test'
      : WIZARD_STEPS.indexOf(requested ?? 'provider') <= WIZARD_STEPS.indexOf(firstIncomplete)
        ? (requested ?? 'provider')
        : firstIncomplete;
  const index = WIZARD_STEPS.indexOf(step);

  const go = (next: WizardStep): void => {
    void navigate({ to: '/integrations/new', search: next === 'provider' ? {} : { step: next } });
  };

  const steps: Step[] = WIZARD_STEPS.map((id, position) => {
    const done = finished || position < index;
    const state = done ? 'done' : position === index ? 'current' : 'upcoming';
    return {
      id,
      label: STEP_LABEL[id],
      state,
      ...(id === 'test' ? { optional: true } : {}),
      // A finished step is a link back to it — until the integration exists.
      ...(state === 'done' && created === null
        ? {
            render: ({ className, children }) => (
              <Link
                to="/integrations/new"
                search={id === 'provider' ? {} : { step: id }}
                className={cx(className, 'rounded-sm', FOCUS_RING)}
              >
                {children}
              </Link>
            ),
          }
        : {}),
    };
  });

  const create = (): void => {
    if (provider === undefined) {
      return;
    }
    commands.createIntegration.mutate(
      {
        type: provider.type,
        provider: provider.id,
        name: draft.name.trim(),
        config: typedValues(draft.config, fields),
        secret_refs: filled(draft.secretEnv, provider.secret_fields),
      },
      {
        onSuccess: (result) => {
          setCreated({ id: result.id, name: result.name });
          go('test');
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        back={
          <Link to="/integrations" className="rounded-sm text-sm text-link hover:underline">
            ← Integrations
          </Link>
        }
        title="New integration"
      />
      <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
        <Stepper label="New integration" steps={steps} />
        <section
          aria-label={STEP_LABEL[step]}
          className="flex min-w-0 flex-col gap-4"
          data-wizard-step={step}
        >
          <h2 className="text-base font-semibold">{STEP_LABEL[step]}</h2>
          {providers.isPending ? <Skeleton label="Loading the shipped providers…" /> : null}
          {providers.isError ? (
            <ErrorNotice
              title="The shipped providers could not be loaded."
              error={providers.error}
            />
          ) : null}

          {providers.isSuccess && step === 'provider' ? (
            <>
              <ProviderStep
                providers={providers.data.items}
                draft={draft}
                onChoose={(providerId) =>
                  // A different provider asks for different fields: the typed values do not carry over.
                  setDraft({ ...draft, providerId, config: {}, secretEnv: {} })
                }
              />
              <div>
                <Button
                  tone="primary"
                  disabled={provider === undefined}
                  onClick={() => go('configuration')}
                >
                  Continue to configuration
                </Button>
              </div>
            </>
          ) : null}

          {provider !== undefined && step === 'configuration' ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (complete('configuration', draft, provider)) {
                  go('credentials');
                }
              }}
            >
              <Field
                label="Name"
                hint="Yours — what this account is called in the platform."
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              {required.map((field) => (
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
              <p className="text-xs text-fg-muted">
                Every address must name a host the operator allowed in APP_INTEGRATION_HOSTS.
              </p>
              {optional.length === 0 ? null : (
                <DetailsDisclosure summary={`Optional settings (${optional.length})`}>
                  <div className="flex flex-col gap-3">
                    {optional.map((field) => (
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
                  </div>
                </DetailsDisclosure>
              )}
              <div>
                <Button
                  type="submit"
                  tone="primary"
                  disabled={!complete('configuration', draft, provider)}
                >
                  Continue to credentials
                </Button>
              </div>
            </form>
          ) : null}

          {provider !== undefined && step === 'credentials' ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                create();
              }}
            >
              <p className="text-sm text-fg-muted">{CREDENTIAL_SENTENCE}</p>
              {provider.secret_fields.map((field) => (
                <SecretEnvField
                  key={field}
                  field={field}
                  value={draft.secretEnv[field] ?? ''}
                  onChange={(value) =>
                    setDraft({ ...draft, secretEnv: { ...draft.secretEnv, [field]: value } })
                  }
                />
              ))}
              <div>
                <Button
                  type="submit"
                  tone="primary"
                  disabled={commands.createIntegration.isPending}
                >
                  Create integration
                </Button>
              </div>
              {/* The server's own words: it names the path it refused, the variable, or the host. */}
              {commands.createIntegration.isError ? (
                <ErrorNotice
                  title="The integration was not created."
                  error={commands.createIntegration.error}
                />
              ) : null}
            </form>
          ) : null}

          {created !== null && !finished ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-fg-muted">
                The integration exists. Test it now to check its address and credentials, or skip
                the test and run it later from its page.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  tone="primary"
                  disabled={commands.testIntegration.isPending}
                  onClick={() => {
                    commands.testIntegration.mutate(created.id);
                  }}
                >
                  Test connection
                </Button>
                <Button onClick={() => setFinished(true)}>
                  {commands.testIntegration.isSuccess ? 'Finish' : 'Skip the test'}
                </Button>
              </div>
              <ConnectionTestResult test={commands.testIntegration} />
            </div>
          ) : null}

          {created !== null && finished ? (
            <div className="flex flex-col gap-3" data-wizard-done>
              <Flash tone="success" live="status" title="The integration is added.">
                <p>
                  A project uses it once it is bound: in a new project's first step, or under an
                  existing project's settings, Connections.
                </p>
              </Flash>
              <ConnectionTestResult test={commands.testIntegration} />
              <div className="flex flex-wrap gap-2">
                <Link to="/onboarding" className={buttonClassName('primary')}>
                  Bind it to a project
                </Link>
                <Link
                  to="/integrations/$integrationId"
                  params={{ integrationId: created.id }}
                  className={buttonClassName('default')}
                >
                  Open the integration
                </Link>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};
