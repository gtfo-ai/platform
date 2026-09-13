/**
 * The onboarding wizard — product/06 § "Flow (UI wizard, resumable, each step skippable)" (WP-21).
 *
 * Five steps, one screen, and the whole of product/06's own claim about it: *"'Finish later' leaves
 * a checklist on the project page; nothing is reachable only through the wizard."* Every step here
 * is a command that exists on its own endpoint, so an operator who closes the tab at step 3 can
 * finish from the settings screens later — and the wizard is resumable because its state is the
 * **server's**, not this component's: which project exists, which integrations are bound, whether
 * discovery has run and what the readiness evaluation says are all reads.
 *
 * ## What is here and what is honestly not
 *
 * - **Step 1 (connect)** creates the project, creates integrations from credentials already in the
 *   server's environment, tests them, and binds them to the project.
 * - **Step 2 (technical discovery)** starts the Discovery agent and shows the readiness evaluation
 *   it produces, with product/17's three cheapest improvements.
 * - **Step 3 (business interview)** is **not built**. product/06 describes a conversational form
 *   driven by the Product Manager role; nothing in this build runs an interview, and a form that
 *   collected answers nobody reads would be worse than an honest gap. The step says so and links to
 *   the knowledge screen, where the same pages can be written by hand.
 * - **Step 4 (operating mode)** sets the autonomy dial through the domain preset and writes the
 *   project's configuration.
 * - **Step 5 (commit)** is the proposal queue: the Discovery agent's drafted pages are `kb_proposals`
 *   with source `bootstrap`, and approving one commits it on an `agentic/knowledge/*` branch with a
 *   merge request — never onto the default branch. This step links there rather than duplicating it.
 *
 * ## Every string from the server is data
 *
 * The readiness evidence is the Discovery agent's own words about a repository the platform does
 * not control (BD-022), and so is an integration probe's detail. Both go through
 * `ui/untrusted.tsx`; nothing here builds markup from a string and nothing writes a URL attribute
 * outside that module.
 */

import { Link } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import {
  useIntegrations,
  useOnboardingCommands,
  useProjectBindings,
  useProjectConfig,
  useProjectReadiness,
  useProjects,
} from '../app/queries.js';
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
import { UntrustedText } from '../ui/untrusted.js';

/** product/19 §11's four dial positions, in order, with the one sentence each one is. */
const AUTONOMY_CHOICES = [
  { level: 'observe', label: 'Observe', hint: 'Nothing is picked up; shadow runs only.' },
  { level: 'assist', label: 'Assist', hint: 'Scoping only — the agent stops after architecture.' },
  {
    level: 'supervised',
    label: 'Supervised',
    hint: 'The default: plan approval above size L, probation on.',
  },
  {
    level: 'autonomous',
    label: 'Autonomous',
    hint: 'No plan approval except for risk classes; still never merges (BD-007).',
  },
] as const satisfies readonly {
  level: 'observe' | 'assist' | 'supervised' | 'autonomous';
  label: string;
  hint: string;
}[];

const LEVEL_TONE: readonly BadgeTone[] = ['danger', 'warning', 'accent', 'success', 'success'];

const Step = ({
  number,
  title,
  children,
}: {
  readonly number: number;
  readonly title: string;
  readonly children: React.ReactNode;
}): ReactElement => (
  <Card className="flex flex-col gap-3">
    <div className="flex items-center gap-2">
      <Badge tone="accent">Step {number}</Badge>
      <SectionHeading>{title}</SectionHeading>
    </div>
    {children}
  </Card>
);

