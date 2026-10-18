/**
 * **Every provider HTTP client bounds its response body in bytes** — WP-190, PROGRESS backlog 548
 * (technical/10 unit tier).
 *
 * ## Why this file exists
 *
 * Until WP-190 all five clients read `response.text()` whole before parsing, so every byte cap an
 * adapter applies cut text that was already in the process's memory. `bounded-body.ts` is the one
 * reader; this file holds each client to it twice:
 *
 *  - **by behaviour**: each client, built as its adapter builds it, is handed a body of exactly
 *    its ceiling (read whole — the padding comes back) and one byte more (refused with
 *    `ProviderResponseTooLargeError`, naming the ceiling and the host). The ceilings are written
 *    here as their derivations rather than imported, so raising a client's constant by one byte
 *    fails its refusal case;
 *  - **by source**: no file under `providers/` but the reader calls `.text()`, `.json()`,
 *    `.arrayBuffer()`, `.blob()`, `.formData()`, `.bytes()` or `.getReader()`, the tail reader is
 *    called from the GitLab transport only, and `keepTail: true` is set by the job trace only.
 *
 * ## The scope is the disk, in both directions
 *
 * `PROVIDER_DIRECTORIES` and the scanned sources are read off this directory (standing rule 7), as
 * `redirect-refusal.test.ts` reads them: a sixth provider fails the equality below the moment its
 * directory exists, and its sources are scanned without anyone listing them.
 *
 * ## The one bounded reader outside it
 *
 * `packages/infrastructure/src/dependencies/registry-metadata.ts` keeps its own streaming reader
 * (`MAX_REGISTRY_BYTES`, 2 MiB), and that is decided rather than missed (WP-190 ruling (d)): the
 * dependency rule forbids `infrastructure` from importing `@platform/integrations`, and the
 * registry call has no binding and no provider id for `ProviderResponseTooLargeError` to name — its
 * refusal is its own module's `unavailable`. The last case below holds that the exception is still
 * a bounded reader, so the sentence stays checkable.
 *
 * ## What it cannot prove
 *
 * A body read some way the source scan does not spell. Named, because each is a real spelling it
 * misses (WP-190 review round 1): a computed member (`response['text']()`), destructuring
 * (`const { text } = response`, or `{ body }` and a read of that), async iteration
 * (`for await (const chunk of response.body)`), and piping (`response.body.pipeTo(…)`,
 * `Readable.fromWeb(response.body)`) — and a `Response` handed to another library that reads it.
 * The scan matches comments too, which is the conservative direction.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { noSecretsRedactor } from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { ProviderResponseTooLargeError } from './bounded-body.js';
import { gitlabConfigSchema } from './gitlab/config.js';
import { createGitLabHttp, JOB_LOG_TAIL_BYTES, MAX_JOB_LOG_TAIL_BYTES } from './gitlab/http.js';
import { createGitLabProvider } from './gitlab/provider.js';
import { createJiraClient } from './jira-cloud/client.js';
import { createLokiHttp } from './loki/http.js';
import { createSentryHttp } from './sentry/http.js';
import { createSlackHttp } from './slack/http.js';

const MiB = 1024 * 1024;
const clock = fixedClock('2026-06-01T10:30:00.000Z');
const PROVIDERS_DIR = fileURLToPath(new URL('.', import.meta.url));

/** The provider directories, asked of the filesystem rather than listed here (rule 7). */
const PROVIDER_DIRECTORIES: readonly string[] = readdirSync(PROVIDERS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

type FetchDouble = (url: unknown, init?: unknown) => Promise<Response>;

const PAD = new Uint8Array(MiB).fill(0x61); // 'a'
const encoder = new TextEncoder();

/**
 * `{"ok":true,"pad":"aaa…"}` of exactly `totalBytes`, streamed in 1 MiB chunks of one reused
 * buffer, so a 64 MiB body costs the test no 64 MiB allocation of its own.
 */
const paddedJson = (
  totalBytes: number,
  init: ResponseInit = { status: 200 },
): { readonly fetch: FetchDouble; readonly pad: number } => {
  const prefix = encoder.encode('{"ok":true,"pad":"');
  const suffix = encoder.encode('"}');
  const pad = totalBytes - prefix.byteLength - suffix.byteLength;
  const fetch: FetchDouble = async () => {
    let state: 'prefix' | 'pad' | 'suffix' | 'done' = 'prefix';
    let left = pad;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state === 'prefix') {
          controller.enqueue(prefix);
          state = 'pad';
        } else if (state === 'pad') {
          const size = Math.min(left, PAD.byteLength);
          controller.enqueue(PAD.subarray(0, size));
          left -= size;
          if (left === 0) {
            state = 'suffix';
          }
        } else if (state === 'suffix') {
          controller.enqueue(suffix);
          state = 'done';
        } else {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    });
  };
  return { fetch, pad };
};

