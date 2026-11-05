/**
 * **The local page's boundary check** (WP-292) — what the page accepts from `/api/local/*`.
 *
 * The worker serialises its answers with `@platform/contracts`'s `worker-local.ts` zod schemas. The
 * page cannot import them: its initial graph has a budget of its own (≤ 120 kB gz, TD-031's
 * worker-UI amendment §3) and React plus zod's chunk alone measured 127 kB. So this module checks
 * each answer **structurally and strictly** — every key named, no key more, every bound the schema
 * states — and refuses rather than repairs, the schemas' own rule. `read-state.test.ts` holds the
 * key lists to the zod shapes in both directions and runs the same fixtures through both, so a field
 * added to one and not the other fails a test, not a page.
 *
 * Every value is still rendered as text: this decides only whether the page reads the answer.
 */
import type {
  WorkerLocalCancelResponse,
  WorkerLocalRun,
  WorkerLocalState,
} from '@platform/contracts';
import { ROLE_LABEL } from '../ui/humanize.js';

/** The local verbs' prefix — `WORKER_LOCAL_API_PREFIX`, held equal by the test. */
export const LOCAL_API_PREFIX = '/api/local';

type Json = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const STATE_KEYS = [
  'worker_id',
  'worker_name',
  'connection',
  'protocol',
  'core_protocol',
  'core_url',
  'last_handshake_at',
  'manually_paused_at',
  'usage_paused_until',
  'draining',
  'update_pending',
  'concurrency',
  'runs',
  'logs',
  'server_time',
] as const;

export const RUN_KEYS = [
  'run_id',
  'task_id',
  'project_id',
  'project_key',
  'ticket_key',
  'title',
  'stage',
  'role',
  'attempt',
  'phase',
  'started_at',
  'elapsed_ms',
  'tokens',
  'cost_usd',
  'cancel_requested',
  'transcript',
] as const;

export const CANCEL_KEYS = ['run_id', 'accepted', 'task_state'] as const;

const CONNECTIONS = new Set([
  'logging_in',
  'handshaking',
  'connected',
  'revoked',
  'upgrade_required',
  'stopped',
]);
const PHASES = new Set(['provisioning', 'running', 'finishing', 'ended']);

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Json, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const text = (value: unknown, max: number): boolean =>
  typeof value === 'string' && value.length <= max;
const textOrNull = (value: unknown, max: number): boolean => value === null || text(value, max);
const iso = (value: unknown): boolean => typeof value === 'string' && ISO.test(value);
const isoOrNull = (value: unknown): boolean => value === null || iso(value);
const uuid = (value: unknown): boolean => typeof value === 'string' && UUID.test(value);
const int = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const isRun = (value: unknown): value is WorkerLocalRun =>
  isObject(value) &&
  exactKeys(value, RUN_KEYS) &&
  uuid(value.run_id) &&
  uuid(value.task_id) &&
  uuid(value.project_id) &&
  textOrNull(value.project_key, 64) &&
  textOrNull(value.ticket_key, 256) &&
  textOrNull(value.title, 500) &&
  textOrNull(value.stage, 128) &&
  typeof value.role === 'string' &&
  Object.hasOwn(ROLE_LABEL, value.role) &&
  int(value.attempt, 1) &&
  typeof value.phase === 'string' &&
  PHASES.has(value.phase) &&
  iso(value.started_at) &&
  int(value.elapsed_ms, 0) &&
  (value.tokens === null || int(value.tokens, 0)) &&
  (value.cost_usd === null ||
    (typeof value.cost_usd === 'number' &&
      Number.isFinite(value.cost_usd) &&
      value.cost_usd >= 0)) &&
  typeof value.cancel_requested === 'boolean' &&
  Array.isArray(value.transcript) &&
  value.transcript.length <= 40 &&
  value.transcript.every(
    (entry) => isObject(entry) && typeof entry.kind === 'string' && typeof entry.seq === 'number',
  );

/** The state, or `null` for an answer this page does not read. */
export const readState = (value: unknown): WorkerLocalState | null => {
  if (!isObject(value) || !exactKeys(value, STATE_KEYS)) return null;
  const protocol = value.core_protocol;
  const ok =
    (value.worker_id === null || uuid(value.worker_id)) &&
    textOrNull(value.worker_name, 200) &&
    typeof value.connection === 'string' &&
    CONNECTIONS.has(value.connection) &&
    int(value.protocol, 1) &&
    (protocol === null ||
      (isObject(protocol) &&
        exactKeys(protocol, ['current', 'accepted']) &&
        int(protocol.current, 1) &&
        Array.isArray(protocol.accepted) &&
        protocol.accepted.length >= 1 &&
        protocol.accepted.length <= 2 &&
        protocol.accepted.every((version) => int(version, 1)))) &&
    text(value.core_url, 2_048) &&
    isoOrNull(value.last_handshake_at) &&
    isoOrNull(value.manually_paused_at) &&
    isoOrNull(value.usage_paused_until) &&
    typeof value.draining === 'boolean' &&
    (value.update_pending === null || typeof value.update_pending === 'boolean') &&
    int(value.concurrency, 1, 64) &&
    Array.isArray(value.runs) &&
    value.runs.length <= 64 &&
    value.runs.every(isRun) &&
    Array.isArray(value.logs) &&
    value.logs.length <= 200 &&
    value.logs.every((line) => text(line, 2_032)) &&
    iso(value.server_time);
  return ok ? (value as unknown as WorkerLocalState) : null;
};

/** A cancel's answer, or `null`. */
export const readCancel = (value: unknown): WorkerLocalCancelResponse | null =>
  isObject(value) &&
  exactKeys(value, CANCEL_KEYS) &&
  uuid(value.run_id) &&
  typeof value.accepted === 'boolean' &&
  text(value.task_state, 64)
    ? (value as unknown as WorkerLocalCancelResponse)
    : null;

/** An error envelope's code and message, or `null`. */
export const readError = (value: unknown): { code: string; message: string } | null => {
  if (!isObject(value) || !exactKeys(value, ['error']) || !isObject(value.error)) return null;
  const { code, message } = value.error;
  return exactKeys(value.error, ['code', 'message']) && text(code, 64) && text(message, 2_000)
    ? { code: code as string, message: message as string }
    : null;
};
