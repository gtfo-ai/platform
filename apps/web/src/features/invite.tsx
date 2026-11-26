/**
 * The invite page — `/invite#<token>` (TD-022's 2026-11-26 amendment). Public, like `/sign-in`,
 * because whoever holds the link has no account yet; drawn on the sign-in page's night ground.
 *
 * The token is read from `location.hash` — the link carries it in the **fragment**, so it never
 * reaches an access log, a proxy or a `Referer` — and is sent in POST bodies only:
 *
 * 1. `POST /api/invites/inspect` says what the link is for — the role, the expiry — or why it no
 *    longer works. Reading it never consumes it.
 * 2. The form takes an email, a name and a password twice, and checks the password against
 *    `PASSWORD_MIN_LENGTH`–`PASSWORD_MAX_LENGTH` before it sends, as *Settings → Password* does.
 * 3. `POST /api/invites/accept` makes the account; the page replaces its own history entry with
 *    `/invite` (the token leaves the browser's history), then signs in through Better Auth's own
 *    route and opens Home. If the account was made but the sign-in failed, the page says so and
 *    points to the sign-in page — it never offers to submit again, because the link is now used.
 *
 * Every way a link can fail to work — missing from the address, unknown, used, expired, withdrawn —
 * has its own plain sentence and the same next step: ask an administrator for a new link.
 *
 * Nothing read here is guarded: the page asks nothing that needs a session.
 */
import { inviteTokenSchema, type UserRole } from '@platform/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, type ReactElement, useState } from 'react';
import { ApiError, NetworkError } from '../api/http.js';
import { queryKeys } from '../api/keys.js';
import { useServices } from '../app/services.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/session.js';
import { ErrorNotice } from '../ui/kit.js';
import { Logo } from '../ui/logo.js';
import { formatDateTime } from '../ui/time.js';
import { DitherCanvas } from './dither-canvas.js';
import { FOCUS_RING, SignInField } from './sign-in.js';

/** The role, as the invite page says it. */
const ROLE_WORDS: Readonly<Record<UserRole, string>> = {
  admin: 'an administrator',
  maintainer: 'a maintainer',
  member: 'a member',
  viewer: 'a viewer',
};

const ASK = 'Ask an administrator for a new link.';

export const INVITE_PAGE_WORDS = {
  headline: 'You’re invited.',
  joinAs: (role: UserRole, expiresAt: string): string =>
    `This link lets you join as ${ROLE_WORDS[role]}. It works once, until ${formatDateTime(expiresAt)}.`,
  adminNote: 'As an administrator you will be able to change every setting and everyone’s role.',
  checking: 'Checking your invite link…',
  missing: `The address you opened has no invite in it — the link may have been cut short. ${ASK}`,
  notFound: `This invite link is not valid — it may have been copied incompletely. ${ASK}`,
  used: `This invite link has already been used — each link works only once. If that was you, sign in. ${ASK.slice(0, -1)} if you still need one.`,
  expired: (at: string): string => `This invite link expired on ${formatDateTime(at)}. ${ASK}`,
  revoked: `This invite link was withdrawn by an administrator. ${ASK}`,
  unreadable: 'Your invite link could not be checked just now. Reload the page to try again.',
  email: 'Email',
  name: 'Your name',
  password: 'Password',
  passwordHint: `At least ${PASSWORD_MIN_LENGTH} characters.`,
  confirm: 'Repeat the password',
  submit: 'Create my account',
  submitting: 'Creating your account…',
  tooShort: `The password needs at least ${PASSWORD_MIN_LENGTH} characters.`,
  tooLong: `The password can be at most ${PASSWORD_MAX_LENGTH} characters.`,
  mismatch: 'The two passwords are not the same.',
  emailTaken:
    'An account with that email already exists. Sign in with it instead, or use another email — this link still works.',
  invalid: 'Check the email, name and password, then try again.',
  unreachable: 'The server could not be reached, so your account was not confirmed. Try again.',
  failed: 'Your account could not be created. Try again in a moment.',
  createdNotSignedIn:
    'Your account was created, but signing you in did not work. Sign in with the email and password you just chose.',
  signIn: 'Go to sign in',
} as const;

