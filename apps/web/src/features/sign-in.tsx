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
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, type ReactElement, useState } from 'react';
import { ApiError, NetworkError } from '../api/http.js';
import { queryKeys } from '../api/keys.js';
import { useServices } from '../app/services.js';
import { safeRedirectPath } from '../routes/redirect.js';
import { Button, Card, ErrorNotice, Field } from '../ui/kit.js';

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
    <main className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Agentic platform</h1>
        <p className="text-sm text-fg-muted">Sign in to the control tower.</p>
      </div>
      <Card>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field
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
          <Field
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
          <Button type="submit" tone="primary" disabled={signIn.isPending}>
            {signIn.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
      <p className="text-xs text-fg-muted">
        Accounts are created by an administrator. A fresh instance takes its first administrator
        from <code>APP_BOOTSTRAP_ADMIN_EMAIL</code>.
      </p>
    </main>
  );
};
