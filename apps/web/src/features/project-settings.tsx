/**
 * The project settings page — product/10:21, and the **mirror** product/18:55 requires.
 *
 * > *"Settings pages mirror the wizard one-to-one, so nothing is only reachable during onboarding."*
 *
 * That sentence is unconditional and it is about **all five** wizard steps, not only step 4 — which
 * is what WP-21's ledger note left to this row to decide. So this page is the wizard, re-ordered for
 * somebody who already has a project:
 *
 * | wizard step | here |
 * |---|---|
 * | 1 connect | integrations and bindings — the create and test controls live on the Integrations screen, which this page links to and whose buttons WP-30 added (PROGRESS backlog 55) — and the tracker's ticket lifecycle slots, `ticket-lifecycle.tsx`, the *same component* the wizard renders (WP-182) |
 * | 2 technical discovery | start discovery — a second start answers `started: false` and runs nothing — plus a maintainer's **re-evaluate**, which runs discovery again as a new task with its ceiling on the button (WP-94, Q107 (a); not a wizard control, since the wizard's step is the first run), and read the readiness level, which the post-merge re-check moves for the criteria it answers without a run |
 * | 3 business interview | `BusinessInterview`, the same component the wizard renders (WP-64) |
 * | 4 operating mode | `features/operating-mode.tsx`, the *same component* the wizard renders |
 * | 5 commit | the knowledge proposal queue |
 *
 * **Since S-23.11b the page is sub-pages** (`/projects/$key/settings/<section>`, GitHub's settings
 * shape, research/19 § 5.2): a NavList of `PROJECT_SETTINGS_GROUPS` (`features/settings-sections.ts`)
 * and one section per page. `/projects/$key/settings` — the URL every link already names — opens
 * the first, *Connections*. The wizard's own components keep their own saves (the autonomy dial,
 * the lifecycle slots, each budget window …): each is one decision with its own write and its own
 * refusal, and they are the same components the wizard renders, which is what keeps the mirror true.
 *
 * Step 4 is not re-implemented here: both screens render one component, which is the only way a
 * mirror stays true without somebody remembering. `apps/server/src/routes/settings-mirror.test.ts`
 * is the check, and it fails in both directions.
 *
 * **The repository's own `.agentic/config.yml`** (WP-63, Q94) has a card of its own: the reading the
 * platform last took of it on the default branch, a button that proposes these settings to it as a
 * merge request, and a button that re-reads it. **The project's prompt files** (WP-113) have the card
 * beside it (`project-prompts.tsx`): what that same reading holds under `.agentic/prompts/`, what
 * each stage would be given, and *Re-read now*.
 *
 * **Execution** (WP-278, TD-031 decision 8) has a card of its own (`execution-settings.tsx`): where
 * the project's agent runs execute — the server, workers, or both — the assignee's head start and
 * the offer timeout. It is not a wizard step: the defaults (`hybrid`, the server preferred) are what
 * a new project needs, and it is an administrator's, never a key of `.agentic/config.yml`.
 *
 * **Verification** (`verification.mode`, BD-025's 2026-10-05 amendment) is one key with a control of
 * its own (`verification-mode.tsx`): whether agents run the project's checks or CI does. It writes the
 * whole document with the hash it read, like the feature toggles.
 *
 * product/10:21 also lists **WIP limits** and **policies** on this page. They are read-only here and
 * say so: the WIP limits are `pipeline.wip` (WP-91, BD-010's defaults when nothing sets them),
 * shown as the effective configuration answers them — with the layer that set each and the
 * organisation's bound when it lowered one — and the policies are keys of `.agentic/config.yml`
 * (`policies.*`) with no per-key editor, and the pipeline screen already renders the merged
 * document with the source of every key.
 * A form that wrote one key by re-sending the whole document would be a second writer of a document
 * the repository also owns.
 */
