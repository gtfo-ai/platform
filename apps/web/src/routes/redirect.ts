/**
 * Where to go after signing in.
 *
 * Only a **same-document path** is accepted: it must start with a single `/` and no more.
 * `//evil.example` is a protocol-relative URL that a browser resolves to another origin, and
 * `https://evil.example` is one outright — either would turn the sign-in page into an open
 * redirect, which is a phishing primitive on a self-hosted product whose login page an operator has
 * told their team to trust.
 *
 * It lives in its own module so `redirect.test.ts` can exercise it without importing the route
 * tree, which pulls in every screen.
 */
export const safeRedirectPath = (value: string | undefined): string => {
  if (value === undefined || !value.startsWith('/') || value.startsWith('//')) {
    return '/';
  }
  return value;
};
