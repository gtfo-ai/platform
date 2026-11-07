/**
 * **Settings → Your accounts** — a person links their own Jira or GitLab account, proven by the
 * provider and confirmed by them (S-26.8a over S-26.6's routes; the M26 UX spec § 5; TD-031's
 * 2026-11-06 amendment item 9).
 *
 * ## Why it is shaped like this
 *
 * A linked account answers questions and approves plans from the tracker (BD-006, BD-022, Q10), so
 * the platform never takes the person's word for which account is theirs. There is **no field for an
 * account id and no email match** anywhere on this page: the account is the authenticated author of
 * a comment carrying the person's one-time code, as the provider names it, and even then it is only
 * a *match* until the person confirms that account here.
 *
 * 1. *Link an account* issues the code (`POST /api/me/identity-links`). It is answered **once** —
 *    the server keeps only its hash — so it lives in this component's state, and a reload shows that
 *    a code is live without it.
 * 2. The page then asks `GET /api/me/identity-links` every 3 s while the code is live
 *    (`useIdentityLinkState`), because no event announces a match.
 * 3. *I wrote it on …* names a ticket or merge request so the platform reads its comments now — a
 *    project with no webhook carries no comments otherwise (`POST /api/me/identity-links/read`).
 * 4. A match is shown as *Link Jira account <name>?*, with the provider and the account id beside the
 *    untrusted name, and only *Link this account* links it (`POST …/matches/:id/confirm`, with an
 *    `Idempotency-Key`). The answer names the tasks the link made the person's.
 *
 * A code that stopped says why (`void_reason`) and offers a new one; every refusal is said in words
 * from `LINK_REFUSAL_WORDS`. Every provider string — a display name, an account id, an integration's
 * name — is `UntrustedText`, and goes through `sanitiseUntrusted` where it lands in a dialog title.
 *
 * Lazy-loaded by `features/settings.tsx`, so none of it is in the initial bundle.
 */
import type {
  IdentityLinkCodeIssued,
  IdentityLinkConfirmed,
  IdentityLinkMatch,
  IdentityLinkState,
  MyIdentity,
} from '@platform/contracts';
import { type FormEvent, type ReactElement, useState } from 'react';
import { readErrorDetail } from '../api/read-error.js';
import {
  useIdentityLinkState,
  useMyIdentities,
  useProjects,
  useYourAccountsCommands,
} from '../app/queries.js';
import { ConfirmDialog } from '../ui/confirm-dialog.js';
import { CopyField } from '../ui/copy-field.js';
import { DetailsDisclosure } from '../ui/details.js';
import { Flash } from '../ui/flash.js';
import {
  accountProviderName,
  LINK_REFUSAL_WORDS,
  LINK_VOID_REASON_WORDS,
  type LinkVoidReason,
  linkRefusal,
  YOUR_ACCOUNTS_WORDS as WORDS,
} from '../ui/humanize-accounts.js';
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  formatDateTime,
  Loading,
} from '../ui/kit.js';
import { ListBox, ListRow } from '../ui/list-box.js';
import { Select } from '../ui/select.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { SettingsSectionHeader } from './settings-frame.js';

/** An `ErrorNotice` that says S-26.6's refusals in this page's words. */
const LinkRefusal = ({
  title,
  error,
}: {
  readonly title: string;
  readonly error: unknown;
}): ReactElement | null => {
  if (error === null || error === undefined) {
    return null;
  }
  const detail = linkRefusal(error);
  return <ErrorNotice title={title} error={error} {...(detail === undefined ? {} : { detail })} />;
};

/** The provider's display name, or its account id when it sent none — always as text. */
const accountName = (account: {
  readonly display_name: string | null;
  readonly external_id: string;
}): string => account.display_name ?? account.external_id;

// ── The linked list ──────────────────────────────────────────────────────────

