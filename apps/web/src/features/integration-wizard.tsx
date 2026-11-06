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
 *    the next screen: *Use in a new project* (the New project wizard) or *Add to an existing
 *    project…* (that project's settings, *Connections*).
 *
 * The commands and their idempotency are the ones the old form sent: `POST /api/integrations` with
 * one `Idempotency-Key` per intent (PROGRESS backlog 53 — a double-pressed create carries one key, a
 * corrected form a new one), then `POST /api/integrations/:id/test`. The intent keys live in this
 * component, which stays mounted from the first step to the last, so moving between steps is not a
 * new intent.
 *
 * **Steps are addressable** (`?step=`), so the browser's back button moves between them; a step whose
 * earlier steps are not complete shows the first one that is not, and once the integration exists
 * the wizard stays on its last step — going back to the form would create a second one.
 *
 * **It resumes after a reload** (S-23.23, the UX audit's item 10, closing BACKLOG 830): what is typed
 * before the create is kept as a non-secret draft in this tab's `sessionStorage`
 * (`integration-wizard-draft.ts` says what is and is not kept), and once the integration exists the
 * URL carries its id (`?id=`, with `?step=test` or `?step=done`), replacing the form's entry in the
 * history — so a reload, or the back button, lands on the test or the ending for **that**
 * integration and never offers the form that would create a second one.
 *
 * **Only an administrator adds integrations** (`integration.write`): a caller whose list read says
 * `can_write: false` is told so instead of being given a form the create would refuse.
 */
import type { IntegrationProvider } from '@platform/contracts';
import { PlugIcon } from '@primer/octicons-react/PlugIcon';
import { TriangleDownIcon } from '@primer/octicons-react/TriangleDownIcon';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactElement, useEffect, useState } from 'react';
import {
  useIntegrationProviders,
  useIntegrations,
  useOnboardingCommands,
  useProjects,
} from '../app/queries.js';
import { ActionMenu, ActionMenuItem } from '../ui/action-menu.js';
import { ForAdministrators } from '../ui/admin-notes.js';
import { Blankslate } from '../ui/blankslate.js';
import { Button, buttonClassName } from '../ui/button.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { DetailsDisclosure } from '../ui/details.js';
import { Flash } from '../ui/flash.js';
import { INTEGRATION_TYPE_LABEL, INTEGRATION_TYPE_PURPOSE } from '../ui/humanize.js';
import { ErrorNotice, Field } from '../ui/kit.js';
import { PageHeader } from '../ui/page-header.js';
import { Skeleton } from '../ui/skeleton.js';
import { type Step, Stepper } from '../ui/stepper.js';
import { UntrustedText } from '../ui/untrusted.js';
import { ConnectionTestResult } from './connection-test-result.js';
import {
  ConfigFieldControl,
  CREDENTIAL_SENTENCE,
  filled,
  optionalFieldsOf,
  SecretEnvField,
  typedValues,
} from './integration-forms.js';
import {
  clearIntegrationDraft,
  readIntegrationDraft,
  storeIntegrationDraft,
} from './integration-wizard-draft.js';

export const WIZARD_STEPS = ['provider', 'configuration', 'credentials', 'test'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** What `?step=` may say: a wizard step, or the ending once the integration exists. */
export type WizardStepParam = Exclude<WizardStep, 'provider'> | 'done';

const STEP_LABEL: Readonly<Record<WizardStep, string>> = {
  provider: 'Choose a provider',
  configuration: 'Configure it',
  credentials: 'Say where its credentials are',
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
      Which system are you connecting? One integration is one account on it; projects use it later.
    </legend>
    <div className="grid gap-3 sm:grid-cols-2">
      {providers.map((provider) => {
        const chosen = draft.providerId === provider.id;
        return (
          <label
            key={provider.id}
            className={cx(
              'flex cursor-pointer gap-3 rounded-md border p-3 has-focus-visible:ring-2 has-focus-visible:ring-link',
              chosen ? 'border-link bg-subtle' : 'border-line bg-default hover:bg-subtle',
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

/**
 * The ending's second way on: a project that already exists, at its settings' *Connections*, where
 * a person picks this integration. A menu of the projects the caller may read; nothing when there is
 * none (the first way on, a new project, is then the only one).
 */
const AddToExistingProject = (): ReactElement | null => {
  const projects = useProjects();
  const navigate = useNavigate();
  const items = projects.data?.items ?? [];
  if (items.length === 0) {
    return null;
  }
  return (
    <ActionMenu
      align="start"
      trigger={
        <Button>
          Add to an existing project…
          <span aria-hidden="true" className="inline-flex">
            <TriangleDownIcon size={16} />
          </span>
        </Button>
      }
    >
      {items.map((project) => (
        <ActionMenuItem
          key={project.id}
          onSelect={() => {
            void navigate({
              to: '/projects/$key/settings/$section',
              params: { key: project.key, section: 'connections' },
            });
          }}
        >
          <UntrustedText value={project.name} />
        </ActionMenuItem>
      ))}
    </ActionMenu>
  );
};

export const IntegrationWizardScreen = ({
  step: requested,
  id,
}: {
  readonly step: WizardStepParam | undefined;
  /** The integration this wizard created, once it exists — read from `?id=`. */
  readonly id?: string | undefined;
}): ReactElement => {
  const providers = useIntegrationProviders();
  const integrations = useIntegrations();
  const commands = useOnboardingCommands();
  const navigate = useNavigate();
  // A reload resumes from the tab's draft; the credentials' variable names are asked for again.
  const [draft, setDraft] = useState<Draft>(() => {
    const stored = readIntegrationDraft();
    return stored === null ? EMPTY : { ...stored, secretEnv: {} };
  });
  useEffect(() => {
    if (id === undefined) {
      storeIntegrationDraft({
        providerId: draft.providerId,
        name: draft.name,
        config: draft.config,
      });
    }
  }, [draft, id]);
  // The integration exists once the URL names it: the list's row (a reload), or — before the list
  // has been read again — the create's own answer in this page. Never the draft's name.
  const createdRow =
    id === undefined ? undefined : integrations.data?.items.find((item) => item.id === id);
  const justCreated = commands.createIntegration.data;
  const created =
    createdRow !== undefined
      ? { id: createdRow.id, name: createdRow.name }
      : justCreated !== undefined && justCreated.id === id
        ? { id: justCreated.id, name: justCreated.name }
        : null;
  const finished = created !== null && requested === 'done';
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
  const asked: WizardStep =
    requested === undefined || requested === 'done' ? 'provider' : requested;
  const step: WizardStep =
    id !== undefined
      ? 'test'
      : WIZARD_STEPS.indexOf(asked) <= WIZARD_STEPS.indexOf(firstIncomplete)
        ? asked
        : firstIncomplete;
  const index = WIZARD_STEPS.indexOf(step);

  const go = (next: WizardStep): void => {
    void navigate({ to: '/integrations/new', search: next === 'provider' ? {} : { step: next } });
  };

  const steps: Step[] = WIZARD_STEPS.map((stepId, position) => {
    const done = finished || position < index;
    const state = done ? 'done' : position === index ? 'current' : 'upcoming';
    return {
      id: stepId,
      label: STEP_LABEL[stepId],
      state,
      ...(stepId === 'test' ? { optional: true } : {}),
      // A finished step is a link back to it — until the integration exists.
      ...(state === 'done' && id === undefined
        ? {
            render: ({ className, children }) => (
              <Link
                to="/integrations/new"
                search={stepId === 'provider' ? {} : { step: stepId }}
                className={cx(className, 'rounded-sm', FOCUS_RING)}
              >
                {children}
              </Link>
            ),
          }
        : {}),
    };
  });

  const header = (
    <PageHeader
      back={
        <Link to="/integrations" className="rounded-sm text-sm text-link hover:underline">
          ← Integrations
        </Link>
      }
      title="New integration"
    />
  );

  // S-23.23: the create is an administrator's (`integration.write`); nobody else gets the form.
  if (integrations.isSuccess && !integrations.data.can_write) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Blankslate
          informational
          size="spacious"
          icon={<PlugIcon size={24} />}
          title="Administrators add integrations"
          hint="Ask an administrator to connect the system; once it is added, a project can use it."
        />
      </div>
    );
  }
  // The URL names an integration this list does not have (retired elsewhere, or a wrong link).
  if (id !== undefined && integrations.isSuccess && !integrations.isFetching && created === null) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Blankslate
          size="spacious"
          icon={<PlugIcon size={24} />}
          title="That integration is not here"
          hint="This page was opened for an integration this organisation does not have. Start again, or open the list."
          action={
            <Link to="/integrations" className={buttonClassName('default')}>
              Back to integrations
            </Link>
          }
        />
      </div>
    );
  }

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
          // From here the URL is what resumes the wizard: the draft is gone, and the form's entry
          // in the history is replaced so neither a reload nor Back offers a second create.
          clearIntegrationDraft();
          void navigate({
            to: '/integrations/new',
            search: { step: 'test', id: result.id },
            replace: true,
          });
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {header}
      <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
        <Stepper label="New integration" steps={steps} />
        {/* The step on the card ground (S-25.10b): a form is a box, the page is the canvas. */}
        <section
          aria-label={STEP_LABEL[step]}
          className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-default p-4"
          data-wizard-step={step}
        >
          <h2 className="text-base font-semibold">{STEP_LABEL[step]}</h2>
          {providers.isPending || (id !== undefined && integrations.isPending) ? (
            <Skeleton label="Loading the providers…" />
          ) : null}
          {providers.isError ? (
            <ErrorNotice title="The providers could not be loaded." error={providers.error} />
          ) : null}
          {id !== undefined && integrations.isError ? (
            <ErrorNotice title="The integration could not be loaded." error={integrations.error} />
          ) : null}

          {providers.isSuccess && id === undefined && step === 'provider' ? (
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

          {provider !== undefined && id === undefined && step === 'configuration' ? (
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
                Every address must be on a host an administrator has allowed for this instance.
              </p>
              <ForAdministrators note="integration_hosts" />
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

          {provider !== undefined && id === undefined && step === 'credentials' ? (
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
              <ForAdministrators note="secret_env" />
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
                <Button
                  onClick={() => {
                    void navigate({
                      to: '/integrations/new',
                      search: { step: 'done', id: created.id },
                      replace: true,
                    });
                  }}
                >
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
                  A project uses it once it is in that project’s Connections: in a new project’s
                  first step, or in an existing project’s settings.
                </p>
              </Flash>
              <ConnectionTestResult test={commands.testIntegration} />
              <div className="flex flex-wrap gap-2">
                <Link to="/onboarding" className={buttonClassName('primary')}>
                  Use in a new project
                </Link>
                <AddToExistingProject />
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