import type { ProjectSummary } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import {
  useBindableIntegrations,
  useOnboardingCommands,
  useProjectByKey,
  useProjectConfig,
  useProjectReadiness,
} from '../app/queries.js';
import { ForAdministrators } from '../ui/admin-notes.js';
import { INTEGRATION_TYPE_LABEL, REPOSITORY_STATUS_LABEL } from '../ui/humanize.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  formatDateTime,
  formatInteger,
  Loading,
} from '../ui/kit.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';
import { SaveBindingsButton, useBindingSelection } from './binding-selection.js';
import { BusinessInterview } from './business-interview.js';
import { DefaultBranch, DefaultBranchMismatch } from './default-branch.js';
import { ExecutionSettings } from './execution-settings.js';
import { HistoryBootstrap } from './history-bootstrap.js';
import { bindingConfigOf, OperatingMode } from './operating-mode.js';
import { ProjectPromptFiles } from './project-prompts.js';
import { ReadinessNotices } from './readiness-notices.js';
import { Rediscovery } from './rediscovery.js';
import { SettingsFrame, SettingsSectionHeader } from './settings-frame.js';
import { PROJECT_SETTINGS_GROUPS, type ProjectSettingsSectionId } from './settings-sections.js';
import { TicketLifecycle } from './ticket-lifecycle.js';
import { VerificationMode } from './verification-mode.js';

type Project = Pick<ProjectSummary, 'id' | 'key' | 'name'>;

/** A published limit, or a statement that the server published none — never a made-up zero. */
const wipLimit = (value: number | undefined): string =>
  value === undefined ? 'not published' : formatInteger(value);

/** Which layer set a value (`config.sources`), in the screen's words. */
const SOURCE_LABEL: Readonly<Record<string, string>> = {
  default: 'the platform default',
  org: 'the organisation',
  project: 'these settings',
  repo: 'the repository',
};

const sourceLabel = (source: string | undefined): string =>
  source === undefined ? 'the platform default' : (SOURCE_LABEL[source] ?? source);

/** Who recorded the evaluation shown (`readiness_evaluations.source`), in the screen's words. */
const READINESS_SOURCE_LABEL: Readonly<Record<string, string>> = {
  discovery: 'the first discovery',
  rediscovery: 'a re-evaluation',
  recheck: 'the re-check after a merge',
};

/**
 * What the export's answer — or the last recorded export — says, in one sentence.
 *
 * `open` is WP-91's (backlog 225): the previous export's merge request is still open, so pressing
 * the button again answers it rather than opening a second one.
 */
const exportSentence = (status: 'exported' | 'unchanged' | 'open'): string =>
  status === 'unchanged'
    ? 'The repository already carries these settings; nothing was proposed.'
    : status === 'open'
      ? 'A configuration merge request is already open — no second one was opened: '
      : 'Merge request opened on ';

// ── Connections ──────────────────────────────────────────────────────────────