const LinkedAccounts = (): ReactElement => {
  const identities = useMyIdentities();
  const commands = useYourAccountsCommands();
  const [unlinking, setUnlinking] = useState<MyIdentity | null>(null);
  const [unlinked, setUnlinked] = useState(false);
  const items = identities.data?.items ?? [];

  return (
    <>
      {identities.isPending ? <Loading label="Loading your accounts…" /> : null}
      {identities.isError ? (
        <ErrorNotice
          title="Your linked accounts could not be loaded."
          error={identities.error}
          detail={readErrorDetail(identities.error, 'Your role does not allow reading them.')}
        />
      ) : null}
      {unlinked ? (
        <Flash tone="success" live="status">
          {WORDS.unlinked}
        </Flash>
      ) : null}
      {identities.isSuccess && items.length === 0 ? (
        <EmptyState title={WORDS.noneTitle} hint={WORDS.noneHint} />
      ) : null}
      {items.length === 0 ? null : (
        <ListBox label={WORDS.listLabel}>
          {items.map((identity) => (
            <ListRow
              key={`${identity.provider}:${identity.external_id}`}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{accountProviderName(identity.provider)}</span>
                  <UntrustedText value={accountName(identity)} />
                </span>
              }
              meta={
                <span className="flex flex-wrap gap-x-2">
                  <span>
                    {`${WORDS.accountId} `}
                    <code className="font-mono">
                      <UntrustedText value={identity.external_id} />
                    </code>
                  </span>
                  <span>{WORDS.linkedOn(formatDateTime(identity.created_at))}</span>
                </span>
              }
              actions={
                <Button
                  size="sm"
                  onClick={() => {
                    commands.unlink.reset();
                    setUnlinked(false);
                    setUnlinking(identity);
                  }}
                >
                  {WORDS.unlink}
                </Button>
              }
            />
          ))}
        </ListBox>
      )}
      <ConfirmDialog
        open={unlinking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setUnlinking(null);
          }
        }}
        title={
          unlinking === null
            ? WORDS.unlink
            : WORDS.unlinkTitle(
                accountProviderName(unlinking.provider),
                sanitiseUntrusted(accountName(unlinking)),
              )
        }
        consequence={
          unlinking === null ? '' : WORDS.unlinkConsequence(accountProviderName(unlinking.provider))
        }
        confirmLabel={WORDS.unlink}
        pending={commands.unlink.isPending}
        error={commands.unlink.error}
        errorTitle={WORDS.unlinkRefused}
        errorDetail={linkRefusal(commands.unlink.error)}
        onConfirm={() => {
          if (unlinking === null) {
            return;
          }
          commands.unlink.mutate(
            { provider: unlinking.provider, externalId: unlinking.external_id },
            {
              onSuccess: () => {
                setUnlinking(null);
                setUnlinked(true);
              },
            },
          );
        }}
      />
    </>
  );
};

// ── *I wrote it on …* ─────────────────────────────────────────────────────────

type Where = 'ticket' | 'merge_request';

const WroteItOn = (): ReactElement => {
  const projects = useProjects();
  const commands = useYourAccountsCommands();
  const [projectId, setProjectId] = useState('');
  const [where, setWhere] = useState<Where>('ticket');
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const iid = /^!?\d+$/.test(trimmed) ? Number.parseInt(trimmed.replace('!', ''), 10) : Number.NaN;
  const valid =
    projectId !== '' &&
    (where === 'ticket' ? trimmed !== '' : Number.isSafeInteger(iid) && iid > 0);
  const outcome = commands.readThread.data;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid || commands.readThread.isPending) {
      return;
    }
    commands.readThread.mutate(
      where === 'ticket'
        ? { project_id: projectId, ticket_key: trimmed }
        : { project_id: projectId, merge_request_iid: iid },
    );
  };

  return (
    <DetailsDisclosure summary={WORDS.wroteItOn}>
      <form aria-label={WORDS.wroteItOn} className="flex flex-col gap-3" onSubmit={submit}>
        <p className="text-xs text-fg-muted">{WORDS.wroteItOnHint}</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            {WORDS.project}
            <Select
              aria-label={WORDS.project}
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
              }}
            >
              <option value="">{WORDS.choose}</option>
              {(projects.data?.items ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {sanitiseUntrusted(project.name)}
                </option>
              ))}
            </Select>
          </label>
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="pb-1 font-medium">{WORDS.where}</legend>
            <div className="flex gap-3">
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="link-thread-where"
                  checked={where === 'ticket'}
                  onChange={() => {
                    setWhere('ticket');
                  }}
                />
                {WORDS.aTicket}
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="link-thread-where"
                  checked={where === 'merge_request'}
                  onChange={() => {
                    setWhere('merge_request');
                  }}
                />
                {WORDS.aMergeRequest}
              </label>
            </div>
          </fieldset>
          <Field
            label={where === 'ticket' ? WORDS.ticketKey : WORDS.mergeRequestNumber}
            value={value}
            maxLength={255}
            {...(where === 'merge_request' ? { inputMode: 'numeric' as const } : {})}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </div>
        <div>
          <Button type="submit" disabled={!valid || commands.readThread.isPending}>
            {commands.readThread.isPending ? WORDS.reading : WORDS.read}
          </Button>
        </div>
        {outcome === undefined ? null : (
          <p role="status" className="text-sm">
            {WORDS.readOutcome(
              outcome.comments,
              outcome.carried_code,
              outcome.matched,
              outcome.state.matches.some((match) => match.confirmed_at === null),
            )}
          </p>
        )}
        <LinkRefusal title={WORDS.readRefused} error={commands.readThread.error} />
      </form>
    </DetailsDisclosure>
  );
};

