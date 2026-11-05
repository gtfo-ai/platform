/**
 * The local page's boundary check (`read-state.ts`) held to the zod schemas the worker serialises
 * with (WP-292): the same keys **in both directions**, the same verdict over the same fixtures, the
 * same API prefix — so a field added to one side and not the other fails here. And the token's
 * journey: out of the fragment, into `sessionStorage`, off the address bar.
 */
import {
  agentRoleSchema,
  runTerminalReasonSchema,
  transcriptEventSchema,
  WORKER_LOCAL_API_PREFIX,
  workerLocalCancelResponseSchema,
  workerLocalErrorSchema,
  workerLocalRunSchema,
  workerLocalStateSchema,
} from '@platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createLocalClient, LocalCallError, takeToken } from './client.js';
import {
  CANCEL,
  CONNECTIONS,
  conforms,
  ERROR,
  HOOKS,
  LOCAL_API_PREFIX,
  PHASES,
  ROLES,
  RUN as RUN_SPEC,
  readCancel,
  readState,
  type Spec,
  STATE as STATE_SPEC,
  TERMINAL_REASONS,
  TRANSCRIPT_ENTRY,
} from './read-state.js';

/**
 * A zod schema as a {@link Spec} — read off zod's own definitions (`_zod.def`): keys at every
 * depth, enum members, literals, string and array bounds, integer floors and ceilings,
 * optionality and nullability. A node this does not know throws, so a schema that grows a kind of
 * node the guard cannot express fails here by name.
 */
type ZodNode = { readonly _zod: { readonly def: Record<string, unknown> } };
const boundsOf = (node: ZodNode) => {
  const out: { min?: number; max?: number } = {};
  for (const check of (node._zod.def.checks as ZodNode[] | undefined) ?? []) {
    const def = check._zod.def as Record<string, unknown>;
    if (def.check === 'min_length') out.min = def.minimum as number;
    else if (def.check === 'max_length') out.max = def.maximum as number;
    else if (def.check === 'greater_than') {
      out.min = (def.value as number) + (def.inclusive === true ? 0 : 1);
    } else if (def.check === 'less_than') {
      out.max = (def.value as number) - (def.inclusive === true ? 0 : 1);
    } else throw new Error(`a check the guard cannot express: ${String(def.check)}`);
  }
  return out;
};
const specOf = (node: ZodNode): Spec => {
  const def = node._zod.def;
  switch (def.type) {
    case 'optional':
      return { t: 'optional', of: specOf(def.innerType as ZodNode) };
    case 'nullable':
      return { t: 'nullable', of: specOf(def.innerType as ZodNode) };
    case 'string': {
      const format = def.format as string | undefined;
      if (format !== undefined && format !== 'uuid' && format !== 'datetime') {
        throw new Error(`a string format the guard cannot express: ${format}`);
      }
      return { t: 'string', ...(format === undefined ? {} : { format }), ...boundsOf(node) };
    }
    case 'number': {
      const bounds = boundsOf(node);
      return def.format === 'safeint'
        ? { t: 'int', ...bounds }
        : { t: 'number', ...(bounds.min === undefined ? {} : { min: bounds.min }) };
    }
    case 'boolean':
      return { t: 'boolean' };
    case 'enum':
      return { t: 'enum', values: Object.values(def.entries as Record<string, string>) };
    case 'literal':
      return { t: 'literal', value: (def.values as string[])[0] as string };
    case 'object':
      return {
        t: 'object',
        keys: Object.fromEntries(
          Object.entries(def.shape as Record<string, ZodNode>).map(([key, child]) => [
            key,
            specOf(child),
          ]),
        ),
      };
    case 'array':
      return { t: 'array', of: specOf(def.element as ZodNode), ...boundsOf(node) };
    case 'union':
      return {
        t: 'union',
        tag: def.discriminator as string,
        options: (def.options as ZodNode[]).map(specOf),
      };
    case 'record':
      return { t: 'json-object' };
    case 'lazy':
      return { t: 'json' };
    default:
      throw new Error(`a zod node the guard cannot express: ${String(def.type)}`);
  }
};

/** Order-free: enum members sorted, union options sorted by their tag. */
const normal = (spec: Spec): unknown => {
  switch (spec.t) {
    case 'enum':
      return { ...spec, values: [...spec.values].sort() };
    case 'optional':
    case 'nullable':
      return { ...spec, of: normal(spec.of) };
    case 'array':
      return { ...spec, of: normal(spec.of) };
    case 'object':
      return {
        t: 'object',
        keys: Object.fromEntries(
          Object.entries(spec.keys).map(([key, child]) => [key, normal(child)]),
        ),
      };
    case 'union': {
      const tagOf = (option: Spec): string =>
        option.t === 'object' && option.keys[spec.tag]?.t === 'literal'
          ? (option.keys[spec.tag] as { value: string }).value
          : '';
      return {
        ...spec,
        options: [...spec.options].sort((a, b) => tagOf(a).localeCompare(tagOf(b))).map(normal),
      };
    }
    default:
      return spec;
  }
};

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

