/**
 * Replay mode for the Slack adapter's contract runs (technical/10 § contract tier).
 *
 * The reasoning is WP-09's, and it holds harder here: **nock replays a recording, and there is no
 * Slack workspace to record against.** Every fixture is transcribed from Slack's published
 * documentation, so the "recording" is a hand-built document either way — and once it is, a
 * fixture format that carries *provenance* beside each interaction is worth more than one that
 * cannot. A reader of `test/fixtures/http/slack/*.json` can tell a printed example from a body
 * assembled out of an error table; a `nock.define` array cannot say it.
 *
 * The adapter takes its `fetch` by injection, so replay needs no HTTP interception at all, and the
 * same seam is what lets a test assert that a shadow-mode call issued **zero** requests.
 *
 * ## Why the key is the path *and* a subset of the body
 *
 * Every Slack Web API method is a `POST` to `/<method>` with no path parameters and no query
 * string: `chat.postMessage` for a task thread and `chat.postMessage` for a digest are the same
 * URL. The *body* is what distinguishes them, so an interaction may carry a `match` object and is
 * served only when every one of its entries equals the corresponding value in the request body
 * (form-encoded or JSON, compared as strings, because a form has no types). The **most specific**
 * matching interaction wins, so a general fixture cannot shadow a precise one, and an unmatched
 * request is a loud failure naming what was available.
 *
 * What the transport gives a test beyond "it answered" is WP-09's list, kept because both halves
 * were earned in review:
 *  - **an unmatched request is a loud failure.** A harness that answered `{}` would make every
 *    assertion below it vacuous;
 *  - **an unexercised fixture is a loud failure.** `unusedFixtures()` reports every recorded
 *    interaction no request reached, and the runner asserts it is empty;
 *  - **a fixture a test fetched and never asserted on is a failure as well** —
 *    `unassertedFixtureServes()`, standing rule 24: a check that counts execution is not a check
 *    that counts assertion;
 *  - **a request log**, so a test can assert what was *sent*: that a shadow-mode call sent nothing,
 *    that a threaded post carried `thread_ts`, that the blocks on the wire are the ones built.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export interface SlackInteraction {
  readonly method: 'POST';
  /** Path below the API root: `/chat.postMessage`. */
  readonly path: string;
  /** Body members that must match for this interaction to answer. Absent = matches any body. */
  readonly match?: Readonly<Record<string, string | number | boolean>>;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /**
   * Where this shape comes from. See `test/fixtures/http/slack/SOURCES.md` for what each label
   * claims; the shared provenance suite enforces the block's shape.
   */
  readonly source: {
    readonly url: string;
    readonly retrieved: string;
    readonly kind: 'documented' | 'documented-adapted' | 'composed' | 'inferred' | 'invented';
    readonly note?: string;
  };
}

export interface SlackFixtureFile {
  readonly interactions: readonly SlackInteraction[];
}

export interface RecordedSlackRequest {
  readonly url: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The request body, decoded from JSON or from the form encoding. */
  readonly body: Readonly<Record<string, unknown>>;
}

export interface SlackReplay {
  /** Drop-in for `SlackProviderOptions.fetchImpl`. */
  readonly fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<Response>;
  readonly requests: readonly RecordedSlackRequest[];
  /** Adds responses a test needs that the corpus does not record — a 429, an outage. */
  script(interaction: SlackInteraction | readonly SlackInteraction[]): void;
  reset(): void;
}

const FIXTURE_DIR = new URL('../../../fixtures/http/slack/', import.meta.url);

/**
 * Every recorded fixture file, asked of the directory rather than carried in a list.
 *
 * A hand-maintained scope drifts (standing rule 7): a list that happens to name all five files
 * today is one `git add` away from a fixture nothing loads — and an unloaded fixture is invisible
 * to `unusedFixtures()`, so the drift would be silent and in the permissive direction.
 */
export const slackFixtureNames = (): readonly string[] => {
  const names = readdirSync(fileURLToPath(FIXTURE_DIR))
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort();
  if (names.length === 0) {
    // Rule 4: a harness that quietly loaded nothing would make every replay assertion vacuous.
    throw new Error(`slack replay: no fixtures found in ${fileURLToPath(FIXTURE_DIR)}`);
  }
  return names;
};

export const loadSlackFixture = (name: string): readonly SlackInteraction[] => {
  const url = new URL(`${name}.json`, FIXTURE_DIR);
  return (JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as SlackFixtureFile).interactions;
};

/** File-scoped: what was loaded, and what was actually served, across every replay built here. */
const loadedLabels = new Set<string>();
const servedLabels = new Set<string>();

export const unusedFixtures = (): readonly string[] =>
  [...loadedLabels].filter((label) => !servedLabels.has(label)).sort();