// ── The link flow ────────────────────────────────────────────────────────────

/** *Link Jira account Jan Novák?* — the confirmation TD-031's item 9 (a) puts before the link. */
const ConfirmMatch = ({
  match,
  pending,
  onConfirm,
  onNotMine,
}: {
  readonly match: IdentityLinkMatch;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onNotMine: () => void;
}): ReactElement => {
  const provider = accountProviderName(match.provider);
  return (
    <div data-link-match={match.id} className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">
        {WORDS.confirmBefore(provider)}
        {match.display_name === null ? (
          <code className="font-mono">
            <UntrustedText value={match.external_id} />
          </code>
        ) : (
          <em>
            <UntrustedText value={match.display_name} />
          </em>
        )}
        {WORDS.confirmAfter}
      </h3>
      <dl className="grid w-fit grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-fg-muted">{WORDS.accountId}</dt>
        <dd className="font-mono">
          <UntrustedText value={match.external_id} />
        </dd>
        {match.integration_name === null ? null : (
          <>
            <dt className="text-fg-muted">{WORDS.via}</dt>
            <dd>
              <UntrustedText value={match.integration_name} />
            </dd>
          </>
        )}
      </dl>
      <p className="text-xs text-fg-muted">{WORDS.checkTheId}</p>
      <div className="flex flex-wrap gap-2">
        <Button tone="primary" disabled={pending} onClick={onConfirm}>
          {pending ? WORDS.confirming : WORDS.confirm}
        </Button>
        <Button disabled={pending} onClick={onNotMine}>
          {WORDS.notMine}
        </Button>
      </div>
    </div>
  );
};

/** What the page says after a link: who, what follows, the adopted tasks, and the comment. */
const Linked = ({
  linked,
  onAnother,
}: {
  readonly linked: IdentityLinkConfirmed;
  readonly onAnother: () => void;
}): ReactElement => {
  const provider = accountProviderName(linked.provider);
  return (
    <div className="flex flex-col gap-3">
      <Flash
        tone="success"
        live="status"
        title={
          <>
            {WORDS.linkedBefore(provider)}
            <UntrustedText value={accountName(linked)} />
            {WORDS.linkedAfter}
          </>
        }
      >
        <p>{WORDS.whatFollows(provider)}</p>
        {linked.adopted_task_ids.length === 0 ? null : (
          <p>{WORDS.adopted(linked.adopted_task_ids.length, provider)}</p>
        )}
        <p>{WORDS.deleteComment}</p>
      </Flash>
      <div>
        <Button onClick={onAnother}>{WORDS.linkAnother}</Button>
      </div>
    </div>
  );
};

/** The code's state as this page draws it. */
type View =
  | { readonly kind: 'idle' }
  | { readonly kind: 'linked'; readonly linked: IdentityLinkConfirmed }
  | {
      readonly kind: 'live';
      readonly issued: IdentityLinkCodeIssued | null;
      readonly createdAt: string | null;
      readonly expiresAt: string;
      readonly matches: readonly IdentityLinkMatch[];
    }
  | { readonly kind: 'expired'; readonly expiresAt: string }
  | { readonly kind: 'voided'; readonly reason: LinkVoidReason | null };

export const viewOf = (
  state: IdentityLinkState | undefined,
  issued: IdentityLinkCodeIssued | null,
  linked: IdentityLinkConfirmed | null,
): View => {
  if (linked !== null) {
    return { kind: 'linked', linked };
  }
  const code = state?.code ?? null;
  // A code issued here whose state the read has not caught up with yet is live.
  if (issued !== null && (code === null || code.id !== issued.id)) {
    return { kind: 'live', issued, createdAt: null, expiresAt: issued.expires_at, matches: [] };
  }
  if (code === null || code.status === 'consumed') {
    return { kind: 'idle' };
  }
  if (code.status === 'expired') {
    return { kind: 'expired', expiresAt: code.expires_at };
  }
  if (code.status === 'voided') {
    return { kind: 'voided', reason: code.void_reason };
  }
  return {
    kind: 'live',
    issued: issued !== null && issued.id === code.id ? issued : null,
    createdAt: code.created_at,
    expiresAt: code.expires_at,
    matches: (state?.matches ?? []).filter((match) => match.confirmed_at === null),
  };
};

