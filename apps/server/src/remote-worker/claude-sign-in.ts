/**
 * **Sign in to Claude from the local page** — WP-294 (4), TD-031's 2026-11-05 first-run amendment §4.
 *
 * The official CLI, never a re-implementation of Anthropic's OAuth client: `claude setup-token` from
 * the `claude-cli` volume (the run image's own binary, `APP_WORKER_CLAUDE_CLI`), run **under a pty**
 * — `script(1)` from util-linux, which the `platform` image carries — because the CLI prints nothing
 * without a terminal and exits when its stdin closes (V-WM10, research/17 § 13). It runs with:
 *
 *  - an environment **scrubbed** of every token variable: `PATH`, a fresh temporary `HOME` and
 *    `CLAUDE_CONFIG_DIR` (deleted afterwards), `TERM`, a locale — nothing of the worker's own;
 *  - a **wide terminal** (500 columns), so the token is printed on one line;
 *  - **one session at a time**, a ten-minute cap, and *Cancel*.
 *
 * What it reads off the screen, and nothing else (the screen text is not a contract — the measured
 * transcript is replayed by `claude-sign-in.test.ts` and re-measured at every CLI pin bump, and
 * *Paste a token instead* always works):
 *
 *  - the **sign-in address**, offered only when it is `https:` on {@link CLAUDE_SIGN_IN_HOSTS};
 *  - the **paste prompt** (*Paste code here if prompted*): the container's localhost callback can
 *    never complete, so pasting the code is the route;
 *  - the **token**, by shape (`sk-ant-oat01-…`), joined across a wrapped line if a terminal wrapped it.
 *
 * **Nothing the CLI prints is logged**, and the pasted code and the token are handed to the
 * worker's exact-value redactor (`onSecret`) the moment they are known. The token is then **checked
 * once** with the cheapest call V-WM10 found that proves it — `claude auth status` reads the variable
 * and answers `loggedIn: true` for any string, so it proves nothing; one no-tool, one-turn `claude -p`
 * answers `api_error_status: 401` for a token Claude refuses — and only a token Claude accepted is
 * handed to `onToken` (which stores it `claude-token`, 0600, atomically).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@platform/application';
import type { WorkerLocalSignInFailure, WorkerLocalSignInPhase } from '@platform/contracts';

/**
 * The hosts a sign-in address may name (V-WM10, measured 2026-11-05 with CLI 2.1.267: the CLI
 * prints `https://claude.com/cai/oauth/authorize?…` whose redirect is `platform.claude.com`; the
 * other two are the hosts Anthropic's sign-in has used, kept so a CLI bump that moves back is not
 * a refusal). Exact names only, `https:` only.
 */
export const CLAUDE_SIGN_IN_HOSTS: readonly string[] = [
  'claude.com',
  'claude.ai',
  'platform.claude.com',
  'console.anthropic.com',
];

/** The token the CLI prints: the owner's run printed 108 characters (`sk-ant-oat01-` + 95). */
export const CLAUDE_TOKEN_PREFIX = 'sk-ant-oat01-';
export const CLAUDE_TOKEN_LENGTH = 108;

