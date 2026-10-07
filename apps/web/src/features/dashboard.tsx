/**
 * The org dashboard (product/10 § "Information architecture").
 *
 * Spend, active agents and open work at a glance, then a way into each project. It watches the
 * `org` topic, which is what makes the agent count move without a refresh.
 */
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import {
  useAgents,
  useBindableIntegrations,
  useInbox,
  useProjects,
  useSession,
  useVersion,
} from '../app/queries.js';
import { useTopics } from '../realtime/provider.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  formatInteger,
  formatUsd,
  Loading,
  Metric,
  SectionHeading,
} from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

/**
 * **One broken organisation account, named once** (WP-157 (a), PROGRESS backlog 413).
 *
 * A communication account whose credentials will not decrypt withholds the prompt files of every
 * project, so it is said here once for the organisation rather than on each project's settings
 * card. The server decides it (`credentials_readable`, the loader that withholds); this renders one
 * banner however many projects there are, naming every such account, and nothing when none is.
 */
const UnreadableAccountsBanner = (): ReactElement | null => {
  // The live communication accounts — the only rows the server answers `credentials_readable` for —
  // through WP-122's selector, so the unfiltered read stays the Integrations screen's alone
  // (`app/bindable-integrations.test.ts`).
  const broken = useBindableIntegrations('communication').items.filter(
    (integration) => integration.credentials_readable === false,
  );
  const first = broken[0];
  if (first === undefined) {
    return null;
  }
  return (
    <div data-unreadable-accounts>
      <ErrorNotice
        title={`An organisation account's credentials cannot be decrypted: ${broken
          .map((integration) => `${integration.name} (${integration.provider})`)
          .join(', ')}.`}
        // The server's sentence only (rule 3): no consequence text is invented here.
        detail={
          first.credentials_consequence === null
            ? 'Repair it under Integrations.'
            : `${first.credentials_consequence} Repair it under Integrations.`
        }
      />
    </div>
  );
};

/**
 * `GET /api/integrations` is `integration.read`, an organisation `maintainer` (Q36): a member or a
 * viewer is not asked, so the dashboard makes no request it knows will answer 403.
 */
const OrganisationAccountSignal = (): ReactElement | null => {
  const session = useSession();
  const role = session.data?.user.role;
  return role === 'admin' || role === 'maintainer' ? <UnreadableAccountsBanner /> : null;
};

export const DashboardScreen = (): ReactElement => {
  useTopics(['org']);
  const projects = useProjects();
  const agents = useAgents();
  const inbox = useInbox();
  const version = useVersion();

  const spend = (projects.data?.items ?? []).reduce((total, item) => total + item.spent_usd_30d, 0);
  const openTasks = (projects.data?.items ?? []).reduce(
    (total, item) => total + item.open_tasks,
    0,
  );
  const pending = (inbox.data?.questions.length ?? 0) + (inbox.data?.approvals.length ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <OrganisationAccountSignal />
      <section>
        <SectionHeading>Organisation</SectionHeading>
        <Card>
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <Metric
              label="Spend, 30 days"
              value={formatUsd(spend)}
              definition="Sum of provider-reported cost across all projects over the last 30 days; estimated where the provider reports none (BD-011)."
            />
            <Metric
              label="Open tasks"
              value={formatInteger(openTasks)}
              definition="Tasks in any state other than done or cancelled."
            />
            <Metric
              label="Agents running"
              value={formatInteger(agents.data?.items.length ?? 0)}
              definition="Runs whose status is running right now."
            />
            <Metric
              label="Awaiting a human"
              value={formatInteger(pending)}
              definition="Questions and approvals pending for you across every project."
            />
          </div>
        </Card>
      </section>

      <section>
        <SectionHeading
          actions={
            version.data === undefined ? null : (
              <span className="font-mono text-[11px] text-fg-muted">
                <UntrustedText value={version.data.version} />
              </span>
            )
          }
        >
          Projects
        </SectionHeading>
        {projects.isPending ? <Loading label="Loading projects…" /> : null}
        {projects.isError ? (
          <ErrorNotice title="Projects could not be loaded." detail={String(projects.error)} />
        ) : null}
        {projects.data?.items.length === 0 ? (
          <EmptyState
            title="No projects yet"
            hint="A project connects a ticket board and a repository. Add one from the onboarding wizard; until then the pipeline has nothing to pick up."
          />
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(projects.data?.items ?? []).map((project) => (
            <Card key={project.id}>
              <div className="flex items-start justify-between gap-2">
                <Link
                  to="/projects/$key"
                  params={{ key: project.key }}
                  className="text-sm font-semibold hover:underline"
                >
                  <UntrustedText value={project.name} />
                </Link>
                <Badge tone={project.status === 'active' ? 'success' : 'neutral'}>
                  {project.status}
                </Badge>
              </div>
              <p className="pt-1 font-mono text-xs text-fg-muted">
                <UntrustedText value={project.key} />
              </p>
              <div className="grid grid-cols-3 gap-3 pt-3">
                <Metric
                  label="Open"
                  value={formatInteger(project.open_tasks)}
                  definition="Tasks in this project that are not done or cancelled."
                />
                <Metric
                  label="30-day spend"
                  value={formatUsd(project.spent_usd_30d)}
                  definition="Provider-reported cost for this project over the last 30 days."
                />
                <Metric
                  label="Readiness"
                  value={`L${project.readiness_level}`}
                  definition="Readiness level 0–5 from the last evaluation (product/17). Report-only; it never auto-remediates."
                />
              </div>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
};