const LinkFlow = (): ReactElement => {
  const state = useIdentityLinkState();
  const [issued, setIssued] = useState<IdentityLinkCodeIssued | null>(null);
  const [linked, setLinked] = useState<IdentityLinkConfirmed | null>(null);
  // Set in the hook's own `onSuccess`, before its re-read of the state lands (review of PR #99).
  const commands = useYourAccountsCommands({
    onIssued: (code) => {
      setIssued(code);
      setLinked(null);
    },
    onConfirmed: (result) => {
      setLinked(result);
      setIssued(null);
    },
  });
  const view = viewOf(state.data, issued, linked);

  const issue = (): void => {
    commands.confirm.reset();
    commands.issue.mutate();
  };
  /** The page's one amber primary is this button, unless a match is waiting for its *Link*. */
  const issueButton = (label: string, primary = true): ReactElement => (
    <Button
      tone={primary ? 'primary' : 'default'}
      disabled={commands.issue.isPending}
      onClick={issue}
    >
      {commands.issue.isPending ? WORDS.issuing : label}
    </Button>
  );

  return (
    <Card className="flex flex-col gap-4 text-sm" header={WORDS.flowTitle}>
      <p className="text-fg-muted">{WORDS.why}</p>
      {state.isError ? (
        <LinkRefusal title="Your link code could not be read." error={state.error} />
      ) : null}

      {view.kind === 'idle' ? <div>{issueButton(WORDS.start)}</div> : null}

      {view.kind === 'linked' ? (
        <Linked
          linked={view.linked}
          onAnother={() => {
            setLinked(null);
            setIssued(null);
            commands.confirm.reset();
          }}
        />
      ) : null}

      {view.kind === 'expired' ? (
        <div className="flex flex-col gap-2">
          <p role="status">{WORDS.expired(formatDateTime(view.expiresAt))}</p>
          <div>{issueButton(WORDS.newCode)}</div>
        </div>
      ) : null}

      {view.kind === 'voided' ? (
        <div className="flex flex-col gap-2">
          <Flash tone="warning" live="status">
            {view.reason === null
              ? LINK_REFUSAL_WORDS.link_code_voided
              : LINK_VOID_REASON_WORDS[view.reason]}
          </Flash>
          <div>{issueButton(WORDS.newCode)}</div>
        </div>
      ) : null}

      {view.kind === 'live' ? (
        <div className="flex flex-col gap-3">
          {view.issued === null ? (
            <p>
              {WORDS.liveWithoutCode(
                formatDateTime(view.createdAt ?? view.expiresAt),
                formatDateTime(view.expiresAt),
              )}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              <CopyField label={WORDS.codeLabel} value={view.issued.code} />
              <p className="text-xs text-fg-muted">
                {WORDS.validUntil(formatDateTime(view.expiresAt))}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <p className="font-medium">{WORDS.instruction}</p>
            <p className="text-fg-muted">{WORDS.instructionGitlab}</p>
            <p className="text-fg-muted">{WORDS.dontEdit}</p>
          </div>
          {view.matches.length === 0 ? (
            <p role="status" className="text-fg-muted">
              {WORDS.waiting}
            </p>
          ) : (
            view.matches.map((match) => (
              <ConfirmMatch
                key={match.id}
                match={match}
                pending={commands.confirm.isPending}
                onConfirm={() => {
                  commands.confirm.mutate(match.id);
                }}
                onNotMine={issue}
              />
            ))
          )}
          <LinkRefusal title={WORDS.confirmRefused} error={commands.confirm.error} />
          {view.issued === null ? (
            <div>{issueButton(WORDS.newCode, view.matches.length === 0)}</div>
          ) : null}
          <WroteItOn />
        </div>
      ) : null}

      <LinkRefusal title={WORDS.issueRefused} error={commands.issue.error} />
    </Card>
  );
};

/** The section: the person's linked accounts, then the way to link one. */
export const YourAccounts = (): ReactElement => (
  <>
    <SettingsSectionHeader title={WORDS.title} description={WORDS.description} />
    <LinkedAccounts />
    <LinkFlow />
  </>
);