interface CeilingCase {
  /** The ceiling, as its derivation — never imported from the client (see the docblock). */
  readonly ceiling: number;
  readonly host: string;
  /** One request through the client, built the way its adapter builds it; answers the `pad`. */
  readonly attempt: (fetch: FetchDouble) => Promise<unknown>;
}

const padOf = (value: unknown): unknown => {
  const record = value as { pad?: unknown; body?: { pad?: unknown } };
  return record.pad ?? record.body?.pad;
};

const CASES: Readonly<Record<string, CeilingCase>> = {
  gitlab: {
    ceiling: 4 * 4 * MiB, // four times `max_codeowners_bytes`' schema maximum
    host: 'gitlab.example.test',
    attempt: async (fetch) =>
      createGitLabHttp({
        baseUrl: 'https://gitlab.example.test',
        token: 'FAKE-gitlab-token-DO-NOT-USE',
        fetchImpl: fetch,
        timeoutMs: 0,
        maxPages: 1,
        redactor: noSecretsRedactor(),
      }).request({ method: 'GET', path: '/projects/acme%2Fapi', action: 'get_project' }),
  },
  'jira-cloud': {
    ceiling: 4 * 4 * MiB, // no byte cap of its own: the GitLab and Sentry figure
    host: 'acme-example.atlassian.net',
    attempt: async (fetch) =>
      createJiraClient({
        siteUrl: 'https://acme-example.atlassian.net',
        email: 'agentic-bot@example.test',
        apiToken: 'FAKE-jira-api-token-DO-NOT-USE',
        fetch: fetch as typeof globalThis.fetch,
        now: () => Date.parse('2026-06-01T10:30:00.000Z'),
        redactor: noSecretsRedactor(),
      }).send({ method: 'GET', path: 'issue/ACME-1', action: 'read_ticket' }),
  },
  loki: {
    ceiling: 4 * 16 * MiB, // four times `max_total_bytes`' schema maximum
    host: 'loki.example.test',
    attempt: async (fetch) =>
      createLokiHttp({
        baseUrl: 'https://loki.example.test',
        auth: {
          mode: 'bearer',
          bearerToken: 'FAKE-loki-bearer-token-DO-NOT-USE',
          username: null,
          password: null,
          tenantId: null,
        },
        fetchImpl: fetch,
        timeoutMs: 0,
        clock,
        redactor: noSecretsRedactor(),
      }).request({ path: '/loki/api/v1/labels', action: 'query_logs' }),
  },
  sentry: {
    ceiling: 4 * 4 * MiB, // four times `max_stack_trace_bytes`' schema maximum
    host: 'sentry.example.test',
    attempt: async (fetch) =>
      createSentryHttp({
        baseUrl: 'https://sentry.example.test',
        token: 'FAKE-sentry-auth-token-DO-NOT-USE',
        fetchImpl: fetch,
        timeoutMs: 0,
        clock,
        redactor: noSecretsRedactor(),
      }).request({ method: 'GET', path: '/api/0/organizations/acme-example/', action: 'probe' }),
  },
  slack: {
    ceiling: 4 * 4 * MiB, // four times `max_delivery_bytes`' schema maximum
    host: 'slack.example.test',
    attempt: async (fetch) =>
      createSlackHttp({
        baseUrl: 'https://slack.example.test/api',
        token: 'xoxb-FAKE-bot-token-DO-NOT-USE',
        fetchImpl: fetch,
        timeoutMs: 0,
        redactor: noSecretsRedactor(),
      }).call({ method: 'auth.test', action: 'test_connection', body: {}, encoding: 'form' }),
  },
};

