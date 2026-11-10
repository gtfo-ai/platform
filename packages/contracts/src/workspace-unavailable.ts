/**
 * **A machine that cannot provision a run's workspace** (S-28.12) — the cause of a worker's
 * `workspace_unavailable` claim blocker, classified from the launcher's error into a closed
 * vocabulary so every screen says it in words.
 *
 * Found on the Autix core (2026-11-10): one machine's Docker had no free address pools (`Docker
 * engine answered 400: all predefined address pools have been fully subnetted`), and that worker
 * claimed and failed six runs in three minutes — faster than the healthy machines could claim —
 * until a task was escalated with *"the run could not be started (RunStartError: workspace_failed)"*.
 * A provisioning failure before the CLI is asked for is the **machine's** fault: the worker hands
 * the run back (`release provision_failed`, which keeps it off that offer), stops claiming with this
 * blocker, and tries again on a backoff.
 *
 * The classifier reads the launcher's words, which are the daemon's — untrusted text. It only
 * matches a few phrases and never repeats them; the raw first line travels separately as `detail`,
 * redacted by the worker and rendered as text (BD-022).
 */
import * as z from 'zod';
import { isoDateTimeSchema } from './common.js';

export const WORKSPACE_UNAVAILABLE_CAUSES = [
  'docker_networks_exhausted',
  'docker_unreachable',
  'image_missing',
  'disk_full',
  'unknown',
] as const;
export const workspaceUnavailableCauseSchema = z.enum(WORKSPACE_UNAVAILABLE_CAUSES);
export type WorkspaceUnavailableCause = z.infer<typeof workspaceUnavailableCauseSchema>;

/**
 * The query a worker adds to its `claims` while its workspace is unavailable — its retry, or its
 * owner's *Try again* (S-28.12): the core lifts the cool-down it set at the hand-back, so this
 * claim may take a run (the probe); the recorded cause stays until a run's CLI is asked for. An
 * older core ignores a query it does not read.
 */
export const WORKER_CLAIMS_WORKSPACE_RETRY_QUERY = 'workspace_retry=1';

/**
 * How long the core keeps a worker that handed a run back for a workspace failure off every offer
 * (S-28.12) unless it retries first — the worker's own first wait, so an immediate re-claim is
 * refused server-side too.
 */
export const WORKSPACE_COOL_DOWN_MS = 60_000;

/** The longest first line of the launcher's error a worker sends and a screen shows. */
export const WORKSPACE_UNAVAILABLE_DETAIL_MAX_CHARS = 500;

/** Why the machine cannot provision a workspace, as the worker reported it. */
export const workspaceUnavailableSchema = z.strictObject({
  cause: workspaceUnavailableCauseSchema,
  /** The launcher error's first line, redacted by the worker — untrusted text. */
  detail: z.string().max(WORKSPACE_UNAVAILABLE_DETAIL_MAX_CHARS).nullable(),
  /** When the worker hit it. */
  since: isoDateTimeSchema,
});
export type WorkspaceUnavailable = z.infer<typeof workspaceUnavailableSchema>;

const RULES: readonly (readonly [WorkspaceUnavailableCause, RegExp])[] = [
  [
    'docker_networks_exhausted',
    /address pools have been fully subnetted|could not find an available, non-overlapping ipv4 address pool|no available network/i,
  ],
  ['disk_full', /no space left on device|disk quota exceeded|not enough space/i],
  [
    'image_missing',
    /no such image|pull access denied|manifest (?:for .* )?unknown|image .* not found|failed to pull|error pulling image/i,
  ],
  [
    'docker_unreachable',
    /cannot connect to the docker daemon|is the docker daemon running|docker engine (?:request timed out|is unreachable|did not answer)|connect econnrefused|enoent .*docker\.sock|engine_unavailable/i,
  ],
];

/**
 * The cause of a launcher error's words — the first rule that matches, else `unknown`. Pure, and
 * the one classifier the worker and the screens share.
 */
export const classifyWorkspaceFailure = (text: string): WorkspaceUnavailableCause => {
  for (const [cause, pattern] of RULES) {
    if (pattern.test(text)) return cause;
  }
  return 'unknown';
};

/** The first non-empty line of `text`, bounded — what `detail` carries. */
export const firstLineOf = (text: string): string | null => {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '');
  return line === undefined ? null : line.slice(0, WORKSPACE_UNAVAILABLE_DETAIL_MAX_CHARS);
};
