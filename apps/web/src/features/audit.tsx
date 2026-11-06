/**
 * The audit log (product/10 § "Audit log"): a filterable stream of configuration changes.
 *
 * `GET /api/org/audit` reads `config_audit`, and its cursor is the ISO timestamp the previous page
 * returned. Since S-23.11b each entry is a GitHub-style list row — **avatar · who · what, in words ·
 * when** — with the raw diff and the entity's id behind *Details* (research/19 § 3.6), and the
 * entity filter is a menu of the known types rather than a free-text box.
 *
 * **Who** is resolved through the user list (`GET /api/org/users`): a row carries a `user_id` only.
 * A row whose user was removed (`user_id` null: the foreign key is `on delete set null`) says so; a
 * user the list does not name — the list failed, or the reader may not read it — is "someone", never
 * an invented name. **What** is the entity type in words and the changed keys as labels
 * (`configFieldLabel`): an entity type this build does not know is title-cased, never dropped.
 *
 * **Which project** (S-25.7, research/21 S12, F15): a row of type `project` names its project — its
 * `entity_id` is the project's id, looked up in the project list the caller may read — and the
 * *Project* filter keeps the rows of one project. `GET /api/org/audit` filters by type only, so the
 * project filter asks the server for type `project` and keeps that project's rows **on the client**,
 * on the page on screen — *Load older entries* replaces the page rather than appending to it, so the
 * filter covers one page at a time, and the screen says so (review of PR #86).
 * A row of another type (a connection, a budget) carries no project the screen can name, and is not
 * guessed at.
 *
 * The `diff` column is opaque JSON in which a secret appears as the literal string `"changed"` —
 * the server's job, not this screen's — and it is rendered as text like everything else; the keys
 * and every id go through `ui/untrusted.tsx`.
 */
