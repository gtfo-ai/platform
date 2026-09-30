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
 * | 1 connect | integrations and bindings — the create and test controls live on the Integrations screen, which this page links to and whose buttons WP-30 added (PROGRESS backlog 55) |
 * | 2 technical discovery | start discovery — a second start answers `started: false` and runs nothing — plus a maintainer's **re-evaluate**, which runs discovery again as a new task with its ceiling on the button (WP-94, Q107 (a); not a wizard control, since the wizard's step is the first run), and read the readiness level, which the post-merge re-check moves for the criteria it answers without a run |
 * | 3 business interview | `BusinessInterview`, the same component the wizard renders (WP-64) |
 * | 4 operating mode | `features/operating-mode.tsx`, the *same component* the wizard renders |
 * | 5 commit | the knowledge proposal queue |
 *
 * Step 4 is not re-implemented here: both screens render one component, which is the only way a
 * mirror stays true without somebody remembering. `apps/server/src/routes/settings-mirror.test.ts`
 * is the check, and it fails in both directions.
 *
 * **The repository's own `.agentic/config.yml`** (WP-63, Q94) has a card of its own: the reading the
 * platform last took of it on the default branch, a button that proposes these settings to it as a
 * merge request, and a button that re-reads it.
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
import { Link } from '@tanstack/react-router';
import { type ReactElement, useEffect, useState } from 'react';
import {
  useIntegrations,
  useOnboardingCommands,
  useProjectBindings,
  useProjectByKey,
  useProjectConfig,
  useProjectReadiness,
} from '../app/queries.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  formatDateTime,
  formatInteger,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';
import { BusinessInterview } from './business-interview.js';
import { HistoryBootstrap } from './history-bootstrap.js';
import { bindingConfigOf, OperatingMode } from './operating-mode.js';
import { Rediscovery } from './rediscovery.js';

/**
 * What the export's answer — or the last recorded export — says, in one sentence.
 *
 * `open` is WP-91's (backlog 225): the previous export's merge request is still open, so pressing
 * the button again answers it rather than opening a second one.
 */
/** A published limit, or a statement that the server published none — never a made-up zero. */
const wipLimit = (value: number | undefined): string =>
  value === undefined ? 'not published' : formatInteger(value);

/** Who recorded the evaluation shown (`readiness_evaluations.source`), in the screen's words. */
const READINESS_SOURCE_LABEL: Readonly<Record<string, string>> = {
  discovery: 'the first discovery',
  rediscovery: 'a re-evaluation',
  recheck: 'the re-check after a merge',
};

const exportSentence = (status: 'exported' | 'unchanged' | 'open'): string =>
  status === 'unchanged'
    ? 'The repository already carries these settings; nothing was proposed.'
    : status === 'open'
      ? 'A configuration merge request is already open — no second one was opened: '
      : 'Merge request opened on ';