interface PendingServe {
  readonly label: string;
  readonly testName: string;
  readonly assertionsBefore: number;
}

const pendingServes: PendingServe[] = [];
const unasserted: string[] = [];

const describeServe = (serve: PendingServe): string => `${serve.label} in "${serve.testName}"`;

/**
 * Every serve that no assertion followed — the half `unusedFixtures()` cannot see (standing rule
 * 24). Reaching a fixture is execution, not verification: deleting every `expect` from a test
 * while keeping its calls leaves the fixtures served and the suite green.
 *
 * What it deliberately does not prove: that the assertion is *about* the response. `expect(1)
 * .toBe(1)` after a fetch satisfies it. This is a floor, not a proof.
 */
export const unassertedFixtureServes = (): readonly string[] =>
  [
    ...unasserted,
    ...pendingServes.map((serve) => `${describeServe(serve)} (assertion window never closed)`),
  ].sort();

const openAssertionWindow = (label: string): void => {
  const state = expect.getState();
  pendingServes.push({
    label,
    testName: state.currentTestName ?? '(no test was running)',
    assertionsBefore: state.assertionCalls ?? 0,
  });
};

/** Ends the current test's window. Call it from an `afterEach` in the file that owns the corpus. */
export const closeFixtureAssertionWindow = (): void => {
  const after = expect.getState().assertionCalls ?? 0;
  for (const serve of pendingServes) {
    if (after <= serve.assertionsBefore) {
      unasserted.push(describeServe(serve));
    }
  }
  pendingServes.length = 0;
};

/** `POST /chat.postMessage {channel=C1,text=hi}` — a label a human can find by eye. */
const describeMatch = (match: SlackInteraction['match']): string =>
  match === undefined
    ? '*'
    : Object.entries(match)
        .map(([key, value]) => `${key}=${String(value)}`)
        .sort()
        .join(',');

const decodeBody = (
  headers: Record<string, string>,
  body: string | undefined,
): Record<string, unknown> => {
  if (body === undefined || body === '') {
    return {};
  }
  const contentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
  if (contentType.includes('json')) {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(body).entries());
};

const matches = (
  match: SlackInteraction['match'],
  body: Readonly<Record<string, unknown>>,
): boolean =>
  match === undefined ||
  Object.entries(match).every(([key, value]) => {
    const actual = body[key];
    return actual !== undefined && String(actual) === String(value);
  });

interface Recorded {
  readonly interaction: SlackInteraction;
  readonly label: string;
  /** A response the test wrote itself, which is the test's business and not the corpus's. */
  readonly scripted: boolean;
}

export const createSlackReplay = (interactions: readonly SlackInteraction[]): SlackReplay => {
  const queues = new Map<string, Recorded[]>();
  const requests: RecordedSlackRequest[] = [];

  const keyOf = (interaction: SlackInteraction): string =>
    `${interaction.method} ${interaction.path} {${describeMatch(interaction.match)}}`;

  const add = (interaction: SlackInteraction, scripted: boolean): void => {
    const key = keyOf(interaction);
    const queue = queues.get(key) ?? [];
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
      const replaced = new Set<string>();
      for (const one of Array.isArray(interaction) ? interaction : [interaction]) {
        const key = keyOf(one as SlackInteraction);
        if (!replaced.has(key)) {
          queues.set(key, []);
          replaced.add(key);
        }
        add(one as SlackInteraction, true);
      }
    },
    reset: () => {
      requests.length = 0;
    },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname.replace(/^\/api/, '');
      const body = decodeBody(init.headers, init.body);
      requests.push({ url, path, headers: { ...init.headers }, body });

      // Most specific first: an interaction matching three body members beats one matching the
      // channel alone, so a general fixture can never shadow a precise one.
      const candidates = [...queues.entries()]
        .filter(([key, queue]) => key.startsWith(`${init.method} ${path} {`) && queue.length > 0)
        .map(([, queue]) => queue)
        .filter((queue) => matches((queue[0] as Recorded).interaction.match, body))
        .sort(
          (left, right) =>
            Object.keys((right[0] as Recorded).interaction.match ?? {}).length -
            Object.keys((left[0] as Recorded).interaction.match ?? {}).length,
        );
      const queue = candidates[0];
      if (queue === undefined) {
        // Loud, and it names the alternatives: a silent `{}` here would let every assertion below
        // it pass against a harness that never reached the adapter's code.
        throw new Error(
          `slack replay: no fixture for ${init.method} ${path} with body ${JSON.stringify(body).slice(0, 300)}\navailable:\n  ${[
            ...queues.keys(),
          ]
            .sort()
            .join('\n  ')}`,
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
      return new Response(chosen.body === undefined ? '' : JSON.stringify(chosen.body), {
        status: chosen.status,
        headers: { 'content-type': 'application/json', ...chosen.headers },
      });
    },
  };
};
