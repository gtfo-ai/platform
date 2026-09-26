/**
 * Provider identities — who a Slack, Jira or GitLab account is (WP-43, PROGRESS backlog 79).
 *
 * `POST /api/org/identities` has existed since WP-31 and **nothing in the SPA called it**, so on
 * every instance an approval pressed in Slack or an answer written in a ticket arrived as
 * `unmapped_identity` and was acted on by nobody — the fail-closed default BD-022 and Q10 ask for,
 * with no way out short of `curl`. This section is the way out, on the organisation settings page
 * where product/10 puts user management.
 *
 * ## What an admin states, and what the platform never guesses
 *
 * The pairing is **stated**: a provider, the account's id *in that provider* (a Slack member id
 * such as `U0123ABCD`, which Slack sets and nobody can type into a message), and either the platform
 * user it belongs to or *machine* — a bot, which maps to nobody on purpose. There is no email match
 * and no suggestion: an identity the platform guessed would then be allowed to approve a plan,
 * which is the one thing the rule exists to refuse. `display_name` is a label for this list and
 * resolves nothing.
 *
 * Everything shown here came from somebody else — a provider's account id, a display name, an
 * email — so every string goes through `UntrustedText` (BD-022).
 *
 * The server holds both routes to `org.users.manage` (admin). A non-admin sees the refusal named
 * rather than an empty list that would read as "nobody is mapped".
 */
import type { IdentityMapping } from '@platform/contracts';
import { type FormEvent, type ReactElement, useState } from 'react';
import { useOrgIdentities, useOrgUsers, useSettingsCommands } from '../app/queries.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

/** The providers whose normaliser resolves an author through this table on this build. */
export const IDENTITY_PROVIDERS = ['slack', 'jira-cloud', 'gitlab'] as const;

type Kind = 'person' | 'machine';

const describeUser = (
  mapping: IdentityMapping,
  emailOf: (userId: string) => string | null,
): string => {
  if (mapping.kind === 'machine' || mapping.user_id === null) {
    return 'machine — acts for nobody';
  }
  return emailOf(mapping.user_id) ?? mapping.user_id;
};

export const IdentityMappings = (): ReactElement => {
  const identities = useOrgIdentities();
  const users = useOrgUsers();
  const commands = useSettingsCommands();
  const [provider, setProvider] = useState<string>('slack');
  const [externalId, setExternalId] = useState('');
  const [kind, setKind] = useState<Kind>('person');
  const [userId, setUserId] = useState('');
  const [displayName, setDisplayName] = useState('');

  const userItems = users.data?.items ?? [];
  const emailOf = (id: string): string | null =>
    userItems.find((user) => user.id === id)?.email ?? null;

  const canSubmit =
    externalId.trim() !== '' &&
    (kind === 'machine' || userId !== '') &&
    !commands.mapIdentity.isPending;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    const account = {
      provider,
      external_id: externalId.trim(),
      ...(displayName.trim() === '' ? {} : { display_name: displayName.trim() }),
    };
    commands.mapIdentity.mutate(
      kind === 'machine'
        ? { ...account, kind: 'machine' as const }
        : { ...account, kind: 'person' as const, user_id: userId },
      {
        onSuccess: () => {
          setExternalId('');
          setDisplayName('');
        },
      },
    );
  };

  return (
    <section aria-label="Provider identities">
      <SectionHeading>Provider identities</SectionHeading>
      <p className="pb-2 text-xs text-fg-muted">
        A decision that arrives from Slack, Jira or GitLab — an approval button, an answer in a
        thread or a ticket comment — counts only when its author is mapped here to a person. An
        unmapped author is recorded and acted on by nobody. The account id is the provider’s own (a
        Slack member id looks like <code>U0123ABCD</code>); the platform never matches by email.
      </p>

      {identities.isPending ? <Loading label="Loading identities…" /> : null}
      {identities.isError ? (
        <ErrorNotice
          title="The identity mappings could not be loaded."
          detail="Reading and writing them needs the admin role, because a mapping decides who may act as whom."
        />
      ) : null}
      {identities.isSuccess && identities.data.items.length === 0 ? (
        <EmptyState
          title="Nobody is mapped yet"
          hint="Until an account is mapped, every chat approval, chat answer and ticket comment from it is recorded as unmapped_identity and changes nothing."
        />
      ) : null}
      <ul className="flex flex-col gap-1" aria-label="Mapped provider accounts">
        {(identities.data?.items ?? []).map((mapping) => (
          <li key={`${mapping.provider}:${mapping.external_id}`}>
            <Card className="flex flex-wrap items-center gap-2 text-sm">
              <Badge>
                <UntrustedText value={mapping.provider} />
              </Badge>
              <code className="font-mono text-xs">
                <UntrustedText value={mapping.external_id} />
              </code>
              {mapping.display_name === null ? null : (
                <span className="text-fg-muted">
                  <UntrustedText value={mapping.display_name} />
                </span>
              )}
              <span aria-hidden="true">→</span>
              <Badge tone={mapping.kind === 'machine' ? 'warning' : 'accent'}>{mapping.kind}</Badge>
              <UntrustedText value={describeUser(mapping, emailOf)} />
            </Card>
          </li>
        ))}
      </ul>

      {identities.isError ? null : (
        <form
          aria-label="Map a provider account"
          className="mt-3 flex flex-col gap-2"
          onSubmit={submit}
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Provider
              <select
                aria-label="Provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
              >
                {IDENTITY_PROVIDERS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="Account id in the provider"
              value={externalId}
              maxLength={256}
              onChange={(event) => setExternalId(event.target.value)}
            />
            <Field
              label="Display name (optional)"
              value={displayName}
              maxLength={256}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
          <fieldset className="flex flex-wrap items-center gap-3 text-sm">
            <legend className="sr-only">Who the account is</legend>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="identity-kind"
                checked={kind === 'person'}
                onChange={() => setKind('person')}
              />
              A person
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="identity-kind"
                checked={kind === 'machine'}
                onChange={() => setKind('machine')}
              />
              A machine (a bot — acts for nobody)
            </label>
            {kind === 'person' ? (
              <label className="flex items-center gap-2">
                Platform user
                <select
                  aria-label="Platform user"
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                  className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
                >
                  <option value="">Choose…</option>
                  {userItems.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.email}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </fieldset>
          <div>
            <Button type="submit" disabled={!canSubmit}>
              Save mapping
            </Button>
          </div>
          {commands.mapIdentity.error === null ? null : (
            <ErrorNotice
              title="The mapping was not saved."
              detail={String(commands.mapIdentity.error)}
            />
          )}
        </form>
      )}
    </section>
  );
};