// A 64 MiB body is parsed whole once; a 2-core runner needs more than the default 5 s.
const LARGE_BODY_TIMEOUT_MS = 60_000;

describe('provider HTTP clients bound a response body in bytes (backlog 548)', () => {
  it('has a case for every provider directory, and no case for one that is gone', () => {
    expect(Object.keys(CASES).sort()).toEqual(PROVIDER_DIRECTORIES);
  });

  it.each(Object.keys(CASES).sort())(
    '%s reads a body of exactly its ceiling whole',
    async (provider) => {
      const subject = CASES[provider] as CeilingCase;
      const body = paddedJson(subject.ceiling);
      const answered = await subject.attempt(body.fetch);
      expect((padOf(answered) as string).length).toBe(body.pad);
    },
    LARGE_BODY_TIMEOUT_MS,
  );

  it.each(Object.keys(CASES).sort())(
    '%s refuses one byte past its ceiling, naming the ceiling and the host',
    async (provider) => {
      const subject = CASES[provider] as CeilingCase;
      const outcome = await subject.attempt(paddedJson(subject.ceiling + 1).fetch).then(
        () => null,
        (error: unknown) => error,
      );
      expect(outcome, 'the client must refuse rather than cut').toBeInstanceOf(
        ProviderResponseTooLargeError,
      );
      const error = outcome as ProviderResponseTooLargeError;
      expect(error.code).toBe('invalid_response');
      expect(error.ceilingBytes).toBe(subject.ceiling);
      expect(error.host).toBe(subject.host);
      expect(error.message).toContain(
        `from ${subject.host} answered more than ${subject.ceiling} bytes`,
      );
    },
    LARGE_BODY_TIMEOUT_MS,
  );
});

/** What a client threw, reduced to what the executor's retry and backoff read. */
const classification = async (subject: CeilingCase, fetch: FetchDouble): Promise<unknown> => {
  const error = (await subject.attempt(fetch).then(
    () => null,
    (thrown: unknown) => thrown,
  )) as { name?: string; code?: string; retryable?: boolean; retryAfterMs?: number | null } | null;
  return {
    name: error?.name,
    code: error?.code,
    retryable: error?.retryable,
    retryAfterMs: error?.retryAfterMs,
  };
};

describe('an error body past the ceiling keeps its status classification (WP-190 review round 1)', () => {
  const ERRORS: readonly [string, ResponseInit][] = [
    ['503', { status: 503 }],
    ['429 with Retry-After', { status: 429, headers: { 'retry-after': '7' } }],
  ];
  const rows = Object.keys(CASES)
    .sort()
    .flatMap((provider) => ERRORS.map(([label, init]) => [provider, label, init] as const));

  it.each(rows)(
    '%s: a %s past the ceiling is classified as the same status with a small body',
    async (provider, _label, init) => {
      const subject = CASES[provider] as CeilingCase;
      const small = await classification(subject, paddedJson(64, init).fetch);
      const large = await classification(subject, paddedJson(subject.ceiling + 1, init).fetch);
      expect(small).not.toMatchObject({ name: 'ProviderResponseTooLargeError' });
      expect((small as { name?: string }).name, 'the small body raised').toBeDefined();
      expect(large).toEqual(small);
    },
    LARGE_BODY_TIMEOUT_MS,
  );
});

