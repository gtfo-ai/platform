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
 * The `diff` column is opaque JSON in which a secret appears as the literal string `"changed"` —
 * the server's job, not this screen's — and it is rendered as text like everything else; the keys
 * and every id go through `ui/untrusted.tsx`.
 */
import { FilterIcon } from '@primer/octicons-react/FilterIcon';
import { LogIcon } from '@primer/octicons-react/LogIcon';
import { type ReactElement, useState } from 'react';
import { useAudit, useOrgUsers } from '../app/queries.js';
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

/** The filter's value for "every type". */
const ALL = 'all';

const KNOWN_TYPES = Object.keys(AUDIT_ENTITY_FILTER_LABEL);

export const AuditScreen = (): ReactElement => {
  const [entityType, setEntityType] = useState<string>(ALL);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const filters = {
    ...(entityType === ALL ? {} : { entity_type: entityType }),
    ...(cursor === undefined ? {} : { cursor }),
  };
  const audit = useAudit(filters);
  const users = useOrgUsers();
  const nextCursor = audit.data?.next_cursor ?? null;
  const items = audit.data?.items ?? [];
  const nameOf = (userId: string | null): string => {
    if (userId === null) {
      return 'A removed account';
    }
    const user = users.data?.items.find((candidate) => candidate.id === userId);
    return user === undefined ? 'Someone' : (user.name ?? user.email);
  };
  const filterLabel =
    entityType === ALL ? 'All types' : (AUDIT_ENTITY_FILTER_LABEL[entityType] ?? entityType);

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
              <ActionMenu
                trigger={
                  <Button
                    size="sm"
                    tone="invisible"
                    leadingIcon={<FilterIcon size={16} />}
                    aria-label={`Filter by type: ${filterLabel}`}
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
              title={entityType === ALL ? 'No audit entries' : 'No changes of this type'}
              hint="Every configuration change is recorded here, with who made it. An empty log means nothing has been changed on this instance yet."
            />
          </li>
        ) : null}
        {items.map((entry) => {
          const who = nameOf(entry.user_id);
          const keys = Object.keys(entry.diff);
          return (
            <ListRow
              key={entry.id}
              leading={<Avatar name={who} size={20} decorative />}
              title={
                <span className="font-normal">
                  <span className="font-semibold">
                    <UntrustedText value={who} />
                  </span>{' '}
                  {`changed ${auditEntityLabel(entry.entity_type)}`}
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
