/**
 * The New project wizard's first step, **Connect** — three sections on one page (research/19 § 6):
 * the project's details, the integrations it uses, and the tracker's ticket lifecycle.
 *
 * - **Project details** asks for the repository first and proposes the name and key from it
 *   (S-25.8, `repository-proposal.ts`), creates the project (`POST /api/projects`, with an
 *   `Idempotency-Key` per intent) and, once it exists, shows it with the git provider's default
 *   branch — the same `DefaultBranch` the settings page renders (product/18:55).
 * - **Integrations** tests and binds the integrations that exist. **It does not create one** (PROGRESS
 *   backlog 55): that is the Integrations screen's, which an empty list links to. A *Test connection*
 *   shows its answer beside the integration it tested, through the Integrations screen's own
 *   `ConnectionTestResult` (WP-155, backlog 451). A tracker bound here for the first time also gets
 *   the default lifecycle block, claim on (backlog 552, TD-029 decision 1), and the step says so
 *   before the bind. The selection starts at the stored bindings and the save names its change
 *   (`binding-selection.tsx`, S-23.21): the PUT replaces the set, and an empty start unbound it.
 * - **Ticket lifecycle** is `features/ticket-lifecycle.tsx`, the same component the project settings
 *   page renders (WP-182).
 *
 * Everything a provider or a person typed is rendered as text through `ui/untrusted.tsx` (BD-022).
 */
import type { ProjectSummary } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { type ReactElement, type ReactNode, useState } from 'react';
import { useBindableIntegrations, useOnboardingCommands } from '../app/queries.js';
import { buttonClassName } from '../ui/button.js';
import { INTEGRATION_TYPE_LABEL } from '../ui/humanize.js';
import { Badge, Button, EmptyState, ErrorNotice, Field } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';
import { SaveBindingsButton, useBindingSelection } from './binding-selection.js';
import { ConnectionTestResult } from './connection-test-result.js';
import { DefaultBranch } from './default-branch.js';
import {
  draftWithName,
  draftWithRepositoryUrl,
  type EditedFields,
  EMPTY_PROJECT_DRAFT,
  type ProjectDraft,
} from './repository-proposal.js';
import {
  TicketLifecycle,
  wizardBindingConfig,
  wizardWritesDefaultBlock,
} from './ticket-lifecycle.js';

/** A sub-section of the step: a heading and one line saying what it is for. */
const Section = ({
  title,
  purpose,
  children,
}: {
  readonly title: string;
  readonly purpose: string;
  readonly children: ReactNode;
}): ReactElement => (
  // On the card ground (S-25.10b): each part of the step is a box, the page is the canvas.
  <section
    aria-label={title}
    className="flex flex-col gap-2 rounded-lg border border-line bg-default p-4"
  >
    <h3 className="text-base font-semibold">{title}</h3>
    <p className="text-sm text-fg-muted">{purpose}</p>
    {children}
  </section>
);

/**
 * Project details, before the project exists: the create form. The repository comes first and the
 * name and key are proposed from it (S-25.8, `repository-proposal.ts`); a field the person typed
 * into is theirs, and a later change of the URL leaves it alone.
 */
const CreateProjectForm = ({
  onCreated,
}: {
  readonly onCreated: (key: string) => void;
}): ReactElement => {
  const commands = useOnboardingCommands();
  const [draft, setDraft] = useState<ProjectDraft>(EMPTY_PROJECT_DRAFT);
  const [edited, setEdited] = useState<EditedFields>({ name: false, key: false });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        commands.createProject.mutate(
          {
            key: draft.key,
            name: draft.name,
            repo_url: draft.repoUrl,
            // WP-139: always sent. The column's default is `main`, which is the wrong branch for a
            // repository whose default is `develop` or `dev`.
            default_branch: draft.defaultBranch.trim(),
          },
          { onSuccess: (created) => onCreated(created.key) },
        );
      }}
    >
      <Field
        label="Repository URL"
        hint="https:// or file:// — an SSH remote is refused. The name and the key below are proposed from it."
        value={draft.repoUrl}
        onChange={(event) => setDraft(draftWithRepositoryUrl(draft, edited, event.target.value))}
      />
      <Field
        label="Name"
        hint="Proposed from the repository’s name; any name you like."
        value={draft.name}
        onChange={(event) => {
          setEdited({ ...edited, name: true });
          setDraft(draftWithName(draft, edited, event.target.value));
        }}
      />
      <Field
        label="Key"
        hint="Proposed from the name: lower-case letters, digits and underscores, because it ends up in addresses and branch names."
        value={draft.key}
        onChange={(event) => {
          setEdited({ ...edited, key: true });
          setDraft({ ...draft, key: event.target.value });
        }}
      />
      <Field
        label="Default branch"
        hint="Required: the branch every run checks out and every merge request targets — the repository’s own (develop, dev, main…). Once a git integration is bound, the provider’s answer is shown here and the branch can be changed."
        required
        value={draft.defaultBranch}
        onChange={(event) => setDraft({ ...draft, defaultBranch: event.target.value })}
      />
      <div>
        <Button
          type="submit"
          disabled={commands.createProject.isPending || draft.defaultBranch.trim() === ''}
        >
          Create project
        </Button>
      </div>
      {commands.createProject.isError ? (
        <ErrorNotice title="The project was not created." error={commands.createProject.error} />
      ) : null}
    </form>
  );
};

