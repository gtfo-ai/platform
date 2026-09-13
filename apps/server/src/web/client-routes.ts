/**
 * The paths that belong to the browser application, as an **allow-list** (WP-15j, backlog 33).
 *
 * The fallback that hands `index.html` to a deep link has to answer one question — *is this request
 * the client's?* — and the shape of the answer is the whole security property. A deny-list ("serve
 * the shell unless the path starts with `/api`, `/events`, `/webhooks`, …") is a claim about every
 * route the server will ever register, and it is wrong the first time somebody adds one without
 * reading this file: their unmatched paths quietly start returning HTML, and
 * `routes/client-census.test.ts` — which classifies "not served" by the not-found handler's own
 * body — stops being able to see a missing endpoint at all. That is rule 55 one ring out, and it is
 * why the list below names what the **client** owns instead.
 *
 * ## It is derived, not remembered
 *
 * `client-routes.test.ts` reads `apps/web/src/routes/tree.tsx` off disk and fails when the two
 * disagree in either direction, so a screen added to the SPA without a line here is a red test
 * rather than a deep link that 404s in production (rule 7: ask the source, do not carry a list).
 * The server cannot import the route tree — `apps/server` may not reach into `apps/web`, and the
 * bundle it serves has no route manifest in it — so the list is stated here and held to that file.
 *
 * Only the **first** segment is compared: `/projects/$key/tasks/$taskId` and every future screen
 * under `/projects` are the same decision, and a client-side route that exists only in the browser
 * (a tab, a modal path) must not need a server deployment. What the first segment buys is that a
 * request whose first segment is something else — `api`, `events`, `webhooks`, a scanner's
 * `wp-login.php` — can never be answered with the shell.
 */

/**
 * The first path segment of every route in the SPA's tree, `/` excepted (it has none).
 *
 * Sorted, because the test compares sets and a sorted literal is a readable diff.
 */
export const CLIENT_ROUTE_SEGMENTS: readonly string[] = [
  'agents',
  'audit',
  'inbox',
  'integrations',
  'onboarding',
  'projects',
  'runs',
  'settings',
  'sign-in',
  'stats',
  'tasks',
];

const SEGMENTS = new Set(CLIENT_ROUTE_SEGMENTS);

/**
 * Whether the decoded segments of a request path name a screen of the browser application.
 *
 * Empty segments are `/` — the dashboard — which is the one path with no first segment to compare.
 */
export const isClientRoute = (segments: readonly string[]): boolean => {
  const first = segments[0];
  return first === undefined || SEGMENTS.has(first);
};
