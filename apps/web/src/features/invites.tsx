/**
 * *Invite people* — one-time invite links, under Settings → People → Users (TD-022's 2026-11-26
 * amendment). An administrator's only: the server holds all three routes to `org.users.manage`, and
 * the card is not drawn for anybody else (`features/settings.tsx`).
 *
 * The form chooses the **role** the account gets (member by default; choosing Administrator says
 * what that means) and how long the link is **valid** (24 hours by default, 30 days at most). The
 * answer's link is shown **once**, in a `CopyField`, with who it lets in and until when — the server
 * stores only the token's SHA-256, so nothing can show it again. Below it, every link with its state;
 * a pending one has **Revoke** behind a confirmation.
 *
 * No `href` is written here: the link is a field's value (text), never an anchor (`no-html.test.ts`).
 */
import type { InviteSummary, UserRole } from '@platform/contracts';
import { type FormEvent, type ReactElement, useState } from 'react';
import { readErrorDetail } from '../api/read-error.js';
import { useOrgInvites, useOrgUsers, useSettingsCommands } from '../app/queries.js';
import { ConfirmDialog } from '../ui/confirm-dialog.js';
import { CopyField } from '../ui/copy-field.js';
import { USER_ROLE_LABEL } from '../ui/humanize.js';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  formatDateTime,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { Select } from '../ui/select.js';
import { UntrustedText } from '../ui/untrusted.js';

/** The validity choices, in hours: 1 hour to 30 days (the server's 1–720). */
export const INVITE_VALIDITY_CHOICES = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 336, label: '14 days' },
  { hours: 720, label: '30 days' },
] as const;

const ROLES: readonly UserRole[] = ['viewer', 'member', 'maintainer', 'admin'];

export const INVITE_WORDS = {
  title: 'Invite people',
  intro:
    'Make a one-time link and send it however you like. Whoever opens it chooses their own email, name and password, and joins with the role you pick here.',
  roleField: 'Role',
  validFor: 'Valid for',
  adminWarning:
    'Whoever opens this link becomes an administrator: they can change every setting, every integration and every person’s role.',
  create: 'Create invite link',
  creating: 'Creating…',
  link: 'Invite link',
  shownOnce: (role: UserRole, expiresAt: string): string =>
    `Shown once — copy it now. Anyone with this link can join as ${USER_ROLE_LABEL[role]} until ${formatDateTime(expiresAt)}, once.`,
  createFailed: 'The invite link was not made.',
  listTitle: 'Invite links',
  empty: 'No invite links yet',
  emptyHint: 'A link appears here once you make one, with whether it was used.',
  revoke: 'Revoke',
  revokeTitle: 'Revoke this invite link?',
  revokeConsequence: (role: UserRole): string =>
    `Nobody can join with it any more, as ${USER_ROLE_LABEL[role]} or otherwise. A person who already joined through a link keeps their account.`,
  revokeFailed: 'The link was not revoked.',
} as const;

export const INVITE_STATE_LABEL: Readonly<Record<InviteSummary['state'], string>> = {
  pending: 'Waiting',
  accepted: 'Used',
  expired: 'Expired',
  revoked: 'Revoked',
};

const STATE_TONE: Readonly<Record<InviteSummary['state'], BadgeTone>> = {
  pending: 'accent',
  accepted: 'success',
  expired: 'neutral',
  revoked: 'neutral',
};

