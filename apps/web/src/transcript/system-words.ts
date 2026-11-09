/**
 * **A transcript system row, in words** (S-25.19): the log printed `System · run_stopped` and kept
 * the cause in the JSON view underneath, so a reader saw that the platform stopped a run and had to
 * open a code block to learn why. {@link systemWords} says it on the row itself — *The platform
 * stopped the run · it stopped producing anything for too long* — and the JSON view stays under it
 * for whoever wants the record.
 *
 * **Two halves, kept apart.** `label` is platform text. `detail` is built out of the row's `data`,
 * which is the CLI's (or, for `run_stopped`, the runner's closed vocabulary): every value read from
 * it is a `string` or a `number` checked here, filtered by `sanitiseUntrusted`, flattened to one
 * line and bounded at {@link SYSTEM_DETAIL_MAX_CHARS} — the caller renders it as React text. A value
 * of another type is absent, never coerced (rule 14: a missing field is not zero).
 *
 * A subtype this table does not name keeps the old row — *System notice · <subtype>*, the subtype
 * filtered — rather than inventing a meaning for it.
 */
import { RUN_STOPPED_REASONS } from '@platform/contracts';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import type { SystemBlock } from './blocks.js';

/** The runner's closed vocabulary of why it stopped a run (`@platform/contracts`). */
export type RunStoppedReason = (typeof RUN_STOPPED_REASONS)[number];

/** A detail longer than this is cut, with an ellipsis: the JSON view has the whole of it. */
export const SYSTEM_DETAIL_MAX_CHARS = 200;

/** Why the platform stopped a run (`run_stopped`'s `data.reason`), as it reads after the label. */
export const RUN_STOPPED_WORDS: Readonly<Record<RunStoppedReason, string>> = {
  stalled: 'it stopped producing anything for too long',
  timed_out: 'it went past its time limit',
  budget_exceeded: 'it reached its budget cap',
  cost_unreported: 'its cost could not be measured',
  cancelled: 'a person cancelled it',
  taken_over: 'a person is working on it themselves',
  shutdown: 'its runner was shutting down',
};

/** The API errors a retry names (the SDK's `SDKAssistantMessageError`), in words. */
const API_ERROR_WORDS: Readonly<Record<string, string>> = {
  rate_limit: 'rate limited',
  overloaded: 'the API was overloaded',
  server_error: 'a server error',
  authentication_failed: 'authentication failed',
  oauth_org_not_allowed: 'the account’s organisation is not allowed',
  account_on_hold: 'the account is on hold',
  billing_error: 'a billing error',
  invalid_request: 'an invalid request',
  model_not_found: 'the model was not found',
  max_output_tokens: 'the answer hit its output limit',
  cloud_credential_error: 'a cloud credential error',
  unknown: 'an unknown error',
};

export interface SystemWords {
  /** Platform text. */
  readonly label: string;
  /** Built from the row's data: filtered, one line, bounded — still rendered as text. */
  readonly detail: string | null;
}

const oneLine = (value: string): string | null => {
  const flat = sanitiseUntrusted(value).replace(/\s+/g, ' ').trim();
  if (flat === '') {
    return null;
  }
  return flat.length > SYSTEM_DETAIL_MAX_CHARS
    ? `${flat.slice(0, SYSTEM_DETAIL_MAX_CHARS - 1)}…`
    : flat;
};

const text = (data: SystemBlock['data'], key: string): string | null => {
  const value = Object.hasOwn(data, key) ? data[key] : undefined;
  return typeof value === 'string' ? oneLine(value) : null;
};

const count = (data: SystemBlock['data'], key: string): number | null => {
  const value = Object.hasOwn(data, key) ? data[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};

const joined = (...parts: readonly (string | null)[]): string | null => {
  const kept = parts.filter((part): part is string => part !== null && part !== '');
  return kept.length === 0 ? null : kept.join(' · ');
};

const isStopReason = (value: string): value is RunStoppedReason =>
  (RUN_STOPPED_REASONS as readonly string[]).includes(value);

const apiRetry = (data: SystemBlock['data']): string | null => {
  const attempt = count(data, 'attempt');
  const max = count(data, 'max_retries');
  const delay = count(data, 'retry_delay_ms');
  const status = count(data, 'error_status');
  const error = Object.hasOwn(data, 'error') ? data['error'] : undefined;
  const cause =
    typeof error === 'string'
      ? Object.hasOwn(API_ERROR_WORDS, error)
        ? (API_ERROR_WORDS[error] as string)
        : oneLine(error.replace(/_/g, ' '))
      : null;
  return joined(
    attempt === null ? null : max === null ? `attempt ${attempt}` : `attempt ${attempt} of ${max}`,
    cause,
    status === null ? null : `HTTP ${status}`,
    delay === null ? null : `next try in ${Math.max(1, Math.round(delay / 1000))} s`,
  );
};

export const systemWords = (
  block: Pick<SystemBlock, 'subtype' | 'data' | 'model'>,
): SystemWords => {
  const { data } = block;
  switch (block.subtype) {
    case 'run_stopped': {
      const reason = text(data, 'reason');
      return {
        label: 'The platform stopped the run',
        detail: reason === null ? null : isStopReason(reason) ? RUN_STOPPED_WORDS[reason] : reason,
      };
    }
    case 'api_retry':
      return { label: 'The model API failed; retrying', detail: apiRetry(data) };
    case 'stderr':
      return { label: 'The CLI reported an error', detail: text(data, 'text') };
    case 'permission_denied':
      return {
        label: 'A tool was refused',
        detail: joined(text(data, 'tool_name'), text(data, 'message')),
      };
    case 'transcript_normalisation_failed':
      return {
        label: 'An entry could not be recorded',
        detail: joined(text(data, 'entry_kind'), text(data, 'issues')),
      };
    case 'init':
      return {
        label: 'The session started',
        detail: block.model === null ? null : oneLine(block.model),
      };
    case 'informational':
      return { label: 'Notice', detail: text(data, 'content') };
    case 'notification':
      return { label: 'Notice', detail: text(data, 'text') };
    default:
      return { label: `System notice · ${sanitiseUntrusted(block.subtype)}`, detail: null };
  }
};
