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
 * | 2 technical discovery | re-run discovery and read the readiness ladder |
 * | 3 business interview | **not built** — the same honest gap the wizard shows |
 * | 4 operating mode | `features/operating-mode.tsx`, the *same component* the wizard renders |
 * | 5 commit | the knowledge proposal queue |
 *
 * Step 4 is not re-implemented here: both screens render one component, which is the only way a
 * mirror stays true without somebody remembering. `apps/server/src/routes/settings-mirror.test.ts`
 * is the check, and it fails in both directions.
 *
 * product/10:21 also lists **WIP limits** and **policies** on this page. They are read-only here and
 * say so: both are keys of `.agentic/config.yml` (`pipeline.wip`, `policies.*`) with no per-key
 * editor, and the pipeline screen already renders the merged document with the source of every key.
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
import { UntrustedText } from '../ui/untrusted.js';
import { OperatingMode } from './operating-mode.js';

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
  const wip =
    (config.data?.config as { pipeline?: { wip?: Record<string, number> } } | undefined)?.pipeline
      ?.wip ?? {};

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
                integrationIds: selected ?? [],
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
            Run discovery again
          </Button>
        </div>
        {commands.startDiscovery.isError ? (
          <ErrorNotice
            title="Discovery was not started."
            detail={String(commands.startDiscovery.error)}
          />
        ) : null}
        {readiness.isSuccess ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={readiness.data.level >= 2 ? 'success' : 'warning'}>
              Readiness level {readiness.data.level}
            </Badge>
            <span className="text-fg-muted">
              evaluated {formatDateTime(readiness.data.evaluated_at)}
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
        <EmptyState
          title="Not built in this release"
          hint="The wizard’s business interview is a conversational form driven by the Product Manager role, and nothing in this build runs one. The same pages can be written by hand from the Knowledge screen."
        />
        <p className="text-sm">
          <Link to="/projects/$key/knowledge" params={{ key: project.key }}>
            Open the knowledge base
          </Link>
        </p>
      </Card>

      <OperatingMode projectId={project.id} audit />

      <Card className="flex flex-col gap-1">
        <SectionHeading>WIP limits and policies</SectionHeading>
        <p className="text-xs text-fg-muted">
          Max parallel tasks {formatInteger(wip.max_parallel_tasks ?? 2)} · max tasks in pipeline{' '}
          {formatInteger(wip.max_tasks_in_pipeline ?? 5)} (BD-010’s defaults when the document sets
          none).
        </p>
        <p className="text-xs text-fg-muted">
          Read-only here: both are keys of the project’s <code>.agentic/config.yml</code>, which the
          repository also owns, so a per-key form would be a second writer of one document. The{' '}
          <Link to="/projects/$key/pipeline" params={{ key: project.key }}>
            pipeline screen
          </Link>{' '}
          shows the merged configuration and where every key came from.
        </p>
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
