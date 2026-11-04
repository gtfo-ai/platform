/**
 * Sign-in (TD-022: email + password, opaque DB sessions).
 *
 * The form posts to Better Auth's own route and then refetches the session; it never stores a
 * token, because there is none to store — the session is an HTTP-only `__Host-` cookie the
 * JavaScript cannot read, which is what makes it survive an XSS that this app's own rules are
 * meant to prevent in the first place.
 *
 * There is no "register" link: `APP_ALLOW_SIGNUP` is false by default and the first administrator
 * comes from the environment (Q39). An instance with signup enabled is an operator's decision, and
 * the sign-up page is follow-up rather than a screen that 403s by default.
 *
 * ## The page (WP-291, technical/09 § "The sign-in page")
 *
 * The instance's front door, always dark whatever the selected theme: a headline on the left over
 * an animated ordered-dither field (`dither-canvas.tsx`), the form on a solid ink block on the
 * right, one column on a narrow screen. The bootstrap hint — *which* account to use — is shown only
 * while `GET /api/setup-state` says nobody has signed in yet; a failed read shows **nothing**,
 * because a hint is not worth an error on the one page everybody sees. It is a quiet line inside the
 * ink block below the button, so it never sits on the field; the trade, stated: the block is
 * vertically centred, so the hint's arrival (one fast read) nudges the block up by half its height.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  type FormEvent,
  type InputHTMLAttributes,
  type ReactElement,
  useId,
  useState,
} from 'react';
import { ApiError, NetworkError } from '../api/http.js';
import { queryKeys } from '../api/keys.js';
import { useServices } from '../app/services.js';
import { safeRedirectPath } from '../routes/redirect.js';
import { ErrorNotice } from '../ui/kit.js';
import { DitherCanvas } from './dither-canvas.js';

/** What a user is told. Server messages are shown; anything else gets a message we wrote. */
export const signInMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.status === 401 || error.status === 403
      ? 'Those credentials were not accepted.'
      : error.message;
  }
  if (error instanceof NetworkError) {
    return 'The server could not be reached.';
  }
  return 'Sign-in failed.';
};

export const SIGN_IN_HEADLINE = 'Tickets in, merge requests out.';

/** The amber ring every focusable thing on this page gets. */
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signin-beacon';

const SignInField = ({
  label,
  ...rest
}: { readonly label: string } & InputHTMLAttributes<HTMLInputElement>): ReactElement => {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-signin-text">
        {label}
      </label>
      <input
        id={id}
        className={`rounded-md border border-signin-edge bg-signin-night px-3 py-2 text-base text-signin-text placeholder:text-signin-muted ${FOCUS_RING}`}
        {...rest}
      />
    </div>
  );
};

/** Shown only on a definite `true`: pending, failed and `false` all render nothing. */
const BootstrapHint = (): ReactElement | null => {
  const { auth } = useServices();
  const state = useQuery({
    queryKey: [...queryKeys.setupState],
    queryFn: () => auth.setupState(),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (state.data?.first_sign_in_pending !== true) {
    return null;
  }
  return (
    <p className="mt-6 text-sm leading-relaxed text-pretty text-signin-muted">
      Nobody has signed in here yet. Use the administrator account set by{' '}
      <code className="font-mono text-[0.8125rem] [overflow-wrap:anywhere] text-signin-text">
        APP_BOOTSTRAP_ADMIN_EMAIL
      </code>
      .
    </p>
  );
};

export const SignInScreen = (): ReactElement => {
  const { auth } = useServices();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: '/sign-in' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: () => auth.signIn({ email, password }),
    onSuccess: async () => {
      // **Removed, not invalidated.** The route guard resolves the session with
      // `ensureQueryData`, which returns cached data when there is any and only *refetches in the
      // background* when it is stale — so an invalidated `null` is still a `null`, and the guard
      // would bounce the freshly signed-in user straight back to this page. Removing the entry
      // leaves the guard nothing to return and forces the fetch.
      queryClient.removeQueries({ queryKey: [...queryKeys.session] });
      // `safeRedirectPath` refuses anything that is not a same-document path, so the deep link a
      // user was refused cannot be turned into an open redirect by whoever sent them the URL.
      await navigate({ href: safeRedirectPath(search.redirect) });
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    signIn.mutate();
  };

  return (
    // `data-theme="dark"` so the kit's error notice is drawn in its dark tokens on this page.
    <main
      data-theme="dark"
      className="relative isolate flex min-h-full flex-col bg-signin-night text-signin-text"
    >
      <DitherCanvas />
      <div className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col px-5 py-6 sm:px-10 lg:px-16">
        <p className="text-sm font-semibold tracking-tight text-signin-text">Agentic platform</p>
        <div className="grid flex-1 content-center gap-10 py-12 lg:grid-cols-12 lg:items-center lg:gap-12 lg:py-16">
          <div className="lg:col-span-7" data-dither-quiet="">
            <h1 className="max-w-[12ch] text-[clamp(2.5rem,7.2vw,5rem)] leading-[1.0] font-black tracking-[-0.03em] text-balance text-signin-text">
              {SIGN_IN_HEADLINE}
            </h1>
            <p className="mt-6 max-w-[34ch] text-base leading-relaxed text-pretty text-signin-muted sm:text-lg">
              Sign in to see what your agents are working on — and what needs you.
            </p>
          </div>
          <div className="w-full max-w-md lg:col-span-5 lg:justify-self-end">
            <section
              aria-label="Sign in"
              data-dither-quiet=""
              className="rounded-lg bg-signin-ink p-6 sm:p-8"
            >
              <form onSubmit={submit} className="flex flex-col gap-4">
                <SignInField
                  label="Email"
                  type="email"
                  name="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                />
                <SignInField
                  label="Password"
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                  }}
                />
                {signIn.isError ? <ErrorNotice title={signInMessage(signIn.error)} /> : null}
                <button
                  type="submit"
                  disabled={signIn.isPending}
                  className={`mt-2 rounded-md bg-signin-beacon px-4 py-2.5 text-base font-semibold text-signin-night hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`}
                >
                  {signIn.isPending ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
              <BootstrapHint />
            </section>
          </div>
        </div>
      </div>
    </main>
  );
};
