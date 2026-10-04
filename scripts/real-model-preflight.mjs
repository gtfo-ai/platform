/**
 * The pieces of `launcher-control-plane-check.mjs --real-model` that need no daemon (WP-140,
 * PROGRESS backlog 137's post-login half, Q115).
 *
 * The leg runs the run image's real `claude` for **one** turn with the product owner's subscription
 * token. Four things about it can be decided without Docker, and they are here so the unit tier can
 * hold them (`real-model-preflight.test.ts`):
 *
 *  - **the gate** ({@link realModelGate}): the flag and the variable go together. The flag without
 *    `CLAUDE_CODE_OAUTH_TOKEN` is a refusal naming the variable; the variable without the flag is a
 *    refusal naming the flag, so the check's other legs never run with a model credential in their
 *    environment. The token is read from the process environment and nowhere else — never argv, a
 *    file or `.env` — and nothing here prints it: its length and the words `set`/`unset` are all a
 *    message may carry;
 *  - **the capture** ({@link captureOutput}): the check's own stdout and stderr, kept so the token can
 *    be looked for in them before the final line is printed;
 *  - **the scan** ({@link containsValue}): a plain substring search, because the leak this guards
 *    against is the value copied verbatim;
 *  - **the host list** ({@link hostsSeenBySidecar}): which hosts the sidecar saw, allowed and
 *    refused, read off a log rendered at `LogLevel Connect`.
 */

/** The flag that runs the leg, and the only way to run it. */
export const REAL_MODEL_FLAG = '--real-model';
/** The one variable the leg reads the credential from (BD-004 `local` mode, TD-020). */
export const REAL_MODEL_TOKEN_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';
/**
 * Below this the production redactor does not replace a value (`MIN_SECRET_LENGTH` in
 * `packages/application/src/integrations/redaction.ts`), so a shorter value is refused rather than
 * sent to a run whose transcript would then carry it.
 */
export const REAL_MODEL_MIN_TOKEN_LENGTH = 8;
/** The fixed prompt of the one turn (WP-140 ruling (c)). */
export const REAL_MODEL_PROMPT = 'Reply with the single word OK.';
/** The leg's wall clock (WP-140 ruling (c)): one turn, two minutes. */
export const REAL_MODEL_WALL_CLOCK_MS = 120_000;

const CHECK = 'launcher-control-plane-check';

/**
 * The gate. `argv` is the arguments after the script name; `env` is the process environment.
 *
 * An empty variable counts as unset: the shell that exports `CLAUDE_CODE_OAUTH_TOKEN=` has given
 * nothing, and a run would fail authentication on it for a reason the message would not name.
 */
export const realModelGate = (argv, env) => {
  const flag = argv.includes(REAL_MODEL_FLAG);
  const value = env[REAL_MODEL_TOKEN_VARIABLE];
  const set = typeof value === 'string' && value.length > 0;
  if (flag && !set) {
    return {
      kind: 'refused',
      message: `FAIL: ${CHECK} ${REAL_MODEL_FLAG} — refused: ${REAL_MODEL_TOKEN_VARIABLE} is unset. The real-model leg reads the subscription token from this process' environment and nowhere else (not argv, not a file, not .env); export it in the shell that runs the check.`,
    };
  }
  if (!flag && set) {
    return {
      kind: 'refused',
      message: `FAIL: ${CHECK} — refused: ${REAL_MODEL_TOKEN_VARIABLE} is set (length ${String(value.length)}) and ${REAL_MODEL_FLAG} was not given. Only the real-model leg may run with a model credential in the environment: pass ${REAL_MODEL_FLAG} to run that leg alone, or unset ${REAL_MODEL_TOKEN_VARIABLE} to run the other legs.`,
    };
  }
  if (!flag) {
    return { kind: 'off' };
  }
  if (value.length < REAL_MODEL_MIN_TOKEN_LENGTH) {
    return {
      kind: 'refused',
      message: `FAIL: ${CHECK} ${REAL_MODEL_FLAG} — refused: ${REAL_MODEL_TOKEN_VARIABLE} is set (length ${String(value.length)}), shorter than the ${String(REAL_MODEL_MIN_TOKEN_LENGTH)} characters the run's redactor replaces, so its transcript could carry it.`,
    };
  }
  return { kind: 'on', tokenLength: value.length };
};

/** Does `text` contain `value`? `false` for an empty value, which would match everything. */
export const containsValue = (text, value) =>
  typeof value === 'string' && value.length > 0 && String(text).includes(value);

/**
 * Wraps `stream.write` of each stream so everything written is also kept, and returns the text so
 * far on demand. The original writer still writes: the capture observes, it never swallows.
 */
export const captureOutput = (streams) => {
  const chunks = [];
  for (const stream of streams) {
    const original = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return original(chunk, ...rest);
    };
  }
  return { text: () => chunks.join('') };
};

const hostOfTarget = (method, target) => {
  if (method === 'CONNECT') {
    const host = target.replace(/:\d+$/, '');
    return host.length > 0 ? host.toLowerCase() : null;
  }
  try {
    return new URL(target).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
};

/**
 * The hosts in a sidecar's log rendered at `LogLevel Connect`, as `{ seen, allowed, refused }`.
 *
 * tinyproxy writes each request's line at `Connect` — `Request (file descriptor 6): CONNECT
 * api.anthropic.com:443 HTTP/1.1` — whether or not the filter then admits it, and *"Proxying refused
 * on filtered domain "<host>""* at `Notice` for each one it refuses. So `seen` is every request
 * line's host, `refused` every refusal's, and `allowed` what was seen and never refused. A log
 * rendered at `Notice` has no request lines, and `seen` is then the refusals alone — which is why
 * the leg asserts the configuration it ran under rather than trusting an empty `allowed`.
 */
export const hostsSeenBySidecar = (lines) => {
  const seen = new Set();
  const refused = new Set();
  for (const line of lines ?? []) {
    const request = /Request \(file descriptor \d+\): ([A-Z]+) (\S+)/.exec(line);
    if (request !== null) {
      const host = hostOfTarget(request[1], request[2]);
      if (host !== null) {
        seen.add(host);
      }
    }
    const refusal = /filtered domain "?([^"\s]+)"?/.exec(line);
    if (refusal !== null) {
      refused.add(refusal[1].toLowerCase());
      seen.add(refusal[1].toLowerCase());
    }
  }
  const sorted = (set) => [...set].sort();
  return {
    seen: sorted(seen),
    allowed: sorted(seen).filter((host) => !refused.has(host)),
    refused: sorted(refused),
  };
};
