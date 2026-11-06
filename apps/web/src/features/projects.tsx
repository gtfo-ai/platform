/**
 * `/projects` — every project the caller may read, as a list box (research/19 § 5.1).
 *
 * One row per project: its name (the way in), its key, its readiness, its open tasks and its
 * 30-day spend, all from `GET /api/projects`. The header's one primary action is **New project**,
 * which is the onboarding wizard; an empty list says what a project is and offers the same — both
 * only for a caller the create route would admit (`can_create`, S-23.23); anyone else is told an
 * administrator creates projects.
 *
 * **"Needs you" per project is not drawn**: the inbox's questions and approvals carry a task id and
 * no project id, so a per-project count would need a read this screen does not have. The total is
 * in the top bar; the per-project figure is a backlog row, not an invention here.
 */
import { RepoIcon } from '@primer/octicons-react/RepoIcon';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useProjects } from '../app/queries.js';
import { useTopics } from '../realtime/provider.js';
import { Blankslate } from '../ui/blankslate.js';
import { buttonClassName } from '../ui/button.js';
import { PROJECT_STATUS_LABEL } from '../ui/humanize.js';
import { Badge, ErrorNotice, formatInteger, formatUsd } from '../ui/kit.js';
import { ListBox, ListBoxHeader, ListRow } from '../ui/list-box.js';
import { PageHeader } from '../ui/page-header.js';
import { rowLink } from '../ui/row-link.js';
import { Skeleton } from '../ui/skeleton.js';
import { UntrustedText } from '../ui/untrusted.js';
import { ReadinessLabel } from './readiness-label.js';

export const ProjectsScreen = (): ReactElement => {
  useTopics(['org']);
  const projects = useProjects();
  const items = projects.data?.items ?? [];
  // S-23.23: `POST /api/projects` is an administrator's (`project.create`); the list says whether
  // this caller may, so nobody else is offered a wizard whose first command answers 403.
  const canCreate = projects.data?.can_create === true;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Projects"
        divider={false}
        actions={
          canCreate ? (
            <Link to="/onboarding" className={buttonClassName('primary')}>
              New project
            </Link>
          ) : undefined
        }
      />
      {projects.isPending ? <Skeleton label="Loading projects…" /> : null}
      {projects.isError ? (
        <ErrorNotice title="Projects could not be loaded." error={projects.error} />
      ) : null}
      {projects.isSuccess && items.length === 0 ? (
        canCreate ? (
          <Blankslate
            size="spacious"
            icon={<RepoIcon size={24} />}
            title="No projects yet"
            hint="A project connects a ticket board and a repository. Once it is set up, the pipeline picks up its tickets and turns them into merge requests."
            action={
              <Link to="/onboarding" className={buttonClassName('default')}>
                New project
              </Link>
            }
          />
        ) : (
          <Blankslate
            informational
            size="spacious"
            icon={<RepoIcon size={24} />}
            title="No projects yet"
            hint="Ask an administrator to create a project. It connects a ticket board and a repository, and the pipeline then turns its tickets into merge requests."
          />
        )
      ) : null}
      {items.length === 0 ? null : (
        <ListBox
          label="Projects"
          header={
            <ListBoxHeader>
              <span className="font-semibold text-fg">
                {`${formatInteger(items.length)} ${items.length === 1 ? 'project' : 'projects'}`}
              </span>
            </ListBoxHeader>
          }
        >
          {items.map((project) => (
            <ListRow
              key={project.id}
              leading={
                <span aria-hidden="true" className="text-fg-muted">
                  <RepoIcon size={16} />
                </span>
              }
              title={
                <Link
                  to="/projects/$key"
                  params={{ key: project.key }}
                  {...rowLink('hover:text-link hover:underline')}
                >
                  <UntrustedText value={project.name} />
                </Link>
              }
              meta={
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="font-mono">
                    <UntrustedText value={project.key} />
                  </span>
                  {project.status === 'active' ? null : (
                    <Badge tone="neutral">{PROJECT_STATUS_LABEL[project.status]}</Badge>
                  )}
                </span>
              }
              trailing={
                <>
                  <ReadinessLabel level={project.readiness_level} project={project} />
                  <span title="Tasks in this project that are not done or cancelled.">
                    {`${formatInteger(project.open_tasks)} open`}
                  </span>
                  <span
                    className="w-24 text-right tabular-nums"
                    title="Cost for this project over the last 30 days: reported by the provider, or priced from the price list where it reports none."
                  >
                    {`${formatUsd(project.spent_usd_30d)} · 30d`}
                  </span>
                </>
              }
            />
          ))}
        </ListBox>
      )}
    </div>
  );
};
