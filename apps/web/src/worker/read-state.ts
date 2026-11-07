/**
 * **The local page's boundary check** (WP-292) — what the page accepts from `/api/local/*`.
 *
 * The worker parses every answer with `@platform/contracts`'s `worker-local.ts` zod schemas before
 * it sends it. The page does not import them: its initial graph has a budget of its own (≤ 120 kB
 * gz) and React plus zod's chunk alone measured 127 kB — TD-031's 2026-11-05 amendment, decision 4,
 * which admits a hand-written guard for this one entry on three conditions, all kept here.
 *
 * The guard is **declarative**: each answer's shape is a {@link Spec} tree — every key at every
 * depth, strict (no key more), each value's type, enum members, literal tags, string and array
 * bounds, integer floors, which keys may be absent and which may be `null` — and {@link conforms}
 * walks a value against it, refusing rather than repairing. `read-state.test.ts` walks the same
 * tree against the zod schema **in both directions** (keys, enum members, bounds, optionality and
 * nullability at every depth) and runs the same accept and refuse fixtures through both, so a field
 * added to one and not the other fails a test, not a page. Opaque JSON (a `system` entry's `data`,
 * a tool's `input`, a structured output) is checked as JSON and no deeper, exactly as zod does.
 *
 * Every value is still rendered as text: this decides only whether the page reads the answer.
 */
import type {
  WorkerLocalCancelResponse,
  WorkerLocalClaimScope,
  WorkerLocalCoreCheckResponse,
  WorkerLocalErrorReportingTestResponse,
  WorkerLocalOffers,
  WorkerLocalState,
  WorkerLocalTakeResponse,
} from '@platform/contracts';
import { ROLE_LABEL } from '../ui/words/roles.js';
import { TERMINAL_REASON_LABEL } from '../ui/words/terminal-reasons.js';
import { WORKER_CLAIM_BLOCKER_WORDS } from '../ui/words/worker-blockers.js';

/** The local verbs' prefix — `WORKER_LOCAL_API_PREFIX`, held equal by the test. */
export const LOCAL_API_PREFIX = '/api/local';

/** One node of an answer's shape — the vocabulary the test maps onto zod's own. */
export type Spec =
  | {
      readonly t: 'string';
      readonly format?: 'uuid' | 'datetime';
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly t: 'int'; readonly min?: number; readonly max?: number }
  | { readonly t: 'number'; readonly min?: number }
  | { readonly t: 'boolean' }
  | { readonly t: 'enum'; readonly values: readonly string[] }
  | { readonly t: 'literal'; readonly value: string }
  | { readonly t: 'object'; readonly keys: Readonly<Record<string, Spec>> }
  | { readonly t: 'array'; readonly of: Spec; readonly min?: number; readonly max?: number }
  /** A discriminated union of objects, by `tag`. */
  | { readonly t: 'union'; readonly tag: string; readonly options: readonly Spec[] }
  | { readonly t: 'nullable'; readonly of: Spec }
  /** The key may be absent. */
  | { readonly t: 'optional'; readonly of: Spec }
  /** Any JSON object with string keys (`jsonObjectSchema`). */
  | { readonly t: 'json-object' }
  /** An object whose every key conforms to `key` and every value to `of` (`z.record`). */
  | { readonly t: 'record'; readonly key: Spec; readonly of: Spec }
  /** Any JSON value (`jsonValueSchema`). */
  | { readonly t: 'json' };

const str = (extra: Omit<Extract<Spec, { t: 'string' }>, 't'> = {}): Spec => ({
  t: 'string',
  ...extra,
});
const nonEmpty: Spec = str({ min: 1 });
const uuid: Spec = str({ format: 'uuid' });
const datetime: Spec = str({ format: 'datetime' });
const count: Spec = { t: 'int', min: 0 };
const nullable = (of: Spec): Spec => ({ t: 'nullable', of });
const nullish = (of: Spec): Spec => ({ t: 'optional', of: nullable(of) });
const object = (keys: Record<string, Spec>): Spec => ({ t: 'object', keys });

