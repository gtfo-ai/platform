/**
 * Replay mode for the GitLab adapter's contract runs (technical/10 § contract tier).
 *
 * technical/10 names nock for this tier. This work package does not use it, and the reason is
 * specific rather than a preference: **nock replays a recording, and there is no GitLab instance
 * to record against.** Every fixture here is transcribed from GitLab's published documentation, so
 * the "recording" is a hand-built document either way — and once it is, a fixture format that can
 * carry *provenance* beside each interaction is worth more than one that cannot. A reader of
 * `test/fixtures/http/gitlab/*.json` can tell a documented shape from an inferred one; a
 * `nock.define` array cannot say it.
 *
 * The second reason is the dependency rule this file is not allowed to break: the adapter takes
 * its `fetch` by injection (`GitLabProviderOptions.fetchImpl`), so replay needs no HTTP
 * interception at all, and the same seam is what a WP-15 test will use to drive a scripted
 * failure. `docs/technical/10-testing-strategy.md` is amended to say so.
 *
 * What the transport gives a test beyond "it answered":
 *  - **an unmatched request is a loud failure**, naming the key it looked for and the keys it has.
 *    A replay harness that answered `{}` to an unknown request would make every assertion below it
 *    vacuous;
 *  - **an unexercised fixture is a loud failure too.** `unusedFixtures()` reports every recorded
 *    interaction that no request in this test file reached, and `gitlab.contract.test.ts` asserts
 *    it is empty. Round 1 shipped this as a per-instance `unused()` that nothing ever called: an
 *    unenforced check is worse than none, because it reads like coverage (standing rule 17). It
 *    counts *interactions*, not keys, so the second answer in a two-element queue — the `404` of a
 *    revocation, say — cannot hide behind the first;
 *  - **a fixture a test fetched and never asserted on is a failure as well.** Reaching a fixture is
 *    execution, not verification: `unassertedFixtureServes()` requires an assertion inside the same
 *    test, *after* the serve. Read its docblock for the line it deliberately does not cross;
 *  - **sequenced responses** for one key, which is how the asynchronous `merge_status` case is
 *    exercised: the same `GET …/merge_requests/13` answers `unchecked` and then `mergeable`,
 *    exactly as GitLab's "poll this API endpoint to get the updated status" describes;
 *  - **a request log**, so a test can assert what was *sent* — that a mutating call in shadow mode
 *    sent nothing at all, that the draft flag became a `Draft:` title, that `resolved=true` was
 *    the body of the resolve.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export interface ReplayInteraction {
  readonly method: string;
  /** Path below `/api/v4`, with the query string as the adapter will build it. */
  readonly path: string;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Raw body for the text endpoints (a job trace, a raw file). Wins over `body`. */
  readonly text?: string;
  /**
   * Where this shape comes from. `documented` means a published example or attribute table;
   * `inferred` means the documentation does not state it and the fixture is a reasoned guess,
   * which is a different kind of evidence and is never allowed to masquerade as the first.
   */
  readonly source: {
    readonly url: string;
    readonly retrieved: string;
    readonly kind: 'documented' | 'inferred';
    readonly note?: string;
  };
}

