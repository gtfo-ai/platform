/**
 * What each verification target runs — the one list `scripts/verify.mjs` and
 * `.github/workflows/ci.yml` both derive from.
 *
 * This is a separate file because it has two readers. `verify.mjs` runs the steps; the CI workflow
 * runs the same steps as separate jobs, and `verify.test.ts` holds the two to each other.
 *
 * ## Why the groups exist (standing rule 7, one ring out)
 *
 * The steps of `verify` and the steps CI's lint job ran used to be two hand-written lists of the
 * same thing, and they had drifted: `ignored:check` was added to `verify` at WP-06 and to CI
 * **never**, so the guard that had already caught two live defects — `apps/server/src/data/`
 * swallowed by an unanchored `.gitignore` rule, and a walk that descended into another checkout —
 * gated nothing on a push. Nothing failed, because nothing compared the lists.
 *
 * So `verify` no longer has a list. It is exactly the concatenation of the groups below, and each
 * group is one CI job's one command. A step can therefore only be added to `verify` by adding it to
 * a group, which is by construction the thing CI runs: the two cannot disagree about a *step*
 * at all. The groups are the split CI already had — static checks, the compiler, the test run —
 * so this changes how the workflow names its steps, not what runs or in how many jobs.
 *
 * What derivation alone still cannot see is a **new group** that no job runs, and that residue is
 * what `verify.test.ts` closes: it reads this table and the workflow file, and fails when a group
 * or a target is not invoked by CI. That test is not a third list — it reads both of the two real
 * artefacts and compares them.
 */

/**
 * The steps of `verify`, grouped the way CI splits them into jobs. Order within `verify` is
 * cheapest-feedback-first: the static checks, then the compiler, then the suites.
 */
export const VERIFY_GROUPS: Readonly<Record<string, readonly string[]>> = {
  'verify:static': ['lint', 'schemas:check', 'ignored:check', 'nul:check'],
  'verify:types': ['typecheck'],
  // TD-013's bundle budget is an **acceptance criterion** of WP-20, not a nicety, so it is a step
  // of `verify` and therefore a CI job. It is a group of its own rather than a step of
  // `verify:static` because it is the one check here that builds something: it runs
  // `vite build` and measures the initial graph `dist/index.html` requests.
  'verify:bundle': ['bundle:check'],
  'verify:tests': ['test'],
};

/**
 * target -> the `package.json` scripts it runs, in order.
 *
 * `verify` deliberately has no steps of its own; see the note above. The remaining targets are the
 * tiers of docs/technical/10-testing-strategy.md that CI runs as whole targets already.
 */
export const TARGETS: Readonly<Record<string, readonly string[]>> = {
  verify: Object.values(VERIFY_GROUPS).flat(),
  ...VERIFY_GROUPS,
  'verify:integration': ['test:integration'],
  'verify:e2e': ['test:e2e'],
  'verify:ui': ['test:ui'],
  // Playwright against a Vite preview server and a fake API/SSE backend (WP-20's acceptance
  // criterion). Its own target rather than a step of `verify:ui`: it needs a browser binary, which
  // CI installs in that job and a developer installs once with `pnpm exec playwright install
  // chromium`. technical/10 lists it under the UI tier and names Playwright 1.63.
  'verify:web-e2e': ['test:web-e2e'],
};