/** One sign-in's cap (TD-031's first-run amendment §4). */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** The token check's cap: one turn, no tools. */
export const TOKEN_CHECK_TIMEOUT_MS = 120_000;
/** How much of the CLI's screen output is kept to read — the tail, which is where the token is. */
const OUTPUT_KEEP_CHARS = 256 * 1024;

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: the terminal's escape and control
// characters are exactly what this reader removes.
/** The CLI's screen bytes as the text a person would read: escapes out, column moves as spaces. */
export const renderTerminalText = (raw: string): string =>
  raw
    // OSC (a hyperlink's target, a title): its visible text follows it, so the target is dropped.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // A cursor move to a column or forward is how Ink spaces words.
    .replace(/\x1b\[\d*[GC]/g, ' ')
    .replace(/\x1b\[[0-9;?<>=]*[A-Za-z]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[78=>cM]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: see above.

/** The sign-in address the screen shows, if it is `https:` on an Anthropic host; else `null`. */
export const signInUrlOf = (text: string): string | null => {
  for (const match of text.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    let parsed: URL;
    try {
      parsed = new URL(match[0]);
    } catch {
      continue;
    }
    if (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === '' &&
      CLAUDE_SIGN_IN_HOSTS.includes(parsed.hostname) &&
      /oauth/i.test(parsed.pathname) &&
      parsed.href.length <= 4_096
    ) {
      return parsed.href;
    }
  }
  return null;
};

/** Whether the screen asks for the code Claude's page shows. */
export const asksForCode = (text: string): boolean => /paste\s+code\s+here/i.test(text);

/** Whether the screen says Claude refused the pasted code. */
export const refusedCode = (text: string): boolean => /oauth\s+error|invalid\s+code/i.test(text);

const TOKEN_BODY = /^[A-Za-z0-9_-]+/;

/**
 * The token on the screen, by shape — joined across a line break **only** while it is shorter than
 * {@link CLAUDE_TOKEN_LENGTH} and its line ended at the token, which is what a terminal's wrap
 * looks like (the owner's 80-column run printed 79 + 29 characters, measured 2026-11-05).
 *
 * **Complete, or `null`** (review of PR #42): the screen arrives in chunks and this is read after
 * each, so a token is taken only once it is {@link CLAUDE_TOKEN_LENGTH} characters long, or once
 * more output has followed it (the CLI's next words) — never at a chunk boundary inside it, and
 * never at a line break that may still be a wrap whose next line has not arrived.
 */
export const tokenOf = (text: string): string | null => {
  const start = text.lastIndexOf(CLAUDE_TOKEN_PREFIX);
  if (start < 0) return null;
  const lines = text.slice(start).split('\n');
  let token = (TOKEN_BODY.exec(lines[0] ?? '') ?? [''])[0];
  let endedAtToken = (lines[0] ?? '').trimEnd() === token;
  /** The line the token's last piece is on, and how much of it the piece took. */
  let lastLine = 0;
  let lastLineConsumed = (lines[0] ?? '').indexOf(token) + token.length;
  for (let index = 1; index < lines.length && endedAtToken; index += 1) {
    if (token.length >= CLAUDE_TOKEN_LENGTH) break;
    const raw = lines[index] ?? '';
    const line = raw.trim();
    const piece = (TOKEN_BODY.exec(line) ?? [''])[0];
    if (piece === '') break;
    const taken = piece.slice(0, CLAUDE_TOKEN_LENGTH - token.length);
    token += taken;
    endedAtToken = line === piece;
    lastLine = index;
    lastLineConsumed = raw.indexOf(piece) + taken.length;
  }
  if (!/^sk-ant-oat01-[A-Za-z0-9_-]{40,400}$/.test(token)) return null;
  if (token.length >= CLAUDE_TOKEN_LENGTH) return token;
  // Shorter than measured: only once something that is not the token has followed it.
  const rest = [(lines[lastLine] ?? '').slice(lastLineConsumed), ...lines.slice(lastLine + 1)].join(
    '\n',
  );
  return /\S/.test(rest) && !/^[A-Za-z0-9_-]/.test(rest) ? token : null;
};

/** The check's verdict (V-WM10): Claude accepted it, refused it, or could not be asked. */
export type TokenCheck = 'accepted' | 'rejected' | 'unknown';

/** Reads `claude -p --output-format json`'s answer: the last line that parses as its result. */
export const tokenCheckOf = (stdout: string): TokenCheck => {
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const result = parsed as { type?: unknown; is_error?: unknown; api_error_status?: unknown };
    if (result.type !== 'result') continue;
    if (result.is_error === false) return 'accepted';
    if (result.api_error_status === 401 || result.api_error_status === 403) return 'rejected';
    return 'unknown';
  }
  return 'unknown';
};

/** A started CLI: its output, its stdin, and the way to end it (the whole process group). */
export interface LaunchedCli {
  readonly child: ChildProcess;
  readonly kill: () => void;
}

/** How the sign-in starts the CLI and runs the check — a seam for the process test's fake `claude`. */
export interface ClaudeCliLauncher {
  /** `claude setup-token` under a pty. */
  readonly setupToken: (env: Readonly<Record<string, string>>) => LaunchedCli;
  /** `claude <args>` with no terminal and no stdin; answers its stdout (bounded) and exit code. */
  readonly run: (
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    timeoutMs: number,
  ) => Promise<{ readonly stdout: string; readonly code: number | null }>;
}

const killGroup = (child: ChildProcess): void => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
};

/** Runs `command args` detached (its own process group), stdin closed, stdout bounded. */
export const runBounded = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<{ readonly stdout: string; readonly code: number | null }> =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      env: { ...env },
      // Its temporary home, never the worker's working directory (review of PR #42).
      ...(env.HOME === undefined ? {} : { cwd: env.HOME }),
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    const timer = setTimeout(() => killGroup(child), timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, code });
    });
  });

