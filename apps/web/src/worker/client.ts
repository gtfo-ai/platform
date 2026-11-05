/**
 * The worker's local page's half of `/api/local/*` (WP-292, TD-031's worker-UI amendment §2).
 *
 * **By default there is no token** (`APP_WORKER_UI_AUTH=none`, TD-031's 2026-11-05 no-bearer
 * amendment): the page opens at `http://127.0.0.1:7357` and sends no `Authorization`. Under `token`
 * **the token arrives in the fragment** (`#token=…`), which no browser sends in a request line: it
 * is moved to `sessionStorage` and stripped from the address on load, then sent as
 * `Authorization: Bearer` on every call; a `401` means the page was opened without it. No cookie, no credentials mode — the page and the API are
 * one origin, and the worker sends no CORS header. A mutating call is a `POST`, which the browser
 * sends with this page's `Origin`; the worker refuses any other.
 *
 * Every answer is checked at this boundary by `read-state.ts` — strictly, against the shapes the
 * worker serialises with — and refused, never repaired. (Not with zod: the page's budget, stated
 * there.)
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
import {
  LOCAL_API_PREFIX,
  readCancel,
  readClaimScope,
  readCoreCheck,
  readError,
  readErrorReportingTest,
  readOffers,
  readState,
  readTake,
} from './read-state.js';

/** Where the token is kept for this tab (cleared with it). */
export const TOKEN_STORAGE_KEY = 'agentic-worker-ui-token';

/** 32 bytes, unpadded base64url — the worker's `ui-token`. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface TokenPlace {
  readonly hash: string;
  readonly stored: () => string | null;
  readonly store: (token: string) => void;
  /** Removes the fragment from the address bar without a navigation. */
  readonly stripHash: () => void;
}

/** The browser's own places: `location.hash`, `sessionStorage`, `history.replaceState`. */
export const browserTokenPlace = (): TokenPlace => ({
  hash: window.location.hash,
  stored: () => window.sessionStorage.getItem(TOKEN_STORAGE_KEY),
  store: (token) => window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token),
  stripHash: () =>
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`),
});

/**
 * The token: from the fragment when it carries one (stored, and the fragment stripped), else the
 * one this tab stored; `null` when there is neither.
 */
export const takeToken = (place: TokenPlace): string | null => {
  const match = /(?:^#|&)token=([^&]*)/.exec(place.hash);
  if (match !== null) {
    place.stripHash();
    const token = match[1] ?? '';
    if (TOKEN_SHAPE.test(token)) {
      place.store(token);
      return token;
    }
  }
  const stored = place.stored();
  return stored !== null && TOKEN_SHAPE.test(stored) ? stored : null;
};

/** A refusal the worker answered, in its words (already redacted there). */
export class LocalCallError extends Error {
  override readonly name = 'LocalCallError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface LocalClient {
  state(): Promise<WorkerLocalState>;
  pause(paused: boolean): Promise<WorkerLocalState>;
  drain(): Promise<WorkerLocalState>;
  cancel(runId: string, idempotencyKey: string): Promise<WorkerLocalCancelResponse>;
  /** The claim scope and the projects it may name (WP-293). */
  claimScope(): Promise<WorkerLocalClaimScope>;
  /** Set the claim scope: `null` every project, `[]` pick only, otherwise those projects. */
  setClaimScope(projectIds: readonly string[] | null): Promise<WorkerLocalClaimScope>;
  /** What this worker could take now (WP-293). */
  offers(): Promise<WorkerLocalOffers>;
  /** *Take this one* (WP-293). */
  take(runId: string): Promise<WorkerLocalTakeResponse>;
  // The first-run wizard (WP-294): each answers the worker's state after it.
  checkCore(url: string): Promise<WorkerLocalCoreCheckResponse>;
  setCore(url: string | null): Promise<WorkerLocalState>;
  signIn(action: 'start' | 'cancel'): Promise<WorkerLocalState>;
  claudeCode(code: string): Promise<WorkerLocalState>;
  claudeToken(token: string): Promise<WorkerLocalState>;
  signOut(): Promise<WorkerLocalState>;
  connectAgain(): Promise<WorkerLocalState>;
  retry(): Promise<WorkerLocalState>;
  // The *Error reporting* setting (WP-295).
  /** *Save* a DSN, or *Remove* it with `null`; answers the state (never the DSN). */
  setErrorReporting(dsn: string | null): Promise<WorkerLocalState>;
  /** *Send a test error*. */
  testErrorReporting(): Promise<WorkerLocalErrorReportingTestResponse>;
}

export const createLocalClient = (
  /** The page's bearer under `APP_WORKER_UI_AUTH=token`; `null` sends none (the default). */
  token: string | null,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): LocalClient => {
  const call = async <T>(
    method: 'GET' | 'POST',
    verb: string,
    read: (value: unknown) => T | null,
    extra: { readonly body?: unknown; readonly headers?: Record<string, string> } = {},
  ): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${LOCAL_API_PREFIX}/${verb}`, {
        method,
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          ...extra.headers,
        },
        ...(method === 'POST' ? { body: JSON.stringify(extra.body ?? {}) } : {}),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
    } catch (error) {
      throw new LocalCallError(
        0,
        'unreachable',
        `the worker did not answer (${(error as Error).message}) — is it still running?`,
      );
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const refusal = readError(json);
      throw new LocalCallError(
        response.status,
        refusal?.code ?? 'failed',
        refusal?.message ?? `the worker answered ${response.status}`,
      );
    }
    const answer = read(json);
    if (answer === null) {
      throw new LocalCallError(
        response.status,
        'unreadable',
        'the worker’s answer is not one this page can read — reload it',
      );
    }
    return answer;
  };
  return {
    state: () => call('GET', 'state', readState),
    pause: (paused) => call('POST', 'pause', readState, { body: { paused } }),
    drain: () => call('POST', 'drain', readState),
    cancel: (runId, idempotencyKey) =>
      call('POST', `runs/${encodeURIComponent(runId)}/cancel`, readCancel, {
        headers: { 'idempotency-key': idempotencyKey },
      }),
    claimScope: () => call('GET', 'claim-scope', readClaimScope),
    setClaimScope: (projectIds) =>
      call('POST', 'claim-scope', readClaimScope, {
        body: { claim_project_ids: projectIds === null ? null : [...projectIds] },
      }),
    offers: () => call('GET', 'offers', readOffers),
    take: (runId) => call('POST', `offers/${encodeURIComponent(runId)}/take`, readTake),
    checkCore: (url) => call('POST', 'core/check', readCoreCheck, { body: { url } }),
    setCore: (url) => call('POST', 'core', readState, { body: { url } }),
    signIn: (action) => call('POST', 'claude/sign-in', readState, { body: { action } }),
    claudeCode: (code) => call('POST', 'claude/code', readState, { body: { code } }),
    claudeToken: (value) => call('POST', 'claude/token', readState, { body: { token: value } }),
    signOut: () => call('POST', 'claude/sign-out', readState),
    connectAgain: () => call('POST', 'connect-again', readState),
    retry: () => call('POST', 'retry', readState),
    setErrorReporting: (dsn) => call('POST', 'error-reporting', readState, { body: { dsn } }),
    testErrorReporting: () => call('POST', 'error-reporting/test', readErrorReportingTest),
  };
};