const envelope = (seq: number) => ({
  run_id: RUN.run_id,
  seq,
  created_at: '2026-11-05T10:04:56.000Z',
  redaction_count: 0,
});
const progress = (patch: Record<string, unknown>) => ({
  ...envelope(3),
  kind: 'progress',
  summary: 'half way',
  percent_complete: 50,
  truncated: false,
  ...patch,
});
const steer = (patch: Record<string, unknown>) => ({
  ...envelope(4),
  kind: 'steer',
  message: 'mind the footer',
  author_user_id: '00000000-0000-4000-8000-0000000029b1',
  ...patch,
});

describe('the page’s boundary check against the worker’s schemas (WP-292)', () => {
  it('is the zod schemas’ shape at every depth — keys, enum members, bounds, optionality, nullability — both ways', () => {
    // `toEqual` over the whole tree: a key, a member or a bound on either side and not the other
    // fails, and its path is in the diff (TD-031's 2026-11-05 amendment, decision 4 (b)).
    expect(normal(STATE_SPEC)).toEqual(
      normal(specOf(workerLocalStateSchema as unknown as ZodNode)),
    );
    expect(normal(RUN_SPEC)).toEqual(normal(specOf(workerLocalRunSchema as unknown as ZodNode)));
    expect(normal(TRANSCRIPT_ENTRY)).toEqual(
      normal(specOf(transcriptEventSchema as unknown as ZodNode)),
    );
    expect(normal(CANCEL)).toEqual(
      normal(specOf(workerLocalCancelResponseSchema as unknown as ZodNode)),
    );
    expect(normal(ERROR)).toEqual(normal(specOf(workerLocalErrorSchema as unknown as ZodNode)));
    expect(LOCAL_API_PREFIX).toBe(WORKER_LOCAL_API_PREFIX);
  });

  it('names the enums’ members as zod does, both ways', () => {
    const sorted = (values: readonly string[]) => [...values].sort();
    expect(sorted(CONNECTIONS)).toEqual(sorted(workerLocalStateSchema.shape.connection.options));
    expect(sorted(PHASES)).toEqual(sorted(workerLocalRunSchema.shape.phase.options));
    expect(sorted(ROLES)).toEqual(sorted(agentRoleSchema.options));
    expect(sorted(TERMINAL_REASONS)).toEqual(sorted(runTerminalReasonSchema.options));
    expect(HOOKS.length).toBeGreaterThan(0);
    expect(Object.keys(workerLocalStateSchema.shape.core_protocol.unwrap().shape).sort()).toEqual([
      'accepted',
      'current',
    ]);
  });

  it('a comparison that cannot pass vacuously: a guard one key short is told apart', () => {
    const short = { ...(STATE_SPEC as { keys: Record<string, Spec> }).keys };
    delete short.server_time;
    expect(normal({ t: 'object', keys: short })).not.toEqual(
      normal(specOf(workerLocalStateSchema as unknown as ZodNode)),
    );
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
    [
      'a transcript entry with an unknown key',
      withRun({ transcript: [{ ...RUN.transcript[0], extra: 1 }] }),
    ],
    [
      'a content block with an unknown key',
      withRun({
        transcript: [
          { ...RUN.transcript[0], content: [{ type: 'text', text: 'hi', html: '<b>' }] },
        ],
      }),
    ],
    [
      'a result with an unknown terminal reason',
      withRun({
        transcript: [
          {
            run_id: RUN.run_id,
            seq: 2,
            created_at: '2026-11-05T10:04:55.000Z',
            redaction_count: 0,
            kind: 'result',
            terminal_reason: 'exploded',
            num_turns: 1,
            duration_ms: 10,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_write_5m_tokens: 0,
              cache_write_1h_tokens: 0,
              cache_read_tokens: 0,
            },
            model_usage: [],
            cost: { usd: 0.1, is_estimate: false },
          },
        ],
      }),
    ],
    ['a progress percent past 100', withRun({ transcript: [progress({ percent_complete: 101 })] })],
    ['a steer with a non-uuid author', withRun({ transcript: [steer({ author_user_id: 'x' })] })],
  ];

  it('accepts what the schema accepts', () => {
    expect(workerLocalStateSchema.safeParse(STATE).success).toBe(true);
    expect(readState(STATE)).toEqual(STATE);
    // Every kind the page may meet, through both.
    for (const entry of [progress({}), steer({}), progress({ percent_complete: null })]) {
      expect(transcriptEventSchema.safeParse(entry).success).toBe(true);
      expect(conforms(TRANSCRIPT_ENTRY, entry)).toBe(true);
    }
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