/** The agent roles — `ROLE_LABEL`'s keys, which the test holds to `agentRoleSchema`. */
export const ROLES: readonly string[] = Object.keys(ROLE_LABEL);
export const TERMINAL_REASONS: readonly string[] = Object.keys(TERMINAL_REASON_LABEL);
/** Why a worker takes no work (S-22.19) — the words' keys, which the test holds to the zod enum. */
export const CLAIM_BLOCKERS: readonly string[] = Object.keys(WORKER_CLAIM_BLOCKER_WORDS);
export const CONNECTIONS = [
  'needs_platform',
  'needs_claude',
  'logging_in',
  'handshaking',
  'connected',
  'revoked',
  'upgrade_required',
  'core_unreachable',
  'stopped',
] as const;
/** Whether the launcher answered (backlog 980) — held to its zod enum by the test. */
export const LAUNCHERS = ['unknown', 'ok', 'unreachable'] as const;
/** `workerClaimPolicySchema`'s members (S-26.4) — the guard's mirror only; the words are S-26.7's. */
export const CLAIM_POLICIES = ['everything', 'mine_and_unassigned', 'mine', 'pick_only'] as const;
/** The first-run wizard's enums (WP-294) — each held to its zod enum by the test. */
export const SOURCES = ['environment', 'file'] as const;
export const CORE_FAILURES = [
  'address_refused',
  'no_answer',
  'not_a_platform',
  'certificate',
  'needs_other_version',
] as const;
export const SIGN_IN_PHASES = [
  'idle',
  'starting',
  'waiting_for_code',
  'checking',
  'failed',
] as const;
export const SIGN_IN_FAILURES = [
  'cli_unavailable',
  'cli_ended',
  'code_refused',
  'token_rejected',
  'check_failed',
  'timed_out',
  'no_token_after_code',
] as const;
export const UI_AUTHS = ['none', 'token'] as const;
export const PHASES = ['provisioning', 'running', 'finishing', 'ended'] as const;
export const HOOKS = [
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Stop',
  'UserPromptSubmit',
  'PostModelSwitch',
] as const;

const contentBlock: Spec = {
  t: 'union',
  tag: 'type',
  options: [
    object({ type: { t: 'literal', value: 'text' }, text: str() }),
    object({ type: { t: 'literal', value: 'thinking' }, thinking: str() }),
    object({
      type: { t: 'literal', value: 'tool_use' },
      tool_use_id: nonEmpty,
      tool_name: nonEmpty,
      input: { t: 'json-object' },
    }),
    object({
      type: { t: 'literal', value: 'tool_result' },
      tool_use_id: nonEmpty,
      is_error: { t: 'boolean' },
      content: str(),
    }),
  ],
};

const usage = {
  input_tokens: count,
  output_tokens: count,
  cache_write_5m_tokens: count,
  cache_write_1h_tokens: count,
  cache_read_tokens: count,
};
const usd: Spec = { t: 'number', min: 0 };

/** A transcript entry — `transcriptEventSchema`, kind by kind. */
const entry = (kind: string, keys: Record<string, Spec>): Spec =>
  object({
    run_id: uuid,
    seq: count,
    created_at: datetime,
    parent_tool_use_id: nullish(nonEmpty),
    redaction_count: count,
    kind: { t: 'literal', value: kind },
    ...keys,
  });