export const InviteLinks = (): ReactElement => {
  const invites = useOrgInvites(true);
  const users = useOrgUsers();
  const commands = useSettingsCommands();
  const [role, setRole] = useState<UserRole>('member');
  const [hours, setHours] = useState<number>(24);
  const [revoking, setRevoking] = useState<InviteSummary | null>(null);

  const userItems = users.data?.items ?? [];
  const personOf = (id: string): string => {
    const user = userItems.find((item) => item.id === id);
    return user === undefined ? 'a person no longer listed' : (user.name ?? user.email);
  };

  const created = commands.createInvite.data;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (commands.createInvite.isPending) return;
    commands.createInvite.mutate({ role, valid_for_hours: hours });
  };

  const items = invites.data?.items ?? [];

  return (
    <section aria-label={INVITE_WORDS.title} className="mb-6">
      <SectionHeading>{INVITE_WORDS.title}</SectionHeading>
      <Card className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">{INVITE_WORDS.intro}</p>
        <form aria-label={INVITE_WORDS.create} className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              {INVITE_WORDS.roleField}
              <Select
                aria-label={INVITE_WORDS.roleField}
                value={role}
                onChange={(event) => setRole(event.target.value as UserRole)}
              >
                {ROLES.map((id) => (
                  <option key={id} value={id}>
                    {USER_ROLE_LABEL[id]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              {INVITE_WORDS.validFor}
              <Select
                aria-label={INVITE_WORDS.validFor}
                value={String(hours)}
                onChange={(event) => setHours(Number(event.target.value))}
              >
                {INVITE_VALIDITY_CHOICES.map((choice) => (
                  <option key={choice.hours} value={String(choice.hours)}>
                    {choice.label}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          {role === 'admin' ? (
            <p role="note" className="text-sm text-attention">
              {INVITE_WORDS.adminWarning}
            </p>
          ) : null}
          <div>
            <Button tone="primary" type="submit" disabled={commands.createInvite.isPending}>
              {commands.createInvite.isPending ? INVITE_WORDS.creating : INVITE_WORDS.create}
            </Button>
          </div>
          {commands.createInvite.isError ? (
            <ErrorNotice title={INVITE_WORDS.createFailed} error={commands.createInvite.error} />
          ) : null}
        </form>
        {created === undefined ? null : (
          <div className="flex flex-col gap-1">
            <CopyField label={INVITE_WORDS.link} value={created.url} />
            <p className="text-xs text-fg-muted">
              {INVITE_WORDS.shownOnce(created.invite.role, created.invite.expires_at)}
            </p>
          </div>
        )}
      </Card>

      <div className="mt-4 flex flex-col gap-1">
        <p className="text-sm font-semibold">{INVITE_WORDS.listTitle}</p>
        {invites.isPending ? <Loading label="Loading invite links…" /> : null}
        {invites.isError ? (
          <ErrorNotice
            title="The invite links could not be loaded."
            error={invites.error}
            detail={readErrorDetail(invites.error, 'Invite links need the admin role.')}
          />
        ) : null}
        {invites.isSuccess && items.length === 0 ? (
          <EmptyState title={INVITE_WORDS.empty} hint={INVITE_WORDS.emptyHint} />
        ) : null}
        <ul className="flex flex-col gap-1" aria-label={INVITE_WORDS.listTitle}>
          {items.map((invite) => (
            <li key={invite.id}>
              <Card className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={STATE_TONE[invite.state]}>{INVITE_STATE_LABEL[invite.state]}</Badge>
                <span>{USER_ROLE_LABEL[invite.role]}</span>
                <span className="text-xs text-fg-muted">
                  {`Made ${formatDateTime(invite.created_at)} · `}
                  {invite.state === 'accepted' ? (
                    <>
                      {'Joined: '}
                      <UntrustedText
                        value={
                          invite.accepted_user_id === null
                            ? 'no account was made'
                            : personOf(invite.accepted_user_id)
                        }
                      />
                    </>
                  ) : invite.state === 'revoked' ? (
                    `Revoked ${invite.revoked_at === null ? '' : formatDateTime(invite.revoked_at)}`
                  ) : (
                    `${invite.state === 'expired' ? 'Expired' : 'Expires'} ${formatDateTime(invite.expires_at)}`
                  )}
                </span>
                {invite.state === 'pending' ? (
                  <Button
                    className="ml-auto"
                    size="sm"
                    onClick={() => {
                      commands.revokeInvite.reset();
                      setRevoking(invite);
                    }}
                  >
                    {INVITE_WORDS.revoke}
                  </Button>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      </div>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={INVITE_WORDS.revokeTitle}
        consequence={revoking === null ? '' : INVITE_WORDS.revokeConsequence(revoking.role)}
        confirmLabel={INVITE_WORDS.revoke}
        pending={commands.revokeInvite.isPending}
        error={commands.revokeInvite.error}
        errorTitle={INVITE_WORDS.revokeFailed}
        onConfirm={() => {
          if (revoking === null) return;
          commands.revokeInvite.mutate(revoking.id, {
            onSuccess: () => {
              setRevoking(null);
            },
          });
        }}
      />
    </section>
  );
};