export interface ReplayFixtureFile {
  readonly interactions: readonly ReplayInteraction[];
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly key: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface GitLabReplay {
  /** Drop-in for `GitLabProviderOptions.fetchImpl`. */
  readonly fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<Response>;
  readonly requests: readonly RecordedRequest[];
  /** Adds or replaces the responses for one key, for a test that needs a specific answer. */
  script(interaction: ReplayInteraction | readonly ReplayInteraction[]): void;
  reset(): void;
}

/**
 * Every recorded interaction loaded in this test file that no request has reached, as
 * `GET /projects/… #0` labels. Aggregated across every replay the file builds, because a suite
 * spreads its fixtures over many contexts and no single context uses them all.
 *
 * Vitest isolates a module per test file, so this is per-file state and says nothing about
 * fixtures another file exercises — which is why the assertion lives in the file that runs the
 * whole contract suite.
 */
export const unusedFixtures = (): readonly string[] =>
  [...loadedLabels].filter((label) => !servedLabels.has(label)).sort();

/**
 * Every serve that no assertion followed — the half `unusedFixtures()` cannot see.
 *
 * **A check that counts execution is not a check that counts assertion** (WP-09 review round 2).
 * `unusedFixtures()` proves a recorded interaction was *reached*: it dies when a fixture is
 * unreferenced and when a test is `.skip`ped, and it survives the mutation that matters — deleting
 * every `expect` from a test while keeping the two calls that fetch its fixtures passed 32 of 32.
 * A served fixture looks exercised whether or not anything was checked.
 *
 * This narrows it to a window: **every serve must be followed, inside the same test, by at least
 * one further `expect(...)`**. Vitest's per-test `assertionCalls` is read when the fixture is
 * served and again when the test ends (`closeFixtureAssertionWindow`, called from an `afterEach`),
 * and a serve that did not move the counter is reported here.
 *
 * What it deliberately does **not** prove, stated rather than left to be discovered: that the
 * assertion is *about* the response. `expect(1).toBe(1)` after a fetch would satisfy it. Tying an
 * assertion to the bytes that fed it needs taint tracking through the adapter — a far heavier
 * instrument than the corpus is worth — so this is a floor, not a proof, and the residual is the
 * documented limitation. What it does close is the mutation above, and its neighbours: an
 * assertion deleted from the *end* of a test leaves that test's last serve unasserted too.
 *
 * Fail-closed: a serve whose window nobody ever closed counts as unasserted.
 */
export const unassertedFixtureServes = (): readonly string[] =>
  [
    ...unasserted,
    ...pendingServes.map((serve) => `${describeServe(serve)} (assertion window never closed)`),
  ].sort();

interface PendingServe {
  readonly label: string;
  readonly testName: string;
  readonly assertionsBefore: number;
}

const pendingServes: PendingServe[] = [];
const unasserted: string[] = [];

const describeServe = (serve: PendingServe): string => `${serve.label} in "${serve.testName}"`;

const openAssertionWindow = (label: string): void => {
  const state = expect.getState();
  pendingServes.push({
    label,
    testName: state.currentTestName ?? '(no test was running)',
    assertionsBefore: state.assertionCalls ?? 0,
  });
};

/**
 * Ends the current test's window. Call it from an `afterEach` in the file that owns the corpus;
 * vitest resets `assertionCalls` per test, so the comparison is only meaningful here.
 */
export const closeFixtureAssertionWindow = (): void => {
  const after = expect.getState().assertionCalls ?? 0;
  for (const serve of pendingServes) {
    if (after <= serve.assertionsBefore) {
      unasserted.push(describeServe(serve));
    }
  }
  pendingServes.length = 0;
};

const BASE = '/api/v4';

/** `GET /projects/acme%2Fapi/merge_requests?order_by=updated_at&state=merged`, query sorted. */
export const replayKey = (method: string, pathWithQuery: string): string => {
  const [path, query = ''] = pathWithQuery.split('?');
  const params = new URLSearchParams(query);
  const sorted = [...params.entries()].sort(([left], [right]) => left.localeCompare(right));
  const rendered = sorted.map(([name, value]) => `${name}=${value}`).join('&');
  return `${method.toUpperCase()} ${path}${rendered === '' ? '' : `?${rendered}`}`;
};

const keyOfUrl = (method: string, url: string): string => {
  const parsed = new URL(url);
  const path = parsed.pathname.startsWith(BASE)
    ? parsed.pathname.slice(BASE.length)
    : parsed.pathname;
  return replayKey(method, `${path}${parsed.search}`);
};

const FIXTURE_DIR = new URL('../../../fixtures/http/gitlab/', import.meta.url);

/**
 * Every recorded fixture file, asked of the directory rather than carried in a list.
 *
 * A hand-maintained scope drifts (standing rule 7): a list that happens to name all seven files
 * today is one `git add` away from a fixture nothing loads — and an unloaded fixture is invisible
 * to `unusedFixtures()`, so the drift would be silent and in the permissive direction. Discovering
 * them means a new file is loaded the moment it exists, and must then be exercised or deleted.
 */
export const replayFixtureNames = (): readonly string[] => {
  const names = readdirSync(fileURLToPath(FIXTURE_DIR))
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort();
  if (names.length === 0) {
    // Rule 4: a harness that quietly loaded nothing would make every replay assertion vacuous.
    throw new Error(`gitlab replay: no fixtures found in ${fileURLToPath(FIXTURE_DIR)}`);
  }
  return names;
};

export const loadReplayFixture = (name: string): readonly ReplayInteraction[] => {
  const url = new URL(`${name}.json`, FIXTURE_DIR);
  const parsed = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as ReplayFixtureFile;
  return parsed.interactions;
};

/** File-scoped: what was loaded, and what was actually served, across every replay built here. */
const loadedLabels = new Set<string>();
const servedLabels = new Set<string>();

interface Recorded {
  readonly interaction: ReplayInteraction;
  readonly label: string;
  /** A response the test wrote itself, which is the test's business and not the corpus's. */
  readonly scripted: boolean;
}

export const createGitLabReplay = (interactions: readonly ReplayInteraction[]): GitLabReplay => {
  const queues = new Map<string, Recorded[]>();
  const requests: RecordedRequest[] = [];

  const add = (interaction: ReplayInteraction, scripted: boolean): void => {
    const key = replayKey(interaction.method, interaction.path);
    const queue = queues.get(key) ?? [];
    // The label identifies the interaction, not the key, so the second entry of a queue is
    // reported on its own. A scripted response is the test's, so it is never held to the check.
    const label = `${scripted ? 'scripted ' : ''}${key} #${queue.length}`;
    queue.push({ interaction, label, scripted });
    queues.set(key, queue);
    if (!scripted) {
      loadedLabels.add(label);
    }
  };
  for (const interaction of interactions) {
    add(interaction, false);
  }

  return {
    requests,
    script: (interaction) => {
      // The whole array replaces the key's queue, so a two-element script is a *sequence* (a 429
      // then a 201) rather than the second entry overwriting the first.
      const replaced = new Set<string>();
      for (const one of Array.isArray(interaction) ? interaction : [interaction]) {
        const key = replayKey(one.method, one.path);
        if (!replaced.has(key)) {
          queues.set(key, []);
          replaced.add(key);
        }
        add(one, true);
      }
    },
    reset: () => {
      requests.length = 0;
    },
    fetchImpl: async (url, init) => {
      const key = keyOfUrl(init.method, url);
      requests.push({
        method: init.method,
        url,
        key,
        headers: { ...init.headers },
        body: init.body ?? null,
      });
      const queue = queues.get(key);
      if (queue === undefined || queue.length === 0) {
        // Loud, and it names the alternatives: a silent `{}` here would let every assertion below
        // it pass against a harness that never reached the adapter's code.
        throw new Error(
          `gitlab replay: no fixture for ${key}\navailable:\n  ${[...queues.keys()].sort().join('\n  ')}`,
        );
      }
      // The last interaction repeats: a read the suite makes twice needs one fixture, while a
      // sequence of two states needs two.
      const recorded = (queue.length === 1 ? queue[0] : queue.shift()) as Recorded;
      servedLabels.add(recorded.label);
      if (!recorded.scripted) {
        openAssertionWindow(recorded.label);
      }
      const chosen = recorded.interaction;
      const headers: Record<string, string> = { ...chosen.headers };
      const body =
        chosen.text !== undefined
          ? chosen.text
          : chosen.body === undefined
            ? ''
            : JSON.stringify(chosen.body);
      if (chosen.text === undefined && chosen.body !== undefined) {
        headers['content-type'] ??= 'application/json';
      }
      return new Response(chosen.status === 204 ? null : body, {
        status: chosen.status,
        headers,
      });
    },
  };
};