export const TRANSCRIPT_ENTRY: Spec = {
  t: 'union',
  tag: 'kind',
  options: [
    entry('system', {
      subtype: nonEmpty,
      session_id: nullish(nonEmpty),
      model: nullish(nonEmpty),
      data: { t: 'json-object' },
    }),
    entry('assistant', { model: nonEmpty, content: { t: 'array', of: contentBlock } }),
    entry('user', { content: { t: 'array', of: contentBlock } }),
    entry('result', {
      terminal_reason: { t: 'enum', values: TERMINAL_REASONS },
      num_turns: count,
      duration_ms: count,
      usage: object(usage),
      model_usage: { t: 'array', of: object({ ...usage, model: nonEmpty, usd }) },
      cost: object({ usd, is_estimate: { t: 'boolean' }, price_list_id: nullish(uuid) }),
      structured_output: nullish({ t: 'json' }),
    }),
    entry('stream_block', {
      block_index: count,
      block: contentBlock,
      first_delta_at: datetime,
      last_delta_at: datetime,
    }),
    entry('hook', {
      hook: { t: 'enum', values: HOOKS },
      tool_name: nullish(nonEmpty),
      tool_use_id: nullish(nonEmpty),
      decision: nullish({ t: 'enum', values: ['allow', 'ask', 'deny'] }),
      reason: nullish(str()),
      question_id: nullish(uuid),
    }),
    entry('steer', { message: nonEmpty, author_user_id: uuid }),
    entry('compaction', {
      phase: { t: 'enum', values: ['pre', 'post'] },
      pre_tokens: nullish(count),
      post_tokens: nullish(count),
    }),
    entry('progress', {
      summary: str({ min: 1, max: 2_000 }),
      percent_complete: nullish({ t: 'int', min: 0, max: 100 }),
      truncated: { t: 'boolean' },
    }),
  ],
};

export const RUN: Spec = object({
  run_id: uuid,
  task_id: uuid,
  project_id: uuid,
  project_key: nullable(str({ max: 64 })),
  ticket_key: nullable(str({ max: 256 })),
  title: nullable(str({ max: 500 })),
  stage: nullable(str({ max: 128 })),
  role: { t: 'enum', values: ROLES },
  attempt: { t: 'int', min: 1 },
  phase: { t: 'enum', values: PHASES },
  started_at: datetime,
  elapsed_ms: count,
  tokens: nullable(count),
  cost_usd: nullable({ t: 'number', min: 0 }),
  cancel_requested: { t: 'boolean' },
  transcript: { t: 'array', of: TRANSCRIPT_ENTRY, max: 40 },
});

export const STATE: Spec = object({
  worker_id: nullable(uuid),
  worker_name: nullable(str({ max: 200 })),
  connection: { t: 'enum', values: CONNECTIONS },
  protocol: { t: 'int', min: 1 },
  core_protocol: nullable(
    object({
      current: { t: 'int', min: 1 },
      accepted: { t: 'array', of: { t: 'int', min: 1 }, min: 1, max: 2 },
    }),
  ),
  core_url: nullable(str({ max: 2_048 })),
  last_handshake_at: nullable(datetime),
  manually_paused_at: nullable(datetime),
  usage_paused_until: nullable(datetime),
  usage_paused_estimated: { t: 'boolean' },
  draining: { t: 'boolean' },
  launcher: { t: 'enum', values: LAUNCHERS },
  update_pending: nullable({ t: 'boolean' }),
  concurrency: { t: 'int', min: 1, max: 64 },
  runs: { t: 'array', of: RUN, max: 64 },
  logs: { t: 'array', of: str({ max: 2_032 }), max: 200 },
  setup: object({
    core_source: nullable({ t: 'enum', values: SOURCES }),
    candidates: {
      t: 'array',
      of: object({ url: str({ max: 2_048 }), version: str({ max: 128 }) }),
      max: 8,
    },
    claude_source: nullable({ t: 'enum', values: SOURCES }),
    claude_rejected: { t: 'boolean' },
    sign_in: object({
      phase: { t: 'enum', values: SIGN_IN_PHASES },
      url: nullable(str({ max: 4_096 })),
      failure: nullable({ t: 'enum', values: SIGN_IN_FAILURES }),
    }),
    device: nullable(
      object({
        user_code: str({ max: 16 }),
        approve_url: nullable(str({ max: 2_048 })),
        expires_at: datetime,
      }),
    ),
    unreachable: nullable(
      object({
        failure: { t: 'enum', values: CORE_FAILURES },
        retry_at: nullable(datetime),
      }),
    ),
    idle: { t: 'boolean' },
    auth: { t: 'enum', values: UI_AUTHS },
  }),
  claim_blockers: {
    t: 'array',
    of: { t: 'enum', values: CLAIM_BLOCKERS },
    max: CLAIM_BLOCKERS.length,
  },
  claim_policy: nullish({ t: 'enum', values: CLAIM_POLICIES }),
  policy_skipped_offers: nullish(count),
  error_reporting: object({
    source: nullable({ t: 'enum', values: SOURCES }),
    host: nullable(str({ max: 253 })),
  }),
  started_at: datetime,
  server_time: datetime,
});