/**
 * The production launcher: `script -q -f -E never -c "stty cols 500 rows 50; exec <cli>
 * setup-token" /dev/null` (util-linux; measured in the `platform` image, V-WM10). `cliPath` is
 * validated as plain path characters at configuration (`config.ts`), so quoting it is enough.
 */
export const scriptCliLauncher = (cliPath: string): ClaudeCliLauncher => ({
  setupToken: (env) => {
    const child = spawn(
      'script',
      [
        '-q',
        '-f',
        '-E',
        'never',
        '-c',
        `stty cols 500 rows 50 2>/dev/null; exec '${cliPath}' setup-token`,
        '/dev/null',
      ],
      {
        env: { ...env },
        ...(env.HOME === undefined ? {} : { cwd: env.HOME }),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      },
    );
    return { child, kill: () => killGroup(child) };
  },
  run: (args, env, timeoutMs) => runBounded(cliPath, args, env, timeoutMs),
});

/** The CLI's environment: nothing of the worker's own — no token variable reaches it. */
export const scrubbedCliEnvironment = (
  home: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: home,
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  TERM: 'xterm-256color',
  LANG: 'C.UTF-8',
  COLUMNS: '500',
  LINES: '50',
  DISABLE_AUTOUPDATER: '1',
  ...extra,
});

export interface ClaudeSignInStatus {
  readonly phase: WorkerLocalSignInPhase;
  readonly url: string | null;
  readonly failure: WorkerLocalSignInFailure | null;
}

export interface ClaudeSignInOptions {
  readonly launcher: ClaudeCliLauncher;
  readonly logger: Logger;
  /** A secret to redact from now on — the pasted code, the token (`runtime.ts`'s log secrets). */
  readonly onSecret: (name: string, value: string) => void;
  /** A token Claude accepted: store it and use it (`runtime.ts`). */
  readonly onToken: (token: string) => Promise<void>;
  readonly timeoutMs?: number;
}

export class SignInBusyError extends Error {
  override readonly name = 'SignInBusyError';
}

export interface ClaudeSignIn {
  status(): ClaudeSignInStatus;
  /** Starts `claude setup-token`; refused while one runs or a check is in flight. */
  start(): Promise<void>;
  /** Ends the session (or forgets a failure). */
  cancel(): void;
  /** Writes the code Claude's page showed to the CLI; refused unless it asked for one. */
  submitCode(code: string): void;
  /** Checks a pasted token, in the background; refused while a session or a check runs. */
  acceptToken(token: string): void;
  /** Ends whatever runs and waits for its files to be removed. */
  close(): Promise<void>;
}

