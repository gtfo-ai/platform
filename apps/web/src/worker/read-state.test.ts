/**
 * The local page's boundary check (`read-state.ts`) held to the zod schemas the worker serialises
 * with (WP-292): the same keys **in both directions**, the same verdict over the same fixtures, the
 * same API prefix — so a field added to one side and not the other fails here. And the token's
 * journey: out of the fragment, into `sessionStorage`, off the address bar.
 */
import {
  WORKER_LOCAL_API_PREFIX,
  workerLocalCancelResponseSchema,
  workerLocalRunSchema,
  workerLocalStateSchema,
} from '@platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createLocalClient, LocalCallError, takeToken } from './client.js';
import {
  CANCEL_KEYS,
  LOCAL_API_PREFIX,
  RUN_KEYS,
  readCancel,
  readState,
  STATE_KEYS,
} from './read-state.js';

const RUN = {
  run_id: '00000000-0000-4000-8000-0000000029a1',
  task_id: '00000000-0000-4000-8000-0000000029a2',
  project_id: '00000000-0000-4000-8000-0000000029a3',
  project_key: 'ACME',
  ticket_key: 'ACME-7',
  title: 'Fix the login page',
  stage: 'implementation',
  role: 'developer',
  attempt: 1,
  phase: 'running',
  started_at: '2026-11-05T10:01:00.000Z',
  elapsed_ms: 240_000,
  tokens: null,
  cost_usd: null,
  cancel_requested: false,
  transcript: [
    {
      run_id: '00000000-0000-4000-8000-0000000029a1',
      seq: 1,
      created_at: '2026-11-05T10:04:50.000Z',
      redaction_count: 0,
      kind: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'hello' }],
    },
  ],
};

const STATE = {
  worker_id: '00000000-0000-4000-8000-0000000029f1',
  worker_name: 'alice-laptop',
  connection: 'connected',
  protocol: 2,
  core_protocol: { current: 2, accepted: [1, 2] },
  core_url: 'https://core.example.test',
  last_handshake_at: '2026-11-05T10:00:00.000Z',
  manually_paused_at: null,
  usage_paused_until: null,
  draining: false,
  update_pending: null,
  concurrency: 2,
  runs: [RUN],
  logs: ['a line'],
  server_time: '2026-11-05T10:05:00.000Z',
};

describe('the page’s boundary check against the worker’s schemas (WP-292)', () => {
  it('names the same keys as the zod shapes, both ways, and the same prefix', () => {
    expect([...STATE_KEYS].sort()).toEqual(Object.keys(workerLocalStateSchema.shape).sort());
    expect([...RUN_KEYS].sort()).toEqual(Object.keys(workerLocalRunSchema.shape).sort());
    expect([...CANCEL_KEYS].sort()).toEqual(
      Object.keys(workerLocalCancelResponseSchema.shape).sort(),
    );
    expect(LOCAL_API_PREFIX).toBe(WORKER_LOCAL_API_PREFIX);
  });

  const withRun = (patch: Record<string, unknown>) => ({ ...STATE, runs: [{ ...RUN, ...patch }] });
  const { worker_name: _dropped, ...missingKey } = STATE;
  const refused: readonly [string, unknown][] = [
    ['an unknown key', { ...STATE, extra: 1 }],
    ['a missing key', missingKey],
    ['an unknown connection', { ...STATE, connection: 'online' }],
    ['a concurrency past 64', { ...STATE, concurrency: 65 }],
    ['a worker id that is not a uuid', { ...STATE, worker_id: 'w1' }],
    ['a date that is not ISO', { ...STATE, server_time: 'yesterday' }],
    ['an unknown key on a run', withRun({ extra: 1 })],
    ['a title past 500 characters', withRun({ title: 'x'.repeat(501) })],
    ['an unknown role', withRun({ role: 'wizard' })],
    ['negative tokens', withRun({ tokens: -1 })],
    ['an unknown phase', withRun({ phase: 'sleeping' })],
    ['a transcript entry with no kind', withRun({ transcript: [{ seq: 1 }] })],
  ];

  it('accepts what the schema accepts', () => {
    expect(workerLocalStateSchema.safeParse(STATE).success).toBe(true);
    expect(readState(STATE)).toEqual(STATE);
  });

  it.each(refused)('refuses %s, as the schema does', (_name, value) => {
    expect(workerLocalStateSchema.safeParse(value).success).toBe(false);
    expect(readState(value)).toBeNull();
  });

  it('reads a cancel’s answer strictly', () => {
    const answer = { run_id: RUN.run_id, accepted: true, task_state: 'paused' };
    expect(readCancel(answer)).toEqual(answer);
    expect(readCancel({ ...answer, more: 1 })).toBeNull();
  });
});

describe('the token and the client (WP-292 (1))', () => {
  const TOKEN = 'A'.repeat(43);

  it('takes the token from the fragment, keeps it for the tab and strips the address', () => {
    const stored: string[] = [];
    const strip = vi.fn();
    const place = {
      hash: `#token=${TOKEN}`,
      stored: () => stored.at(-1) ?? null,
      store: (token: string) => stored.push(token),
      stripHash: strip,
    };
    expect(takeToken(place)).toBe(TOKEN);
    expect(stored).toEqual([TOKEN]);
    expect(strip).toHaveBeenCalledOnce();
    // A later load with no fragment reads the tab's copy; a malformed one is not kept.
    expect(takeToken({ ...place, hash: '' })).toBe(TOKEN);
    expect(takeToken({ ...place, hash: '#token=short', stored: () => null })).toBeNull();
  });

  it('sends the bearer and the key, no credentials, and refuses an answer it cannot read', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith('/cancel')
        ? new Response(JSON.stringify({ run_id: RUN.run_id, accepted: true, task_state: 'paused' }))
        : new Response(JSON.stringify({ ...STATE, extra: 1 }));
    }) as unknown as typeof fetch;
    const client = createLocalClient(TOKEN, fetchImpl);
    await client.cancel(RUN.run_id, 'key-1');
    const [cancel] = calls;
    expect(cancel?.url).toBe(`/api/local/runs/${RUN.run_id}/cancel`);
    expect(cancel?.init.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'idempotency-key': 'key-1',
    });
    expect(cancel?.init.credentials).toBe('omit');
    await expect(client.state()).rejects.toBeInstanceOf(LocalCallError);
  });
});