export const CORE_CHECK: Spec = object({
  url: str({ max: 2_048 }),
  host: str({ max: 253 }),
  version: str({ max: 128 }),
  protocol_fit: { t: 'enum', values: ['fits', 'unknown'] },
});

export const CANCEL: Spec = object({
  run_id: uuid,
  accepted: { t: 'boolean' },
  task_state: str({ max: 64 }),
});

/** A claim scope: `null` every project, `[]` pick only, otherwise those projects (WP-293). */
const SCOPE: Spec = nullable({ t: 'array', of: uuid, max: 100 });

/** `GET`/`POST /api/local/claim-scope` — `workerLocalClaimScopeSchema` (WP-293). */
export const CLAIM_SCOPE: Spec = object({
  claim_project_ids: SCOPE,
  projects: {
    t: 'array',
    of: object({ id: uuid, key: str({ min: 1, max: 64 }), name: str({ max: 200 }) }),
    max: 500,
  },
  claim_policy: { t: 'optional', of: { t: 'enum', values: CLAIM_POLICIES } },
  policy_skipped_offers: nullish(count),
  // BACKLOG 1456: per project id, whether another taker takes its unassigned tasks by itself.
  unassigned_has_taker: { t: 'optional', of: { t: 'record', key: uuid, of: { t: 'boolean' } } },
});

/** One offer of `GET /api/local/offers` — `workerOfferSchema` (WP-293). */
export const OFFER: Spec = object({
  run_id: uuid,
  kind: { t: 'enum', values: ['stage', 'ask'] },
  project_key: nullable(str({ max: 64 })),
  ticket_key: nullable(str({ max: 256 })),
  title: nullable(str({ max: 500 })),
  stage: nullable(str({ max: 128 })),
  role: { t: 'enum', values: ROLES },
  offered_at: datetime,
  automatic: { t: 'boolean' },
  owner: nullish(object({ user_id: uuid, name: str() })),
  mine: { t: 'optional', of: { t: 'boolean' } },
  // S-26.7: a pick of it claims without assigning; absent from a core that predates the field.
  held_elsewhere: { t: 'optional', of: { t: 'boolean' } },
});

/** `GET /api/local/offers` — `workerLocalOffersSchema` (WP-293; S-26.4's keys). */
export const OFFERS: Spec = object({
  offers: { t: 'array', of: OFFER, max: 50 },
  as_of: { t: 'optional', of: datetime },
  policy_skipped_offers: nullish(count),
});

/** `POST /api/local/offers/:id/take` — `workerLocalTakeResponseSchema` (WP-293). */
export const TAKE: Spec = object({ run_id: uuid });

/** `POST /api/local/error-reporting/test` — `workerLocalErrorReportingTestResponseSchema` (WP-295). */
export const ERROR_REPORTING_TEST: Spec = object({
  event_id: nullable(str({ max: 64 })),
  delivered: { t: 'boolean' },
});

