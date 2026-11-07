/**
 * Linked accounts (*Provider identities* until S-25.6) — who a Slack, Jira or GitLab account is
 * (WP-43, PROGRESS backlog 79).
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
 * and no suggested **person**: an identity the platform guessed would then be allowed to approve a
 * plan, which is the one thing the rule exists to refuse. `display_name` is a label for this list
 * and resolves nothing.
 *
 * **What it does offer, since WP-44, is the account** (PROGRESS backlog 198): the provider ids the
 * platform refused as `unmapped_identity` and nobody has mapped since, read off the inbound
 * deliveries. Choosing one fills the provider and the account id into the form — it writes nothing,
 * and who the account is stays the admin's statement. Before this list the screen asked for an id
 * the operator had no way to find short of SQL.
 *
 * Everything shown here came from somebody else — a provider's account id, a display name, an
 * email — so every string goes through `UntrustedText` (BD-022).
 *
 * **Since S-26.8a each row has *Unlink*** (`DELETE /api/org/identities/:provider/:external_id`,
 * S-26.6), behind a confirmation that names the account and the person — or says it is a machine —
 * whoever linked it: this form, or the person's own confirmed code (*Settings → Your accounts*). And
 * the candidates include the **unlinked tracker assignees of live tasks** (S-26.6's
 * `assigned_tasks`, with the tracker's display name), said as *assigned to 3 tasks*, so an
 * administrator sees who the tracker gives work to that no person on the platform holds.
 *
 * The server holds every route to `org.users.manage` (admin). A non-admin sees the refusal named
 * rather than an empty list that would read as "nobody is mapped".
 */
import type { IdentityCandidate, IdentityMapping } from '@platform/contracts';
import { type FormEvent, type ReactElement, useState } from 'react';
import { readErrorDetail } from '../api/read-error.js';
import {
  useIdentityCandidates,
  useOrgIdentities,
  useOrgUsers,
  useSettingsCommands,
} from '../app/queries.js';
import { ConfirmDialog } from '../ui/confirm-dialog.js';
import {
  accountProviderName,
  LINKED_ACCOUNTS_WORDS,
  linkRefusal,
} from '../ui/humanize-accounts.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  formatDateTime,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { Select } from '../ui/select.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';

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

/** A candidate's facts: *assigned to 3 tasks · 2 refused · last …*, each only when it is so. */
const candidateFacts = (candidate: IdentityCandidate): string =>
  [
    ...(candidate.assigned_tasks === undefined
      ? []
      : [LINKED_ACCOUNTS_WORDS.assignedTo(candidate.assigned_tasks)]),
    ...(candidate.deliveries === 0 ? [] : [LINKED_ACCOUNTS_WORDS.refused(candidate.deliveries)]),
    LINKED_ACCOUNTS_WORDS.lastSeen(formatDateTime(candidate.last_seen_at)),
  ].join(' · ');