export const createClaudeSignIn = (options: ClaudeSignInOptions): ClaudeSignIn => {
  let phase: WorkerLocalSignInPhase = 'idle';
  let url: string | null = null;
  let failure: WorkerLocalSignInFailure | null = null;
  let session: {
    readonly cli: LaunchedCli;
    readonly home: string;
    output: string;
    codeAt: number | null;
    done: boolean;
    readonly finished: Promise<void>;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let checking: Promise<void> | null = null;
  let generation = 0;

  const fail = (why: WorkerLocalSignInFailure): void => {
    phase = 'failed';
    failure = why;
    url = null;
  };

  const endSession = (): void => {
    const current = session;
    if (current === null) return;
    session = null;
    current.done = true;
    clearTimeout(current.timer);
    current.cli.kill();
  };

  const check = (token: string): void => {
    phase = 'checking';
    failure = null;
    url = null;
    const mine = generation;
    checking = (async () => {
      const home = await mkdtemp(path.join(tmpdir(), 'claude-check-'));
      let verdict: TokenCheck = 'unknown';
      try {
        const answer = await options.launcher.run(
          [
            '-p',
            'Reply with the single word OK.',
            '--max-turns',
            '1',
            '--tools',
            '',
            '--output-format',
            'json',
          ],
          scrubbedCliEnvironment(home, { CLAUDE_CODE_OAUTH_TOKEN: token }),
          TOKEN_CHECK_TIMEOUT_MS,
        );
        verdict = tokenCheckOf(answer.stdout);
      } catch {
        verdict = 'unknown';
      } finally {
        await rm(home, { recursive: true, force: true }).catch(() => undefined);
      }
      if (mine !== generation) return;
      if (verdict === 'accepted') {
        try {
          await options.onToken(token);
          phase = 'idle';
          failure = null;
          options.logger.info({}, 'Claude accepted the sign-in; this worker uses it from now on');
        } catch (error) {
          options.logger.error({ err: error }, 'the Claude token could not be stored');
          fail('check_failed');
        }
        return;
      }
      options.logger.warn(
        { verdict },
        verdict === 'rejected'
          ? 'Claude did not accept the token; nothing is stored'
          : 'the Claude token could not be checked; nothing is stored',
      );
      fail(verdict === 'rejected' ? 'token_rejected' : 'check_failed');
    })().finally(() => {
      checking = null;
    });
  };

  const read = (): void => {
    const current = session;
    if (current === null || current.done) return;
    const text = renderTerminalText(current.output);
    if (current.codeAt === null) {
      url ??= signInUrlOf(text);
      if (asksForCode(text) && phase === 'starting') phase = 'waiting_for_code';
      return;
    }
    const after = renderTerminalText(current.output.slice(current.codeAt));
    const token = tokenOf(after);
    if (token !== null) {
      options.onSecret('claude_code_oauth_token_signed_in', token);
      endSession();
      check(token);
      return;
    }
    if (refusedCode(after)) {
      endSession();
      fail('code_refused');
    }
  };

  const busy = (): boolean => session !== null || checking !== null;

  return {
    status: () => ({ phase, url, failure }),
    start: async () => {
      if (busy()) throw new SignInBusyError('a sign-in is already running');
      generation += 1;
      phase = 'starting';
      failure = null;
      url = null;
      const home = await mkdtemp(path.join(tmpdir(), 'claude-sign-in-'));
      let cli: LaunchedCli;
      try {
        cli = options.launcher.setupToken(scrubbedCliEnvironment(home));
      } catch {
        await rm(home, { recursive: true, force: true }).catch(() => undefined);
        fail('cli_unavailable');
        return;
      }
      let resolveFinished: () => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      const current = {
        cli,
        home,
        output: '',
        codeAt: null as number | null,
        done: false,
        finished,
        timer: setTimeout(() => {
          if (session === current) {
            endSession();
            fail('timed_out');
          }
        }, options.timeoutMs ?? SIGN_IN_TIMEOUT_MS),
      };
      session = current;
      const take = (chunk: Buffer | string): void => {
        current.output += chunk.toString();
        if (current.output.length > OUTPUT_KEEP_CHARS) {
          const cut = current.output.length - OUTPUT_KEEP_CHARS;
          current.output = current.output.slice(cut);
          if (current.codeAt !== null) current.codeAt = Math.max(0, current.codeAt - cut);
        }
        read();
      };
      // Read, never logged (amendment §4): the screen goes to `read` and nowhere else.
      cli.child.stdout?.on('data', take);
      cli.child.stderr?.on('data', take);
      cli.child.stdin?.on('error', () => undefined);
      const ended = (spawnFailed: boolean): void => {
        if (session === current) {
          session = null;
          clearTimeout(current.timer);
          fail(spawnFailed ? 'cli_unavailable' : 'cli_ended');
        }
        void rm(home, { recursive: true, force: true })
          .catch(() => undefined)
          .finally(resolveFinished);
      };
      cli.child.on('error', () => ended(true));
      cli.child.on('close', () => ended(false));
    },
    cancel: () => {
      generation += 1;
      endSession();
      phase = 'idle';
      failure = null;
      url = null;
    },
    submitCode: (code) => {
      const current = session;
      if (current === null || phase !== 'waiting_for_code') {
        throw new SignInBusyError('the sign-in is not waiting for a code');
      }
      const trimmed = code.trim();
      options.onSecret('claude_sign_in_code', trimmed);
      current.codeAt = current.output.length;
      phase = 'checking';
      current.cli.child.stdin?.write(`${trimmed}\r`);
    },
    acceptToken: (token) => {
      if (busy()) throw new SignInBusyError('a sign-in is already running');
      generation += 1;
      options.onSecret('claude_code_oauth_token_pasted', token);
      check(token);
    },
    close: async () => {
      generation += 1;
      const current = session;
      endSession();
      await current?.finished;
      await checking;
    },
  };
};