export const ERROR: Spec = object({
  error: object({
    code: str({ max: 64 }),
    message: str({ max: 2_000 }),
    // S-26.7: the owner a refused pick names (`task_taken_by_another`, `task_owned_by_another`).
    owner: { t: 'optional', of: object({ user_id: uuid, name: str({ max: 200 }) }) },
  }),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJson = (value: unknown, depth = 0): boolean => {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJson(item, depth + 1));
};

const within = (n: number, min: number | undefined, max: number | undefined): boolean =>
  (min === undefined || n >= min) && (max === undefined || n <= max);

/** Whether `value` has the shape `spec` names — strictly: an unknown key is a refusal. */
export const conforms = (spec: Spec, value: unknown): boolean => {
  switch (spec.t) {
    case 'string':
      return (
        typeof value === 'string' &&
        within(value.length, spec.min, spec.max) &&
        (spec.format === undefined || (spec.format === 'uuid' ? UUID : DATETIME).test(value))
      );
    case 'int':
      return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        within(value, spec.min, spec.max)
      );
    case 'number':
      return (
        typeof value === 'number' && Number.isFinite(value) && within(value, spec.min, undefined)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value);
    case 'literal':
      return value === spec.value;
    case 'nullable':
      return value === null || conforms(spec.of, value);
    case 'optional':
      return value === undefined || conforms(spec.of, value);
    case 'json':
      return isJson(value);
    case 'json-object':
      return isRecord(value) && isJson(value);
    case 'record':
      return (
        isRecord(value) &&
        Object.entries(value).every(
          ([key, item]) => conforms(spec.key, key) && conforms(spec.of, item),
        )
      );
    case 'array':
      return (
        Array.isArray(value) &&
        within(value.length, spec.min, spec.max) &&
        value.every((item) => conforms(spec.of, item))
      );
    case 'object': {
      if (!isRecord(value)) return false;
      if (Object.keys(value).some((key) => !Object.hasOwn(spec.keys, key))) return false;
      return Object.entries(spec.keys).every(([key, child]) =>
        Object.hasOwn(value, key) ? conforms(child, value[key]) : child.t === 'optional',
      );
    }
    case 'union': {
      if (!isRecord(value)) return false;
      const option = spec.options.find(
        (candidate) =>
          candidate.t === 'object' && conforms(candidate.keys[spec.tag] as Spec, value[spec.tag]),
      );
      return option !== undefined && conforms(option, value);
    }
  }
};

/** The state, or `null` for an answer this page does not read. */
export const readState = (value: unknown): WorkerLocalState | null =>
  conforms(STATE, value) ? (value as WorkerLocalState) : null;

/** A platform check's answer (WP-294), or `null`. */
export const readCoreCheck = (value: unknown): WorkerLocalCoreCheckResponse | null =>
  conforms(CORE_CHECK, value) ? (value as WorkerLocalCoreCheckResponse) : null;

/** A cancel's answer, or `null`. */
export const readCancel = (value: unknown): WorkerLocalCancelResponse | null =>
  conforms(CANCEL, value) ? (value as WorkerLocalCancelResponse) : null;

/** The claim scope's answer, or `null` (WP-293). */
export const readClaimScope = (value: unknown): WorkerLocalClaimScope | null =>
  conforms(CLAIM_SCOPE, value) ? (value as WorkerLocalClaimScope) : null;

/** The offers' answer, or `null` (WP-293). */
export const readOffers = (value: unknown): WorkerLocalOffers | null =>
  conforms(OFFERS, value) ? (value as WorkerLocalOffers) : null;

/** A take's answer, or `null` (WP-293). */
export const readTake = (value: unknown): WorkerLocalTakeResponse | null =>
  conforms(TAKE, value) ? (value as WorkerLocalTakeResponse) : null;

/** *Send a test error*'s answer, or `null` (WP-295). */
export const readErrorReportingTest = (
  value: unknown,
): WorkerLocalErrorReportingTestResponse | null =>
  conforms(ERROR_REPORTING_TEST, value) ? (value as WorkerLocalErrorReportingTestResponse) : null;

/** An error envelope's code and message, or `null`. */
export const readError = (
  value: unknown,
): {
  code: string;
  message: string;
  owner?: { readonly user_id: string; readonly name: string };
} | null =>
  conforms(ERROR, value)
    ? (
        value as {
          error: {
            code: string;
            message: string;
            owner?: { readonly user_id: string; readonly name: string };
          };
        }
      ).error
    : null;