/** The confirmation's words for unlinking `mapping` — the account, and the person or *machine*. */
const unlinkWords = (
  mapping: IdentityMapping,
  personOf: (userId: string) => string | null,
): { readonly title: string; readonly consequence: string } => {
  const provider = accountProviderName(mapping.provider);
  const account = sanitiseUntrusted(mapping.display_name ?? mapping.external_id);
  if (mapping.kind === 'machine' || mapping.user_id === null) {
    return {
      title: LINKED_ACCOUNTS_WORDS.unlinkMachineTitle(provider, account),
      consequence: LINKED_ACCOUNTS_WORDS.unlinkMachineConsequence,
    };
  }
  const person = sanitiseUntrusted(personOf(mapping.user_id) ?? mapping.user_id);
  return {
    title: LINKED_ACCOUNTS_WORDS.unlinkPersonTitle(provider, account, person),
    consequence: LINKED_ACCOUNTS_WORDS.unlinkPersonConsequence(person),
  };
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
  const [unlinking, setUnlinking] = useState<IdentityMapping | null>(null);
  // Asked only once the admin-only list has answered, so a non-admin is not refused twice.
  const candidates = useIdentityCandidates(identities.isSuccess);

  const userItems = users.data?.items ?? [];
  const emailOf = (id: string): string | null =>
    userItems.find((user) => user.id === id)?.email ?? null;
  /** The person a confirmation names: their name and email, else whichever they have. */
  const personOf = (id: string): string | null => {
    const user = userItems.find((item) => item.id === id);
    return user === undefined
      ? null
      : user.name === null
        ? user.email
        : `${user.name} (${user.email})`;
  };
  const unlink = unlinking === null ? null : unlinkWords(unlinking, personOf);

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
    <section aria-label="Linked accounts">
      <SectionHeading>Linked accounts</SectionHeading>
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
          error={identities.error}
          detail={readErrorDetail(
            identities.error,
            'Reading and writing them needs the admin role, because a mapping decides who may act as whom.',
          )}
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
              <Button
                className="ml-auto"
                size="sm"
                onClick={() => {
                  commands.unlinkIdentity.reset();
                  setUnlinking(mapping);
                }}
              >
                {LINKED_ACCOUNTS_WORDS.unlink}
              </Button>
            </Card>
          </li>
        ))}
      </ul>

      {candidates.isSuccess && candidates.data.items.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1">
          <p className="text-xs font-semibold">{LINKED_ACCOUNTS_WORDS.candidatesTitle}</p>
          <p className="text-xs text-fg-muted">{LINKED_ACCOUNTS_WORDS.candidatesHint}</p>
          <ul className="flex flex-col gap-1" aria-label="Unmapped provider accounts">
            {candidates.data.items.map((candidate) => (
              <li key={`${candidate.provider}:${candidate.external_id}`}>
                <Card className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge>
                    <UntrustedText value={candidate.provider} />
                  </Badge>
                  <code className="font-mono text-xs">
                    <UntrustedText value={candidate.external_id} />
                  </code>
                  {candidate.display_name === undefined ||
                  candidate.display_name === null ? null : (
                    <span className="text-fg-muted">
                      <UntrustedText value={candidate.display_name} />
                    </span>
                  )}
                  <span className="text-xs text-fg-muted">{candidateFacts(candidate)}</span>
                  <Button
                    className="ml-auto"
                    onClick={() => {
                      setProvider(candidate.provider);
                      setExternalId(candidate.external_id);
                      if (candidate.display_name !== undefined && candidate.display_name !== null) {
                        setDisplayName(candidate.display_name);
                      }
                    }}
                  >
                    Use this account
                  </Button>
                </Card>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The form on the card ground (S-25.10b): a form is a box, the page is the canvas. */}
      {identities.isError ? null : (
        <form
          aria-label="Map a provider account"
          className="mt-3 flex flex-col gap-2 rounded-lg border border-line bg-default p-4"
          onSubmit={submit}
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Provider
              <Select
                aria-label="Provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              >
                {IDENTITY_PROVIDERS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </Select>
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
                <Select
                  aria-label="Platform user"
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                >
                  <option value="">Choose…</option>
                  {userItems.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.email}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
          </fieldset>
          <div>
            <Button type="submit" disabled={!canSubmit}>
              Save mapping
            </Button>
          </div>
          {commands.mapIdentity.error === null ? null : (
            <ErrorNotice title="The mapping was not saved." error={commands.mapIdentity.error} />
          )}
        </form>
      )}
      <ConfirmDialog
        open={unlinking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setUnlinking(null);
          }
        }}
        title={unlink?.title ?? LINKED_ACCOUNTS_WORDS.unlink}
        consequence={unlink?.consequence ?? ''}
        confirmLabel={LINKED_ACCOUNTS_WORDS.unlink}
        pending={commands.unlinkIdentity.isPending}
        error={commands.unlinkIdentity.error}
        errorTitle={LINKED_ACCOUNTS_WORDS.unlinkRefused}
        errorDetail={linkRefusal(commands.unlinkIdentity.error)}
        onConfirm={() => {
          if (unlinking === null) {
            return;
          }
          commands.unlinkIdentity.mutate(
            { provider: unlinking.provider, externalId: unlinking.external_id },
            {
              onSuccess: () => {
                setUnlinking(null);
              },
            },
          );
        }}
      />
    </section>
  );
};