const Connections = ({ project }: { readonly project: Project }): ReactElement => {
  const integrations = useBindableIntegrations();
  const commands = useOnboardingCommands();
  // Seeded from the stored bindings, and again whenever that read changes — the wizard's own
  // selection (`binding-selection.tsx`, S-23.21): a save pressed on an empty start unbinds everything.
  const selection = useBindingSelection(project.id);
  const bound = selection.stored;

  return (
    <>
      <SettingsSectionHeader
        title="Connections"
        description="The ticket tracker, git host and chat this project uses, and how its tickets move."
      />
      {selection.ready && bound.length === 0 ? (
        <EmptyState
          title="No integrations in use yet"
          hint="A project needs a ticket board and a git host before the pipeline can start anything. Tick them below and save."
        />
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {bound.map((binding) => (
            <li key={binding.integration_id} className="flex items-center gap-2">
              <Badge tone="accent">{INTEGRATION_TYPE_LABEL[binding.type]}</Badge>
              <UntrustedText value={binding.name} />
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm">
        <Link to="/integrations">Add or test an integration</Link> — credentials are read from the
        server’s own environment and never travel through the browser.
      </p>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-semibold">Which integrations this project uses</legend>
        {/* A retired integration (WP-114) cannot be bound: the selector leaves it out (WP-122). */}
        {integrations.items.map((integration) => (
          <label key={integration.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selection.isSelected(integration.id)}
              disabled={!selection.ready}
              onChange={(event) => selection.toggle(integration.id, event.target.checked)}
            />
            <UntrustedText value={integration.name} />
            <Badge>{INTEGRATION_TYPE_LABEL[integration.type]}</Badge>
          </label>
        ))}
      </fieldset>
      <div>
        <SaveBindingsButton
          selection={selection}
          pending={commands.putBindings.isPending}
          onSave={(ids) => {
            // The **whole set**: a binding missing from the request is deleted, which is what
            // makes this re-submittable and what lets somebody correct a mistake without a
            // second endpoint (`PUT …/bindings`, WP-21).
            commands.putBindings.mutate({
              projectId: project.id,
              // With the configuration each binding already carries: the notification channel is
              // a key of it (WP-32), and this button must not be a way to lose it.
              items: ids.map((id) => ({
                integration_id: id,
                config: bindingConfigOf(bound, id),
              })),
            });
          }}
        />
      </div>
      {selection.error === null ? null : (
        <ErrorNotice
          title="This project’s connections could not be loaded, so none can be changed."
          error={selection.error}
        />
      )}
      {commands.putBindings.isError ? (
        <ErrorNotice title="The connections were not saved." error={commands.putBindings.error} />
      ) : null}
      {/* WP-182 ruling (a): the wizard's step-1 lifecycle slots, mirrored — the same component. */}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <h3 className="text-sm font-semibold">Ticket lifecycle</h3>
        <TicketLifecycle projectId={project.id} />
      </div>
    </>
  );
};

// ── Discovery and readiness ──────────────────────────────────────────────────

const DiscoveryAndReadiness = ({ project }: { readonly project: Project }): ReactElement => {
  const readiness = useProjectReadiness(project.id);
  const commands = useOnboardingCommands();
  return (
    <>
      <SettingsSectionHeader
        title="Discovery & readiness"
        description="What the Discovery agent found in the repository, and how ready the project is for agents."
      />
      {readiness.isSuccess ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={readiness.data.level >= 2 ? 'success' : 'warning'}>
            Readiness level {readiness.data.level}
          </Badge>
          <span className="text-xs text-fg-muted">
            evaluated {formatDateTime(readiness.data.evaluated_at)} by{' '}
            <UntrustedText
              value={READINESS_SOURCE_LABEL[readiness.data.source] ?? readiness.data.source}
            />
          </span>
          {/* WP-143: the CI-rules warning or note — the wizard's own component. */}
          <ReadinessNotices notices={readiness.data.notices} />
        </div>
      ) : (
        <p className="text-xs text-fg-muted">
          No readiness evaluation yet — running discovery is what records one.
        </p>
      )}
      <div>
        <Button
          tone="primary"
          disabled={commands.startDiscovery.isPending}
          onClick={() => {
            commands.startDiscovery.mutate(project.id);
          }}
        >
          Start discovery
        </Button>
      </div>
      <p className="text-xs text-fg-muted">
        Start discovery runs the first evaluation; once it has run, it starts nothing. After a merge
        the platform re-checks the readiness criteria it can read without a run; the rest keep the
        latest discovery’s answer until a maintainer re-evaluates.
      </p>
      {commands.startDiscovery.isError ? (
        <ErrorNotice title="Discovery was not started." error={commands.startDiscovery.error} />
      ) : null}
      {/* WP-94, Q107 (a): discovery again, on a maintainer's click, with its ceiling shown. */}
      <Rediscovery projectId={project.id} />
      {/* WP-142: R9 and every check read the stored branch; say when the provider's differs. */}
      <DefaultBranchMismatch projectId={project.id} />
    </>
  );
};

// ── Policies & WIP ───────────────────────────────────────────────────────────

/**
 * product/10:21 lists **WIP limits** and **policies** on this page. The WIP limits are read-only here
 * and say so: they are `pipeline.wip` (WP-91, BD-010's defaults when nothing sets them), shown as the
 * effective configuration answers them — with the layer that set each and the organisation's bound
 * when it lowered one. The policies are the operating mode's (the same component as the wizard's
 * step 4) and the verification mode.
 */
const PoliciesAndWip = ({ project }: { readonly project: Project }): ReactElement => {
  const config = useProjectConfig(project.id);
  return (
    <>
      <SettingsSectionHeader
        title="Policies & WIP"
        description="How autonomous the agents are, which features are on, the risk classes, budgets and notifications — and how much work may run at once."
      />
      <OperatingMode projectId={project.id} audit />

      {/* BD-025's 2026-10-05 amendment (backlog 460): whether agents or CI run the checks. */}
      <VerificationMode projectId={project.id} />

      <Card className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">WIP limits</h3>
        {config.data === undefined ? null : (
          <p className="text-xs text-fg-muted">
            Max parallel tasks {wipLimit(config.data.effective.pipeline?.wip?.max_parallel_tasks)} (
            {sourceLabel(config.data.sources['pipeline.wip.max_parallel_tasks'])}) · max tasks in
            pipeline {wipLimit(config.data.effective.pipeline?.wip?.max_tasks_in_pipeline)} (
            {sourceLabel(config.data.sources['pipeline.wip.max_tasks_in_pipeline'])}) — set in these
            settings or the repository’s settings file. The repository file may lower a limit and
            never raise it, and neither may go above the organisation’s maximum.
          </p>
        )}
        <ForAdministrators note="wip_limits" />
        {(config.data?.not_applied ?? []).map((item) => (
          <p key={item.key} className="text-xs text-fg-muted">
            Not applied: <code>{item.key}</code> — <UntrustedText value={item.reason} />
          </p>
        ))}
        <p className="text-xs text-fg-muted">
          The policies are keys of the configuration; the{' '}
          <Link to="/projects/$key/pipeline" params={{ key: project.key }}>
            pipeline screen
          </Link>{' '}
          shows the merged configuration and where every key came from.
        </p>
      </Card>
    </>
  );
};

// ── Repository configuration ─────────────────────────────────────────────────

/**
 * WP-63, Q94: the repository's own `.agentic/config.yml` wins over these settings once it is merged
 * (a), it is only ever written through a merge request (b), and this button stays on the page so a
 * settings change six months from now is reviewable too (c).
 */
const RepositoryConfiguration = ({ project }: { readonly project: Project }): ReactElement => {
  const config = useProjectConfig(project.id);
  const commands = useOnboardingCommands();
  return (
    <>
      <SettingsSectionHeader
        title="Repository configuration"
        description={<>The repository’s own settings file, and proposing these settings to it.</>}
      />
      {config.data === undefined ? null : (
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={config.data.repository.status === 'valid' ? 'success' : 'neutral'}>
            {`Settings file: ${REPOSITORY_STATUS_LABEL[config.data.repository.status]}`}
          </Badge>
          {config.data.repository.commit_sha === null ? null : (
            <span className="font-mono text-fg-muted">
              at <UntrustedText value={config.data.repository.commit_sha.slice(0, 12)} />
            </span>
          )}
        </p>
      )}
      {(config.data?.repository.not_applied ?? []).map((item) => (
        <p key={item.key} className="text-xs text-fg-muted">
          Not applied: <code>{item.key}</code> — <UntrustedText value={item.reason} />
        </p>
      ))}
      <p className="text-xs text-fg-muted">
        The file on the default branch wins over the settings on this page wherever it states a key.
        Changes made here reach the repository as a merge request — never a direct commit — together
        with a one-line pointer to the knowledge index in <code>CLAUDE.md</code>.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          tone="primary"
          disabled={commands.exportConfig.isPending || config.data === undefined}
          onClick={() => {
            commands.exportConfig.mutate({
              projectId: project.id,
              ...(config.data === undefined ? {} : { base_hash: config.data.hash }),
            });
          }}
        >
          Propose these settings to the repository
        </Button>
        <Button
          disabled={commands.refreshConfig.isPending}
          onClick={() => {
            commands.refreshConfig.mutate(project.id);
          }}
        >
          Re-read the repository
        </Button>
      </div>
      {!commands.exportConfig.isSuccess && config.data?.last_export != null ? (
        <p className="text-xs text-fg-muted">
          Last export {formatDateTime(config.data.last_export.exported_at)}:{' '}
          {exportSentence(config.data.last_export.status)}
          {config.data.last_export.branch === null ? null : (
            <code>
              <UntrustedText value={config.data.last_export.branch} />
            </code>
          )}
          {config.data.last_export.merge_request_url === null ? null : (
            <>
              {' — '}
              <ExternalLink
                url={config.data.last_export.merge_request_url}
                label="open the merge request"
                className="text-accent underline"
              />
            </>
          )}{' '}
          (as recorded then; pressing the button again checks whether it is still open, and answers
          it rather than opening a second one)
        </p>
      ) : null}
      {commands.exportConfig.isSuccess ? (
        <p className="text-xs">
          {exportSentence(commands.exportConfig.data.status)}
          {commands.exportConfig.data.branch === null ? null : (
            <code>
              <UntrustedText value={commands.exportConfig.data.branch} />
            </code>
          )}
          {commands.exportConfig.data.merge_request_url === null ? null : (
            <>
              {' — '}
              <ExternalLink
                url={commands.exportConfig.data.merge_request_url}
                label="open the merge request"
                className="text-accent underline"
              />
            </>
          )}
        </p>
      ) : null}
      {commands.exportConfig.isSuccess && commands.exportConfig.data.status === 'open'
        ? commands.exportConfig.data.notes.map((note) => (
            <p key={note} className="text-xs text-fg-muted">
              <UntrustedText value={note} />
            </p>
          ))
        : null}
      {commands.exportConfig.isError ? (
        <ErrorNotice title="The settings were not proposed." error={commands.exportConfig.error} />
      ) : null}
      {commands.refreshConfig.isSuccess &&
      commands.refreshConfig.data.repository.status === 'invalid' ? (
        <ErrorNotice
          title="The repository’s settings file does not parse — no run starts until it does."
          detail={commands.refreshConfig.data.repository.detail ?? ''}
        />
      ) : null}
      {commands.refreshConfig.isError ? (
        <ErrorNotice
          title="The repository could not be re-read."
          error={commands.refreshConfig.error}
        />
      ) : null}
    </>
  );
};

// ── The page ─────────────────────────────────────────────────────────────────

const SECTION: Readonly<
  Record<ProjectSettingsSectionId, (props: { readonly project: Project }) => ReactElement>
> = {
  connections: Connections,
  // WP-278 (TD-031 decision 8): where the agent runs execute — a settings-only control.
  execution: ({ project }) => (
    <>
      <SettingsSectionHeader
        title="Execution"
        description="Who runs this project’s agents: the platform server, developers’ own computers (workers), or both."
      />
      <ExecutionSettings projectId={project.id} />
    </>
  ),
  // WP-139: the wizard's default branch, mirrored — the *same component* (product/18:55).
  'default-branch': ({ project }) => (
    <>
      <SettingsSectionHeader
        title="Default branch"
        description="The branch agents start from and merge requests target."
      />
      <DefaultBranch projectId={project.id} />
    </>
  ),
  discovery: DiscoveryAndReadiness,
  // The wizard's step 3, mirrored (product/18:55, WP-64) — the *same component*.
  'business-context': ({ project }) => (
    <>
      <SettingsSectionHeader
        title="Business context"
        description="What the product is for and who uses it, written as knowledge pages for the agents to read."
      />
      <BusinessInterview projectId={project.id} projectKey={project.key} />
      <p className="text-sm">
        <Link to="/projects/$key/knowledge" params={{ key: project.key }}>
          Open the knowledge base
        </Link>
      </p>
    </>
  ),
  // The wizard's step 3b, mirrored (product/18:55, WP-35) — the *same component*.
  history: ({ project }) => (
    <>
      <SettingsSectionHeader
        title="History"
        description="Lessons mined from the project’s merged history, proposed as knowledge pages."
      />
      <HistoryBootstrap projectId={project.id} projectKey={project.key} />
    </>
  ),
  policies: PoliciesAndWip,
  repository: RepositoryConfiguration,
  // WP-113 (backlog 315 (b)): which prompt files the last reading holds, and what each stage gets.
  prompts: ({ project }) => <ProjectPromptFiles projectId={project.id} />,
  knowledge: ({ project }) => (
    <>
      <SettingsSectionHeader
        title="Knowledge"
        description="The wizard’s last step: the drafted pages and pending proposals."
      />
      <p className="text-sm">
        <Link to="/projects/$key/knowledge" params={{ key: project.key }}>
          Review drafted pages and pending proposals
        </Link>
      </p>
      <p className="text-xs text-fg-muted">
        Approving a proposal commits it on an <code>agentic/knowledge/*</code> branch with a merge
        request — never onto the default branch.
      </p>
    </>
  ),
};

export const ProjectSettingsScreen = ({
  projectKey,
  section,
}: {
  readonly projectKey: string;
  readonly section: ProjectSettingsSectionId;
}): ReactElement => {
  const { project, isPending, isError } = useProjectByKey(projectKey);

  if (isPending) {
    return <Loading label="Loading the project…" />;
  }
  if (isError || project === null) {
    return (
      <ErrorNotice
        title="That project could not be found."
        detail="Projects are addressed by their key, which is what the board and the wizard use."
      />
    );
  }

  const Section = SECTION[section];
  return (
    <SettingsFrame
      label="Project settings"
      groups={PROJECT_SETTINGS_GROUPS}
      current={section}
      link={(id, props) => (
        <Link
          to="/projects/$key/settings/$section"
          params={{ key: project.key, section: id }}
          {...props}
        />
      )}
    >
      <Section project={project} />
    </SettingsFrame>
  );
};