describe('the GitLab job trace keeps a stated tail instead (WP-190 ruling (a))', () => {
  /** `x` up to the transport's cut, `y` after it: a tail off by one byte in either direction shows. */
  const traceFetch =
    (totalBytes: number, tailBytes: number): FetchDouble =>
    async () => {
      const head = totalBytes - tailBytes;
      const chunks = [
        ...Array.from({ length: Math.ceil(head / MiB) }, (_, index) =>
          new Uint8Array(Math.min(MiB, head - index * MiB)).fill(0x78),
        ),
        ...Array.from({ length: Math.ceil(tailBytes / MiB) }, (_, index) =>
          new Uint8Array(Math.min(MiB, tailBytes - index * MiB)).fill(0x79),
        ),
      ];
      return new Response(new Blob(chunks).stream(), { status: 200 });
    };
  const TOTAL = 4 * 4 * MiB + 1; // past the client's ceiling, so a refusal would show

  it('the transport keeps exactly the last 4 MiB of a trace past the ceiling', async () => {
    expect(JOB_LOG_TAIL_BYTES).toBe(4 * MiB);
    const http = createGitLabHttp({
      baseUrl: 'https://gitlab.example.test',
      token: 'FAKE-gitlab-token-DO-NOT-USE',
      fetchImpl: traceFetch(TOTAL, 4 * MiB),
      timeoutMs: 0,
      maxPages: 1,
      redactor: noSecretsRedactor(),
    });
    const response = await http.requestText({
      method: 'GET',
      path: '/projects/acme%2Fapi/jobs/9002/trace',
      action: 'get_job_log',
      keepTail: true,
    });
    const body = response?.body ?? '';
    expect(body.length).toBe(4 * MiB);
    expect(/^y+$/.test(body), 'the kept bytes are exactly the trace’s last 4 MiB').toBe(true);
  });

  it('getJobLog answers its 1 MiB tail of the same trace', async () => {
    expect(MAX_JOB_LOG_TAIL_BYTES).toBe(MiB);
    const port = createGitLabProvider({
      integrationId: '00000000-0000-4000-8000-0000000000a9',
      config: gitlabConfigSchema.parse({
        base_url: 'https://gitlab.example.test',
        project: 'acme/api',
        request_timeout_ms: 0,
      }),
      secrets: { token: 'FAKE-binding-api-token-DO-NOT-USE' },
      fetchImpl: traceFetch(TOTAL, MiB),
      clock,
      redactor: noSecretsRedactor(),
    });
    const log = await port.getJobLog('acme/api', '9002');
    expect(log.length).toBe(MiB);
    expect(/^y+$/.test(log)).toBe(true);
  });
});

describe('no provider source reads a body except through bounded-body.ts', () => {
  const SOURCES: readonly string[] = (
    readdirSync(PROVIDERS_DIR, { recursive: true, encoding: 'utf8' }) as string[]
  )
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
    .filter((path) => path !== 'bounded-body.ts')
    .sort();
  const read = (path: string): string => readFileSync(`${PROVIDERS_DIR}${path}`, 'utf8');
  const DIRECT_READ = /\.\s*(?:text|json|arrayBuffer|blob|formData|bytes|getReader)\s*\(/;

  it('scans every provider directory', () => {
    const scanned = new Set(SOURCES.map((path) => path.split(/[\\/]/)[0]));
    for (const directory of PROVIDER_DIRECTORIES) {
      expect(scanned.has(directory), directory).toBe(true);
    }
  });

  it('no source calls a body reader of its own', () => {
    const offenders = SOURCES.flatMap((path) =>
      read(path)
        .split('\n')
        .flatMap((line, index) =>
          DIRECT_READ.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [],
        ),
    );
    expect(offenders).toEqual([]);
  });

  it('only the GitLab transport keeps a tail, and only the job trace asks it to', () => {
    const callers = (pattern: RegExp): string[] =>
      SOURCES.filter((path) => pattern.test(read(path)));
    expect(callers(/\breadBodyTail\b/)).toEqual(['gitlab/http.ts']);
    expect(callers(/\bkeepTail: true\b/)).toEqual(['gitlab/client.ts']);
    expect(read('gitlab/client.ts').match(/\bkeepTail: true\b/g)).toHaveLength(1);
  });

  it('the registry reader, the one exception, is still a bounded reader', () => {
    const registry = readFileSync(
      fileURLToPath(
        new URL('../../../infrastructure/src/dependencies/registry-metadata.ts', import.meta.url),
      ),
      'utf8',
    );
    expect(registry).toMatch(/size > MAX_REGISTRY_BYTES/);
    expect(registry).toMatch(/JSON\.parse\(await readBounded\(response\)\)/);
  });
});