export const ProjectSettingsScreen = ({
  projectKey,
}: {
  readonly projectKey: string;
}): ReactElement => {
  const { project, isPending, isError } = useProjectByKey(projectKey);
  const bindings = useProjectBindings(project?.id ?? null);
  const readiness = useProjectReadiness(project?.id ?? null);
  const config = useProjectConfig(project?.id ?? null);
  const integrations = useIntegrations();
  const commands = useOnboardingCommands();
  const [selected, setSelected] = useState<readonly string[] | null>(null);
  const bound = bindings.data?.items ?? [];
  // Seeded from the server once the bindings arrive, so the checkboxes start at what is in force
  // rather than at empty — a "Save bindings" pressed on an unseeded form would unbind everything.
  useEffect(() => {
    if (bindings.isSuccess && selected === null) {
      setSelected(bound.map((binding) => binding.integration_id));
    }
  }, [bindings.isSuccess, bound, selected]);

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

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>
        Settings — <UntrustedText value={project.name} />
      </SectionHeading>
      <p className="text-xs text-fg-muted">
        Everything the setup wizard asks, reachable at any time. Nothing here is only available
        during onboarding.
      </p>

      <Card className="flex flex-col gap-2">
        <SectionHeading>Connections</SectionHeading>
        {bindings.isSuccess && bound.length === 0 ? (
          <EmptyState
            title="No integrations bound"
            hint="A project needs a ticket board and a git host before the pipeline can start anything."
          />
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {bound.map((binding) => (
              <li key={binding.integration_id} className="flex items-center gap-2">
                <Badge tone="accent">{binding.type}</Badge>
                <UntrustedText value={binding.name} />
                <Badge>{binding.provider}</Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm">
          <Link to="/integrations">Add or test an integration</Link> — credentials are read from the
          server’s own environment and never travel through the browser (BD-002).
        </p>
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold">Which integrations this project uses</p>
          {(integrations.data?.items ?? []).map((integration) => (
            <label key={integration.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={(selected ?? []).includes(integration.id)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...(selected ?? []), integration.id]
                      : (selected ?? []).filter((id) => id !== integration.id),
                  )
                }
              />
              <UntrustedText value={integration.name} />
              <Badge>{integration.type}</Badge>
            </label>
          ))}
        </div>
        <div>
          <Button
            disabled={commands.putBindings.isPending}
            onClick={() => {
              // The **whole set**: a binding missing from the request is deleted, which is what
              // makes this re-submittable and what lets somebody correct a mistake without a
              // second endpoint (`PUT …/bindings`, WP-21).
              commands.putBindings.mutate({
                projectId: project.id,
                // With the configuration each binding already carries: the notification channel is
                // a key of it (WP-32), and this button must not be a way to lose it.
                items: (selected ?? []).map((id) => ({
                  integration_id: id,
                  config: bindingConfigOf(bindings.data?.items ?? [], id),
                })),
              });
            }}
          >
            Save bindings
          </Button>
        </div>
        {commands.putBindings.isError ? (
          <ErrorNotice
            title="The bindings were not saved."
            detail={String(commands.putBindings.error)}
          />
        ) : null}
      </Card>

      <Card className="flex flex-col gap-2">
        <SectionHeading>Technical discovery and readiness</SectionHeading>
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
          Start discovery runs the first evaluation; once it has run, it starts nothing. After a
          merge the platform re-checks the readiness criteria it can read without a run; the rest
          keep the latest discovery’s answer until a maintainer re-evaluates.
        </p>
        {commands.startDiscovery.isError ? (
          <ErrorNotice
            title="Discovery was not started."
            detail={String(commands.startDiscovery.error)}
          />
        ) : null}
        {/* WP-94, Q107 (a): discovery again, on a maintainer's click, with its ceiling shown. */}
        <Rediscovery projectId={project.id} />
        {readiness.isSuccess ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={readiness.data.level >= 2 ? 'success' : 'warning'}>
              Readiness level {readiness.data.level}
            </Badge>
            <span className="text-fg-muted">
              evaluated {formatDateTime(readiness.data.evaluated_at)} by{' '}
              <UntrustedText
                value={READINESS_SOURCE_LABEL[readiness.data.source] ?? readiness.data.source}
              />
            </span>
          </div>
        ) : (
          <p className="text-xs text-fg-muted">
            No readiness evaluation yet — running discovery is what records one.
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-2">
        <SectionHeading>Business context</SectionHeading>
        {/* The wizard's step 3, mirrored (product/18:55, WP-64) — the *same component*. */}
        <BusinessInterview projectId={project.id} projectKey={project.key} />
        <p className="text-sm">
          <Link to="/projects/$key/knowledge" params={{ key: project.key }}>
            Open the knowledge base
          </Link>
        </p>
      </Card>

      {/**
       * The wizard's step 3b, mirrored (product/18:55, WP-35) — the *same component*, which is how
       * the mirror stays true without anybody remembering to keep two of them in step.
       */}
      <Card className="flex flex-col gap-2">
        <SectionHeading>History bootstrap</SectionHeading>
        <HistoryBootstrap projectId={project.id} projectKey={project.key} />
      </Card>

      <OperatingMode projectId={project.id} audit />

      <Card className="flex flex-col gap-1">
        <SectionHeading>WIP limits and policies</SectionHeading>
        {config.data === undefined ? null : (
          <p className="text-xs text-fg-muted">
            Max parallel tasks {wipLimit(config.data.effective.pipeline?.wip?.max_parallel_tasks)} (
            {config.data.sources['pipeline.wip.max_parallel_tasks'] ?? 'default'}) · max tasks in
            pipeline {wipLimit(config.data.effective.pipeline?.wip?.max_tasks_in_pipeline)} (
            {config.data.sources['pipeline.wip.max_tasks_in_pipeline'] ?? 'default'}) —{' '}
            <code>pipeline.wip</code> in the settings or <code>.agentic/config.yml</code>. A
            repository file may lower a limit and never raise it, and neither may go above the
            organisation’s maximum.
          </p>
        )}
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

      {/**
       * WP-63, Q94: the repository's own `.agentic/config.yml` wins over these settings once it is
       * merged (a), it is only ever written through a merge request (b), and this button stays on
       * the page so a settings change six months from now is reviewable too (c).
       */}
      <Card className="flex flex-col gap-2">
        <SectionHeading>Repository configuration</SectionHeading>
        {config.data === undefined ? null : (
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={config.data.repository.status === 'valid' ? 'success' : 'neutral'}>
              .agentic/config.yml: {config.data.repository.status}
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
          The file on the default branch wins over the settings on this page wherever it states a
          key. Changes made here reach the repository as a merge request — never a direct commit —
          together with a one-line pointer to the knowledge index in <code>CLAUDE.md</code>.
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
            (as recorded then; pressing the button again checks whether it is still open, and
            answers it rather than opening a second one)
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
          <ErrorNotice
            title="The settings were not proposed."
            detail={String(commands.exportConfig.error)}
          />
        ) : null}
        {commands.refreshConfig.isSuccess &&
        commands.refreshConfig.data.repository.status === 'invalid' ? (
          <ErrorNotice
            title="The repository’s .agentic/config.yml does not parse — no run starts until it does."
            detail={commands.refreshConfig.data.repository.detail ?? ''}
          />
        ) : null}
        {commands.refreshConfig.isError ? (
          <ErrorNotice
            title="The repository could not be re-read."
            detail={String(commands.refreshConfig.error)}
          />
        ) : null}
      </Card>

      <Card className="flex flex-col gap-1">
        <SectionHeading>Knowledge</SectionHeading>
        <p className="text-sm">
          <Link to="/projects/$key/knowledge" params={{ key: project.key }}>
            Review drafted pages and pending proposals
          </Link>
        </p>
        <p className="text-xs text-fg-muted">
          The wizard’s last step. Approving a proposal commits it on an{' '}
          <code>agentic/knowledge/*</code> branch with a merge request — never onto the default
          branch (BD-012, BD-007).
        </p>
      </Card>
    </div>
  );
};