/** Integrations: test and bind what exists. */
const BindIntegrations = ({ project }: { readonly project: ProjectSummary }): ReactElement => {
  const integrations = useBindableIntegrations();
  const commands = useOnboardingCommands();
  // S-23.21: seeded from the stored bindings, as the settings page's is — the PUT replaces the set.
  const selection = useBindingSelection(project.id);
  const { stored, selected } = selection;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        {/* A retired integration (WP-114) cannot be bound: the selector leaves it out (WP-122). */}
        {integrations.items.map((integration) => (
          <div
            key={integration.id}
            className="flex flex-col gap-1"
            data-integration-row={integration.id}
          >
            <div className="flex items-center gap-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selection.isSelected(integration.id)}
                  disabled={!selection.ready}
                  onChange={(event) => selection.toggle(integration.id, event.target.checked)}
                />
                <UntrustedText value={integration.name} />
              </label>
              <Badge>{INTEGRATION_TYPE_LABEL[integration.type]}</Badge>
              <Button
                type="button"
                tone="ghost"
                disabled={commands.testIntegration.isPending}
                onClick={() => commands.testIntegration.mutate(integration.id)}
              >
                Test connection
              </Button>
            </div>
            {/* WP-155 (backlog 451): the answer the Integrations card shows — the same component —
                beside the integration that was tested, and only that one. */}
            {commands.testIntegration.variables === integration.id ? (
              <ConnectionTestResult test={commands.testIntegration} />
            ) : null}
          </div>
        ))}
      </div>
      {integrations.isSuccess && integrations.items.length === 0 ? (
        <EmptyState
          title="No integrations yet"
          hint="An integration is a connection to a ticket tracker, a git host or a chat workspace. Add one on the Integrations screen, then come back here to connect it to this project."
          action={
            <Link to="/integrations" className={buttonClassName('default')}>
              Add an integration
            </Link>
          }
        />
      ) : (
        <p className="text-xs text-fg-muted">
          Missing one?{' '}
          <Link to="/integrations" className="text-link underline">
            Add an integration
          </Link>{' '}
          on the Integrations screen, then come back.
        </p>
      )}
      <div>
        <SaveBindingsButton
          selection={selection}
          pending={commands.putBindings.isPending}
          onSave={(ids) =>
            commands.putBindings.mutate({
              projectId: project.id,
              // Each binding keeps the configuration it already has — the notification channel lives
              // there (WP-32), and re-sending the set without it would erase it. A tracker bound here
              // for the first time also gets the default lifecycle block, claim on (backlog 552,
              // TD-029 decision 1); a stored one is untouched.
              items: ids.map((id) => ({
                integration_id: id,
                config: wizardBindingConfig({
                  integration: integrations.items.find((item) => item.id === id) ?? null,
                  stored,
                  integrationId: id,
                }),
              })),
            })
          }
        />
      </div>
      {selection.error === null ? null : (
        <ErrorNotice
          title="The project’s connections could not be loaded, so none can be changed."
          error={selection.error}
        />
      )}
      {commands.putBindings.isError ? (
        <ErrorNotice title="The connections were not saved." error={commands.putBindings.error} />
      ) : null}
      {/* Backlog 552: said before the save, as the lifecycle card says its own default. */}
      {selected.some((id) =>
        wizardWritesDefaultBlock({
          integration: integrations.items.find((item) => item.id === id) ?? null,
          stored,
          integrationId: id,
        }),
      ) ? (
        <p className="text-xs text-fg-muted" data-lifecycle="wizard-default">
          Connecting a ticket tracker here also saves its ticket lifecycle with no moment mapped and
          the claim on: before a task’s first run the platform assigns the ticket to the tracker
          integration’s own account. Choose a status for each moment, or switch the claim off, in
          the ticket lifecycle form below.
        </p>
      ) : null}
      {selection.ready && stored.length > 0 ? (
        <p className="text-xs text-fg-muted" data-bound="">
          Connected: {stored.map((item) => item.name).join(', ')}
        </p>
      ) : null}
    </div>
  );
};

export const ConnectStep = ({
  project,
  onCreated,
}: {
  readonly project: ProjectSummary | null;
  readonly onCreated: (key: string) => void;
}): ReactElement => (
  <div className="flex flex-col gap-4">
    <Section
      title="Project details"
      purpose="A project is one repository and the integrations that feed it."
    >
      {project === null ? (
        <CreateProjectForm onCreated={onCreated} />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm" data-project-summary="">
            <UntrustedText value={project.name} /> — <UntrustedText value={project.repo_url} />
          </p>
          {/* WP-139: the provider's default branch, once a git binding is known — the same
              component as the settings page's (product/18:55). */}
          <DefaultBranch projectId={project.id} />
        </div>
      )}
    </Section>
    <Section
      title="Integrations"
      purpose="Bind a ticket tracker and a git host; a chat workspace is optional. Credentials stay on the server — nothing secret travels through the browser."
    >
      {project === null ? (
        <p className="text-sm text-fg-muted">Available once the project is created.</p>
      ) : (
        <BindIntegrations project={project} />
      )}
    </Section>
    <Section
      title="Ticket lifecycle"
      purpose="Which of your tracker’s statuses the platform moves a ticket to. Every moment may stay unmapped; the claim is on by default."
    >
      {project === null ? (
        <p className="text-sm text-fg-muted">Available once a ticket tracker is bound.</p>
      ) : (
        // WP-182 ruling (a): the slots, picked from the tracker's own statuses — the same component
        // as the settings page's (product/18:55).
        <TicketLifecycle projectId={project.id} />
      )}
    </Section>
  </div>
);