import { FilterIcon } from '@primer/octicons-react/FilterIcon';
import { LogIcon } from '@primer/octicons-react/LogIcon';
import { type ReactElement, useState } from 'react';
import { useAudit, useOrgUsers, useProjects } from '../app/queries.js';
import {
  ActionMenu,
  ActionMenuRadioGroup,
  ActionMenuRadioItem,
  ActionMenuSeparator,
} from '../ui/action-menu.js';
import { Avatar } from '../ui/avatar.js';
import { Blankslate } from '../ui/blankslate.js';
import { Button } from '../ui/button.js';
import { DetailsDisclosure } from '../ui/details.js';
import { AUDIT_ENTITY_FILTER_LABEL, auditEntityLabel, configFieldLabel } from '../ui/humanize.js';
import { ErrorNotice, formatDateTime, formatInteger } from '../ui/kit.js';
import { ListBox, ListBoxHeader, ListRow } from '../ui/list-box.js';
import { PageHeader } from '../ui/page-header.js';
import { Skeleton } from '../ui/skeleton.js';
import { JsonView, UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';

/** The filter's value for "every type". */
const ALL = 'all';

const KNOWN_TYPES = Object.keys(AUDIT_ENTITY_FILTER_LABEL);

export const AuditScreen = (): ReactElement => {
  const [entityType, setEntityType] = useState<string>(ALL);
  const [projectFilter, setProjectFilter] = useState<string>(ALL);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // A project's rows are of type `project`: that is what the server is asked for once one is picked.
  const askedType = projectFilter === ALL ? entityType : 'project';
  const filters = {
    ...(askedType === ALL ? {} : { entity_type: askedType }),
    ...(cursor === undefined ? {} : { cursor }),
  };
  const audit = useAudit(filters);
  const users = useOrgUsers();
  const projects = useProjects();
  const projectList = projects.data?.items ?? [];
  const nextCursor = audit.data?.next_cursor ?? null;
  /** The project a row names: a `project` row's entity, when the caller may read that project. */
  const projectOf = (entry: { readonly entity_type: string; readonly entity_id: string | null }) =>
    entry.entity_type === 'project' && entry.entity_id !== null
      ? (projectList.find((project) => project.id === entry.entity_id) ?? null)
      : null;
  const items = (audit.data?.items ?? []).filter(
    (entry) => projectFilter === ALL || projectOf(entry)?.id === projectFilter,
  );
  const projectLabel =
    projectFilter === ALL
      ? 'All projects'
      : sanitiseUntrusted(
          projectList.find((project) => project.id === projectFilter)?.name ?? 'A project',
        );
  const nameOf = (userId: string | null): string => {
    if (userId === null) {
      return 'A removed account';
    }
    const user = users.data?.items.find((candidate) => candidate.id === userId);
    return user === undefined ? 'Someone' : (user.name ?? user.email);
  };
  const filterLabel =
    askedType === ALL ? 'All types' : (AUDIT_ENTITY_FILTER_LABEL[askedType] ?? askedType);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Audit log" divider={false} />

      {audit.isError ? (
        <ErrorNotice title="The audit log could not be loaded." error={audit.error} />
      ) : null}

      <ListBox
        label="Audit entries"
        header={
          <ListBoxHeader
            actions={
              <>
                <ActionMenu
                  trigger={
                    <Button
                      size="sm"
                      tone="invisible"
                      leadingIcon={<FilterIcon size={16} />}
                      aria-label={`Filter by project: ${projectLabel}`}
                    >
                      {projectLabel}
                    </Button>
                  }
                >
                  <ActionMenuRadioGroup
                    label="Show changes to"
                    value={projectFilter}
                    onValueChange={(value: string) => {
                      setProjectFilter(value);
                      setCursor(undefined);
                    }}
                  >
                    <ActionMenuRadioItem value={ALL} closeOnClick>
                      All projects
                    </ActionMenuRadioItem>
                    <ActionMenuSeparator />
                    {projectList.map((project) => (
                      <ActionMenuRadioItem key={project.id} value={project.id} closeOnClick>
                        {sanitiseUntrusted(project.name)}
                      </ActionMenuRadioItem>
                    ))}
                  </ActionMenuRadioGroup>
                </ActionMenu>
                <ActionMenu
                  trigger={
                    <Button
                      size="sm"
                      tone="invisible"
                      leadingIcon={<FilterIcon size={16} />}
                      aria-label={`Filter by type: ${filterLabel}`}
                      disabled={projectFilter !== ALL}
                    >
                      {filterLabel}
                    </Button>
                  }
                >
                  <ActionMenuRadioGroup
                    label="Show changes to"
                    value={entityType}
                    onValueChange={(value: string) => {
                      setEntityType(value);
                      setCursor(undefined);
                    }}
                  >
                    <ActionMenuRadioItem value={ALL} closeOnClick>
                      All types
                    </ActionMenuRadioItem>
                    <ActionMenuSeparator />
                    {KNOWN_TYPES.map((type) => (
                      <ActionMenuRadioItem key={type} value={type} closeOnClick>
                        {AUDIT_ENTITY_FILTER_LABEL[type]}
                      </ActionMenuRadioItem>
                    ))}
                  </ActionMenuRadioGroup>
                </ActionMenu>
              </>
            }
          >
            <span className="font-semibold text-fg">
              {audit.isSuccess
                ? `${formatInteger(items.length)} change${items.length === 1 ? '' : 's'}${nextCursor === null ? '' : ' on this page'}`
                : 'Changes'}
            </span>
          </ListBoxHeader>
        }
      >
        {audit.isPending ? (
          <li className="px-4 py-3">
            <Skeleton label="Loading audit entries…" lines={3} />
          </li>
        ) : null}
        {audit.isSuccess && items.length === 0 ? (
          <li>
            <Blankslate
              informational
              className="border-0"
              icon={<LogIcon size={24} />}
              title={
                projectFilter !== ALL
                  ? 'No changes to this project on this page'
                  : entityType === ALL
                    ? 'No audit entries'
                    : 'No changes of this type'
              }
              hint="Every configuration change is recorded here, with who made it. An empty log means nothing has been changed on this instance yet."
            />
          </li>
        ) : null}
        {items.map((entry) => {
          const who = nameOf(entry.user_id);
          const keys = Object.keys(entry.diff);
          const project = projectOf(entry);
          return (
            <ListRow
              key={entry.id}
              leading={<Avatar name={who} size={20} decorative />}
              title={
                <span className="font-normal">
                  <span className="font-semibold">
                    <UntrustedText value={who} />
                  </span>{' '}
                  {project === null ? (
                    `changed ${auditEntityLabel(entry.entity_type)}`
                  ) : (
                    <>
                      {'changed the settings of '}
                      <span className="font-semibold" data-audit-project="">
                        <UntrustedText value={project.name} />
                      </span>
                    </>
                  )}
                  {keys.length === 0 ? null : (
                    <>
                      {': '}
                      <UntrustedText value={keys.map(configFieldLabel).join(', ')} />
                    </>
                  )}
                </span>
              }
              meta={
                <DetailsDisclosure summary="Details">
                  <div className="flex flex-col gap-1">
                    <p className="text-xs">
                      {'Type '}
                      <UntrustedText value={entry.entity_type} className="font-mono" />
                      {entry.entity_id === null ? null : (
                        <>
                          {' · id '}
                          <UntrustedText value={entry.entity_id} className="font-mono" />
                        </>
                      )}
                    </p>
                    <JsonView value={entry.diff} />
                  </div>
                </DetailsDisclosure>
              }
              trailing={<time dateTime={entry.created_at}>{formatDateTime(entry.created_at)}</time>}
            />
          );
        })}
      </ListBox>

      {projectFilter === ALL ? null : (
        <p className="text-xs text-fg-muted" data-audit-project-filter="">
          The project filter keeps this project’s settings changes on this page.
          {nextCursor === null ? '' : ' Load older entries to look at the page before it.'}
        </p>
      )}

      {nextCursor === null ? null : (
        <div>
          <Button
            onClick={() => {
              setCursor(nextCursor);
            }}
          >
            Load older entries
          </Button>
        </div>
      )}
    </div>
  );
};