/** Why the form cannot be sent yet, or `null`. Only shown once a field has a value. */
export const invitePasswordProblem = (password: string, confirm: string): string | null => {
  if (password.length > PASSWORD_MAX_LENGTH) return INVITE_PAGE_WORDS.tooLong;
  if (password.length > 0 && password.length < PASSWORD_MIN_LENGTH) {
    return INVITE_PAGE_WORDS.tooShort;
  }
  if (confirm.length > 0 && password !== confirm) return INVITE_PAGE_WORDS.mismatch;
  return null;
};

/** The ended link's sentence, by the code an accept was refused with. */
const endedByCode = (code: string): 'used' | 'expired' | 'revoked' | 'not_found' | null => {
  switch (code) {
    case 'invite_used':
      return 'used';
    case 'invite_expired':
      return 'expired';
    case 'invite_revoked':
      return 'revoked';
    case 'invite_not_found':
      return 'not_found';
    default:
      return null;
  }
};

/** The token from the address's fragment, or `null` when there is none worth asking about. */
export const inviteTokenFrom = (hash: string): string | null => {
  const token = hash.startsWith('#') ? hash.slice(1) : hash;
  return inviteTokenSchema.safeParse(token).success ? token : null;
};

const Page = ({ children }: { readonly children: ReactElement }): ReactElement => (
  <main className="relative isolate flex min-h-full flex-col bg-signin-night text-signin-text">
    <DitherCanvas />
    <div className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col px-5 py-6 sm:px-10 lg:px-16">
      <Logo label="Agentic platform" className="w-28 text-signin-text" />
      <div className="grid flex-1 content-start gap-6 pt-6 pb-8 lg:content-center lg:grid-cols-12 lg:items-center lg:gap-12 lg:py-16">
        <div className="relative z-10 lg:col-span-7" data-dither-quiet="">
          <h1 className="max-w-[12ch] text-[clamp(2.5rem,7.2vw,5rem)] leading-[1.0] font-black tracking-[-0.03em] text-balance text-signin-text">
            {INVITE_PAGE_WORDS.headline}
          </h1>
        </div>
        <div className="w-full max-w-md lg:col-span-5 lg:justify-self-end">
          <section
            aria-label="Join"
            data-dither-quiet=""
            className="rounded-lg bg-signin-ink p-6 sm:p-8"
          >
            {children}
          </section>
        </div>
      </div>
    </div>
  </main>
);

/** A sentence that ends the page — the link does not work, or the account needs a sign-in. */
const Ended = ({
  sentence,
  signIn = false,
}: {
  readonly sentence: string;
  readonly signIn?: boolean;
}): ReactElement => (
  <div className="flex flex-col gap-4">
    <p role="status" className="text-base leading-relaxed text-pretty text-signin-text">
      {sentence}
    </p>
    {signIn ? (
      <Link
        to="/sign-in"
        className={`w-fit rounded-md bg-signin-beacon px-4 py-2.5 text-base font-semibold text-signin-night ${FOCUS_RING}`}
      >
        {INVITE_PAGE_WORDS.signIn}
      </Link>
    ) : null}
  </div>
);

export const InviteScreen = (): ReactElement => {
  const [token] = useState<string | null>(() => inviteTokenFrom(globalThis.location?.hash ?? ''));
  return (
    <Page>
      {token === null ? <Ended sentence={INVITE_PAGE_WORDS.missing} /> : <Invite token={token} />}
    </Page>
  );
};

