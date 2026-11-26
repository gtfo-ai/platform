/**
 * *Password* — the signed-in person changes their own password, under Settings → Personal.
 *
 * The server half is Better Auth's own `POST /api/auth/change-password` (TD-022), already mounted by
 * `apps/server/src/auth/plugin.ts`: it verifies the current password with the platform's Argon2id
 * verifier and stores the new one's hash. Nothing of the platform's own API is added.
 *
 * **What the form decides before it sends** — the length bounds, the confirmation and *new is not the
 * current one* — because Better Auth answers every refusal with a bare `400 { code, message }`,
 * which the client reads as `unexpected_response` (`api/http.ts`), so a short password and a wrong
 * current password are indistinguishable on the wire. With the lengths checked here, a `400` names
 * the current password; anything else keeps the server's words behind *Technical details*.
 *
 * **Sign out other sessions** is on by default: a password is usually changed because it may have
 * leaked, and a session opened with the old one should not outlive it. Better Auth then deletes every
 * session of the user and gives this browser a fresh cookie, so the session query is re-read.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactElement, useState } from 'react';
import { ApiError, NetworkError } from '../api/http.js';
import { queryKeys } from '../api/keys.js';
import { useSession } from '../app/queries.js';
import { useServices } from '../app/services.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/session.js';
import { Flash } from '../ui/flash.js';
import { Button, Card, ErrorNotice, Field } from '../ui/kit.js';
import { SettingsSectionHeader } from './settings-frame.js';

export const CHANGE_PASSWORD_WORDS = {
  title: 'Password',
  description: 'Change the password you sign in with.',
  current: 'Current password',
  next: 'New password',
  nextHint: `At least ${PASSWORD_MIN_LENGTH} characters.`,
  confirm: 'Repeat the new password',
  revokeOthers: 'Sign out my other sessions',
  revokeOthersHint: 'Every other browser signed in as you is signed out. This one stays signed in.',
  save: 'Change password',
  saving: 'Changing…',
  changed: 'Your password was changed.',
  changedAndRevoked: 'Your password was changed, and your other sessions were signed out.',
  tooShort: `The new password needs at least ${PASSWORD_MIN_LENGTH} characters.`,
  mismatch: 'The two new passwords are not the same.',
  unchanged: 'The new password is the same as the current one.',
  wrongCurrent: 'Your current password was not accepted. Nothing was changed.',
  tooMany: 'Too many attempts in a row. Nothing was changed; wait a minute and try again.',
  signedOut: 'Your session has ended. Sign in again, then change the password.',
  unreachable: 'The server could not be reached, so the change was not confirmed.',
  // Not "was not changed": Better Auth stores the new hash before it revokes the other sessions,
  // so a failure after that point leaves the new password in place.
  failed:
    'The change was not confirmed. Try signing in with the new password to see whether it took.',
} as const;

/** Why the form cannot be sent yet, or `null` when it can. Only shown once a field has a value. */
export const passwordProblem = (current: string, next: string, confirm: string): string | null => {
  if (next.length > 0 && next.length < PASSWORD_MIN_LENGTH) return CHANGE_PASSWORD_WORDS.tooShort;
  if (confirm.length > 0 && next !== confirm) return CHANGE_PASSWORD_WORDS.mismatch;
  if (next.length > 0 && current.length > 0 && next === current) {
    return CHANGE_PASSWORD_WORDS.unchanged;
  }
  return null;
};

/** The refusal, in this page's words. */
export const changePasswordMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.status === 400) return CHANGE_PASSWORD_WORDS.wrongCurrent;
  if (error instanceof ApiError && error.status === 401) return CHANGE_PASSWORD_WORDS.signedOut;
  // Better Auth's rate limit (3 per 10 s on this path in production) answers before the handler.
  if (error instanceof ApiError && error.status === 429) return CHANGE_PASSWORD_WORDS.tooMany;
  if (error instanceof NetworkError) return CHANGE_PASSWORD_WORDS.unreachable;
  return CHANGE_PASSWORD_WORDS.failed;
};

const explained = (error: unknown): boolean =>
  (error instanceof ApiError &&
    (error.status === 400 || error.status === 401 || error.status === 429)) ||
  error instanceof NetworkError;

export const ChangePassword = (): ReactElement => {
  const { auth } = useServices();
  const queryClient = useQueryClient();
  const email = useSession().data?.user.email ?? '';
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [done, setDone] = useState<'changed' | 'revoked' | null>(null);

  const change = useMutation({
    mutationFn: () =>
      auth.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: revokeOthers,
      }),
    onSuccess: async () => {
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(revokeOthers ? 'revoked' : 'changed');
      // Revoking replaces this browser's session too (a new id behind a new cookie).
      await queryClient.invalidateQueries({ queryKey: [...queryKeys.session] });
    },
  });

  const problem = passwordProblem(current, next, confirm);
  const ready =
    problem === null &&
    current.length > 0 &&
    next.length >= PASSWORD_MIN_LENGTH &&
    next === confirm &&
    !change.isPending;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!ready) return;
    setDone(null);
    change.mutate();
  };

  return (
    <>
      <SettingsSectionHeader
        title={CHANGE_PASSWORD_WORDS.title}
        description={CHANGE_PASSWORD_WORDS.description}
      />
      <Card>
        <form
          aria-label={CHANGE_PASSWORD_WORDS.save}
          onSubmit={submit}
          className="flex max-w-sm flex-col gap-4"
        >
          {/* For password managers: which account this password belongs to. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={email}
            hidden
            readOnly
          />
          <Field
            label={CHANGE_PASSWORD_WORDS.current}
            type="password"
            name="current-password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(event) => {
              setCurrent(event.target.value);
            }}
          />
          <Field
            label={CHANGE_PASSWORD_WORDS.next}
            hint={CHANGE_PASSWORD_WORDS.nextHint}
            type="password"
            name="new-password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            value={next}
            onChange={(event) => {
              setNext(event.target.value);
            }}
          />
          <Field
            label={CHANGE_PASSWORD_WORDS.confirm}
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            required
            maxLength={PASSWORD_MAX_LENGTH}
            value={confirm}
            onChange={(event) => {
              setConfirm(event.target.value);
            }}
          />
          <label className="flex w-fit items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={revokeOthers}
              onChange={(event) => {
                setRevokeOthers(event.target.checked);
              }}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              {CHANGE_PASSWORD_WORDS.revokeOthers}
              <span className="text-xs text-fg-muted">
                {CHANGE_PASSWORD_WORDS.revokeOthersHint}
              </span>
            </span>
          </label>
          {problem === null ? null : (
            <p role="status" className="text-sm text-danger">
              {problem}
            </p>
          )}
          {change.isError ? (
            <ErrorNotice
              title={changePasswordMessage(change.error)}
              error={explained(change.error) ? undefined : change.error}
            />
          ) : null}
          {done === null ? null : (
            <Flash tone="success" live="status">
              {done === 'revoked'
                ? CHANGE_PASSWORD_WORDS.changedAndRevoked
                : CHANGE_PASSWORD_WORDS.changed}
            </Flash>
          )}
          <div>
            <Button tone="primary" type="submit" disabled={!ready}>
              {change.isPending ? CHANGE_PASSWORD_WORDS.saving : CHANGE_PASSWORD_WORDS.save}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
};