export const OnboardingScreen = (): ReactElement => {
  const projects = useProjects();
  const integrations = useIntegrations();
  const commands = useOnboardingCommands();

  const [chosen, setChosen] = useState<string | null>(null);
  const [draft, setDraft] = useState({ key: '', name: '', repoUrl: '' });
  const [autonomy, setAutonomy] =
    useState<(typeof AUTONOMY_CHOICES)[number]['level']>('supervised');
  const [selected, setSelected] = useState<readonly string[]>([]);

  /**
   * **The wizard is resumable, and this is the whole of it** (product/06: *"UI wizard, resumable,
   * each step skippable"*).
   *
   * Its state is the **server's** — which project exists, which integrations are bound, whether
   * discovery has run — so resuming is a matter of pointing at a project again rather than of
   * restoring anything. A wizard that only knew the project it had just created in this browser tab
   * would send an operator who closed the tab back to step 1 with a key that is already taken.
   *
   * A deployment with exactly one project resumes it without asking; with several, the operator
   * picks, because guessing which one they meant is the kind of default that quietly onboards the
   * wrong repository.
   */
  const items = projects.data?.items ?? [];
  const projectId = chosen ?? (items.length === 1 ? (items[0]?.id ?? null) : null);
  const bindings = useProjectBindings(projectId);
  const config = useProjectConfig(projectId);
  const readiness = useProjectReadiness(projectId);
  const project = items.find((item) => item.id === projectId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>Onboarding</SectionHeading>
      <p className="text-xs text-fg-muted">
        Every step is optional and every one of them is reachable from the project’s own settings
        later. Nothing here is the only way to do anything (product/06).
      </p>

      {items.length > 1 ? (
        <label className="flex items-center gap-2 text-sm">
          Resume onboarding for
          <select
            className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
            value={projectId ?? ''}
            onChange={(event) => setChosen(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">a new project</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.key}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <Step number={1} title="Connect">
        <p className="text-xs text-fg-muted">
          A project is a repository plus the integrations that feed it. Credentials are read from
          this server’s environment by name — they never travel through the browser.
        </p>
        {project === null ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              commands.createProject.mutate(
                { key: draft.key, name: draft.name, repo_url: draft.repoUrl },
                { onSuccess: (created) => setChosen(created.id) },
              );
            }}
          >
            <Field
              label="Key"
              hint="Lower-case slug; it ends up in URLs and branch names."
              value={draft.key}
              onChange={(event) => setDraft({ ...draft, key: event.target.value })}
            />
            <Field
              label="Name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <Field
              label="Repository URL"
              hint="https:// or file:// — an SSH remote is refused (technical/12)."
              value={draft.repoUrl}
              onChange={(event) => setDraft({ ...draft, repoUrl: event.target.value })}
            />
            <div>
              <Button type="submit" tone="primary" disabled={commands.createProject.isPending}>
                Create project
              </Button>
            </div>
            {commands.createProject.isError ? (
              <ErrorNotice
                title="The project was not created."
                detail={String(commands.createProject.error)}
              />
            ) : null}
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              <UntrustedText value={project.name} /> — <UntrustedText value={project.repo_url} />
            </p>
            <div className="flex flex-col gap-1">
              {(integrations.data?.items ?? []).map((integration) => (
                <label key={integration.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(integration.id)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, integration.id]
                          : selected.filter((id) => id !== integration.id),
                      )
                    }
                  />
                  <UntrustedText value={integration.name} />
                  <Badge>{integration.type}</Badge>
                  <Button
                    type="button"
                    tone="ghost"
                    onClick={() => commands.testIntegration.mutate(integration.id)}
                  >
                    Test connection
                  </Button>
                </label>
              ))}
            </div>
            {integrations.isSuccess && integrations.data.items.length === 0 ? (
              <EmptyState
                title="No integrations yet"
                hint="Add one from the Integrations screen, then come back — the wizard binds what exists rather than creating credentials here."
              />
            ) : null}
            <div>
              <Button
                tone="primary"
                disabled={commands.putBindings.isPending}
                onClick={() =>
                  commands.putBindings.mutate({ projectId: project.id, integrationIds: selected })
                }
              >
                Bind {selected.length} integration{selected.length === 1 ? '' : 's'}
              </Button>
            </div>
            {bindings.isSuccess && bindings.data.items.length > 0 ? (
              <p className="text-xs text-fg-muted">
                Bound: {bindings.data.items.map((item) => item.provider).join(', ')}
              </p>
            ) : null}
          </div>
        )}
      </Step>

      <Step number={2} title="Technical discovery">
        <p className="text-xs text-fg-muted">
          A read-only agent inspects the repository and drafts the technical pages, the commands it
          verified, and the questions it could not answer. It is one run, budgeted like any other.
        </p>
        <div>
          <Button
            tone="primary"
            disabled={project === null || commands.startDiscovery.isPending}
            onClick={() => {
              if (project !== null) {
                commands.startDiscovery.mutate(project.id);
              }
            }}
          >
            Run discovery
          </Button>
        </div>
        {commands.startDiscovery.isSuccess ? (
          <p className="text-xs">
            <UntrustedText value={commands.startDiscovery.data.detail} />
          </p>
        ) : null}
        {readiness.isSuccess ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Badge tone={LEVEL_TONE[readiness.data.level] ?? 'neutral'}>
                Readiness level {readiness.data.level}
              </Badge>
              <span className="text-xs text-fg-muted">
                evaluated {formatDateTime(readiness.data.evaluated_at)}
              </span>
            </div>
            {readiness.data.next_improvements.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-semibold">Cheapest improvements next</p>
                {readiness.data.next_improvements.map((item) => (
                  <p key={item.id} className="text-xs">
                    <Badge>{item.id}</Badge> {item.title} — {item.unlocks}
                  </p>
                ))}
              </div>
            ) : null}
            <ul className="flex flex-col gap-1">
              {readiness.data.criteria.map((criterion) => (
                <li key={criterion.id} className="text-xs">
                  <Badge tone={criterion.passed ? 'success' : 'neutral'}>{criterion.id}</Badge>{' '}
                  {criterion.unlocks} —{' '}
                  {/* The agent's own words about someone else's repository (BD-022). */}
                  <UntrustedText value={criterion.evidence} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {readiness.isError ? (
          <p className="text-xs text-fg-muted">
            No readiness evaluation yet — running discovery is what records one.
          </p>
        ) : null}
      </Step>

      <Step number={3} title="Business interview">
        <EmptyState
          title="Not built in this release"
          hint="product/06 describes a conversational form driven by the Product Manager role. Nothing in this build runs one, so the wizard says so rather than collecting answers nobody reads. The same pages can be written by hand from the project’s Knowledge screen."
        />
      </Step>

      <Step number={4} title="Operating mode">
        <p className="text-xs text-fg-muted">
          The autonomy dial. Readiness only ever <em>suggests</em> a cap — a maintainer may override
          it, and the override is visible beside the badge (BD-027).
        </p>
        <div className="flex flex-col gap-1">
          {AUTONOMY_CHOICES.map((choice) => (
            <label key={choice.level} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="autonomy"
                checked={autonomy === choice.level}
                onChange={() => setAutonomy(choice.level)}
              />
              <span>
                <span className="font-semibold">{choice.label}</span>
                <span className="block text-xs text-fg-muted">{choice.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div>
          <Button
            tone="primary"
            disabled={project === null || !config.isSuccess || commands.writeConfig.isPending}
            onClick={() => {
              if (project !== null && config.isSuccess) {
                /**
                 * **The document that is already there, plus the dial, plus the hash it was read
                 * at.** `PUT …/config` takes the *whole* `.agentic/config.yml` and replaces it, so
                 * sending `{ version: 1 }` — which this screen did until WP-21's review round 2 —
                 * silently discarded every other key the project had. `base_hash` is the optimistic
                 * check the endpoint already implements: a document somebody else changed between
                 * this read and this write is a 409 rather than a lost edit.
                 */
                commands.writeConfig.mutate({
                  projectId: project.id,
                  config: config.data.config as Record<string, unknown>,
                  autonomy_level: autonomy,
                  base_hash: config.data.hash,
                });
              }
            }}
          >
            Save operating mode
          </Button>
        </div>
        {commands.writeConfig.isError ? (
          <ErrorNotice
            title="The operating mode was not saved."
            detail={String(commands.writeConfig.error)}
          />
        ) : null}
        <p className="text-xs text-fg-muted">
          The command policy is <strong>not</strong> editable here, and that is a limit of the
          platform rather than of this screen: a project may only <em>narrow</em> the organisation
          maximum (BD-025), so an entry it adds that the maximum does not grant is ignored. Running
          a project&rsquo;s own test command therefore needs the organisation maximum widened, which
          nothing in this build exposes.
        </p>
        {commands.writeConfig.isSuccess ? (
          <p className="text-xs text-fg-muted">
            Saved. Effective configuration hash{' '}
            <UntrustedText value={commands.writeConfig.data.hash} />.
          </p>
        ) : null}
      </Step>

      <Step number={5} title="Commit">
        <p className="text-xs text-fg-muted">
          The Discovery agent’s drafted pages are proposals, not commits. Approving one puts it on
          an `agentic/knowledge/*` branch with a merge request — the platform never writes to the
          default branch (BD-012, BD-007).
        </p>
        {project === null ? (
          <EmptyState
            title="Create the project first"
            hint="Step 1 is what the queue belongs to."
          />
        ) : (
          <p className="text-sm">
            <Link to="/projects/$key/knowledge" params={{ key: project.key }}>
              Review the drafted pages
            </Link>
          </p>
        )}
      </Step>

      {projects.isError ? <ErrorNotice title="Projects could not be loaded." /> : null}
      {projects.isPending ? <Loading label="Loading projects…" /> : null}
    </div>
  );
};