const Invite = ({ token }: { readonly token: string }): ReactElement => {
  const { auth } = useServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [created, setCreated] = useState(false);

  const inspect = useQuery({
    queryKey: [...queryKeys.inviteInspect],
    queryFn: () => auth.inspectInvite(token),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });

  const signIn = useMutation({
    mutationFn: () => auth.signIn({ email: email.trim(), password }),
    onSuccess: async () => {
      // As the sign-in page does: removed, not invalidated, so the guard fetches the new session.
      queryClient.removeQueries({ queryKey: [...queryKeys.session] });
      await navigate({ to: '/' });
    },
  });

  const accept = useMutation({
    mutationFn: () =>
      auth.acceptInvite({ token, email: email.trim(), name: name.trim(), password }),
    onSuccess: () => {
      // The link is spent: take its token out of this tab's history entry before anything else,
      // so Back or the history list never holds it.
      globalThis.history?.replaceState(null, '', '/invite');
      setCreated(true);
      signIn.mutate();
    },
  });

  if (inspect.isPending) {
    return <p className="text-sm text-signin-muted">{INVITE_PAGE_WORDS.checking}</p>;
  }
  if (inspect.isError) {
    const error = inspect.error;
    if (error instanceof ApiError && error.status === 404) {
      return <Ended sentence={INVITE_PAGE_WORDS.notFound} />;
    }
    return <Ended sentence={INVITE_PAGE_WORDS.unreadable} />;
  }
  const link = inspect.data;

  // The account exists: never offer the form again — the link is used.
  if (created) {
    if (signIn.isError) {
      return <Ended sentence={INVITE_PAGE_WORDS.createdNotSignedIn} signIn />;
    }
    return <p className="text-sm text-signin-muted">{INVITE_PAGE_WORDS.submitting}</p>;
  }

  const refused = accept.error instanceof ApiError ? endedByCode(accept.error.code) : null;
  const state = refused ?? (link.state === 'pending' ? null : link.state);
  if (state === 'used' || state === 'accepted') {
    return <Ended sentence={INVITE_PAGE_WORDS.used} signIn />;
  }
  if (state === 'expired') {
    return <Ended sentence={INVITE_PAGE_WORDS.expired(link.expires_at)} />;
  }
  if (state === 'revoked') {
    return <Ended sentence={INVITE_PAGE_WORDS.revoked} />;
  }
  if (state === 'not_found') {
    return <Ended sentence={INVITE_PAGE_WORDS.notFound} />;
  }

  const problem = invitePasswordProblem(password, confirm);
  const ready =
    problem === null &&
    email.trim() !== '' &&
    name.trim() !== '' &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password === confirm &&
    !accept.isPending;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!ready) return;
    accept.mutate();
  };

  const acceptMessage = (error: unknown): string => {
    if (error instanceof ApiError && error.code === 'email_taken') {
      return INVITE_PAGE_WORDS.emailTaken;
    }
    if (error instanceof ApiError && error.status === 400) return INVITE_PAGE_WORDS.invalid;
    if (error instanceof NetworkError) return INVITE_PAGE_WORDS.unreachable;
    return INVITE_PAGE_WORDS.failed;
  };

  return (
    <form aria-label={INVITE_PAGE_WORDS.submit} onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-pretty text-signin-muted">
        {INVITE_PAGE_WORDS.joinAs(link.role, link.expires_at)}
        {link.role === 'admin' ? ` ${INVITE_PAGE_WORDS.adminNote}` : null}
      </p>
      <SignInField
        label={INVITE_PAGE_WORDS.email}
        type="email"
        name="email"
        autoComplete="username"
        required
        maxLength={254}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <SignInField
        label={INVITE_PAGE_WORDS.name}
        type="text"
        name="name"
        autoComplete="name"
        required
        maxLength={128}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <SignInField
        label={INVITE_PAGE_WORDS.password}
        type="password"
        name="new-password"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <p className="-mt-3 text-xs text-signin-muted">{INVITE_PAGE_WORDS.passwordHint}</p>
      <SignInField
        label={INVITE_PAGE_WORDS.confirm}
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        required
        maxLength={PASSWORD_MAX_LENGTH}
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
      />
      {problem === null ? null : (
        <p role="status" className="text-sm text-signin-text">
          {problem}
        </p>
      )}
      {accept.isError ? (
        <ErrorNotice
          title={acceptMessage(accept.error)}
          error={
            accept.error instanceof ApiError && accept.error.code === 'email_taken'
              ? undefined
              : accept.error
          }
        />
      ) : null}
      <button
        type="submit"
        disabled={!ready}
        className={`mt-2 rounded-md bg-signin-beacon px-4 py-2.5 text-base font-semibold text-signin-night hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`}
      >
        {accept.isPending ? INVITE_PAGE_WORDS.submitting : INVITE_PAGE_WORDS.submit}
      </button>
    </form>
  );
};
