/**
 * **Sign in to Claude, the worker's half** — WP-294 (4), V-WM10.
 *
 * The screen readers over V-WM10's **recorded** `claude setup-token` bytes (the address, the paste
 * prompt, a refused code) and the **composed** success screen (`test/fixtures/claude-cli/
 * setup-token.transcript.json`, whose `source` block says which is which), and the whole sign-in
 * against a fake `claude` that replays them as a real child process: the address offered only on an
 * Anthropic host, the code written to the CLI's stdin, the token captured by shape, checked once
 * with `claude -p` and handed on only when accepted — in an environment with no token variable of
 * the worker's, a temporary `HOME` that is gone afterwards, and nothing of the screen in any log.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { normaliseClaudeToken } from '@platform/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asLoggerPort, createLogger } from '../logging.js';
import {
  AFTER_CODE_TIMEOUT_MS,
  asksForCode,
  type ClaudeCliLauncher,
  type ClaudeSignIn,
  createClaudeSignIn,
  InvalidClaudeTokenError,
  looseTokenOf,
  refusedCode,
  renderTerminalText,
  runBounded,
  SignInBusyError,
  scrubbedCliEnvironment,
  signInUrlOf,
  tokenCheckOf,
  tokenOf,
} from './claude-sign-in.js';

const FIXTURE_DIR = path.join(process.cwd(), 'test/fixtures/claude-cli');
const FAKE_CLAUDE = path.join(FIXTURE_DIR, 'fake-claude.mjs');
const fixture = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, 'setup-token.transcript.json'), 'utf8'),
) as {
  readonly good_code: string;
  readonly token: string;
  readonly screen: string;
  readonly after_refused_code: string;
  readonly after_good_code: string;
};

describe('reading the CLI’s screen (V-WM10)', () => {
  it('finds the sign-in address on claude.com and the paste prompt in the recorded screen', () => {
    const text = renderTerminalText(fixture.screen);
    expect(text).toContain('Welcome to Claude Code');
    const url = signInUrlOf(text);
    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.hostname).toBe('claude.com');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://platform.claude.com/oauth/code/callback',
    );
    expect(asksForCode(text)).toBe(true);
    expect(tokenOf(text)).toBeNull();
  });

  it('offers no address that is not https on an Anthropic host', () => {
    for (const text of [
      'open http://claude.com/cai/oauth/authorize?x=1',
      'open https://claude.com.evil.example/cai/oauth/authorize',
      'open https://user:pw@claude.ai/oauth/authorize',
      'open https://claude.ai:8443/oauth/authorize',
      'open https://claude.ai/not-a-sign-in',
    ]) {
      expect(signInUrlOf(text), text).toBeNull();
    }
    expect(signInUrlOf('go to https://claude.ai/oauth/authorize?code=true now')).toBe(
      'https://claude.ai/oauth/authorize?code=true',
    );
  });

  it('reads a refused code in the recorded bytes, and the token in the composed ones', () => {
    expect(refusedCode(renderTerminalText(fixture.after_refused_code))).toBe(true);
    const success = renderTerminalText(fixture.after_good_code);
    expect(refusedCode(success)).toBe(false);
    expect(tokenOf(success)).toBe(fixture.token);
    expect(fixture.token).toHaveLength(108);
  });

  it('joins a token a terminal wrapped (79 + 29, measured), and nothing after it', () => {
    const token = fixture.token;
    const wrapped = `Your OAuth token:\n\n${token.slice(0, 79)}\n${token.slice(79)}\n\nStore this token securely.`;
    expect(tokenOf(wrapped)).toBe(token);
    // Indented continuation lines are a wrap too.
    expect(tokenOf(` ${token.slice(0, 79)}\n ${token.slice(79)}\n`)).toBe(token);
    // Joined only up to the measured length: words that follow are never part of it.
    expect(tokenOf(`${token}\nStore this token`)).toBe(token);
    expect(tokenOf('sk-ant-oat01-short and more')).toBeNull();
  });

  it('never takes a token cut by a chunk boundary, or a wrap whose next line has not arrived (review of PR #42)', () => {
    const token = fixture.token;
    // Mid-token, on one line: nothing has followed it yet.
    expect(tokenOf(`Your OAuth token:\n\n ${token.slice(0, 60)}`)).toBeNull();
    // The wrap's first line and its break, the second line not here yet.
    expect(tokenOf(`Your OAuth token:\n\n${token.slice(0, 79)}\n`)).toBeNull();
    expect(
      tokenOf(`Your OAuth token:\n\n${token.slice(0, 79)}\n${token.slice(79, 90)}`),
    ).toBeNull();
    // The measured length is complete as soon as it is all there.
    expect(tokenOf(`${token.slice(0, 79)}\n${token.slice(79)}`)).toBe(token);
    // A shorter token is taken once the CLI's next words followed it.
    const short = `sk-ant-oat01-${'Q'.repeat(60)}`;
    expect(tokenOf(`${short}`)).toBeNull();
    expect(tokenOf(`${short}\n\nStore this token securely.`)).toBe(short);
  });

  it('reads a token whitespace-insensitively when tokenOf cannot: split by spaces, by a cursor move, by an indented wrap', () => {
    const token = fixture.token;
    // A space Ink drew inside it: the first piece is too short for tokenOf.
    const spaced = `Your OAuth token: ${token.slice(0, 30)} ${token.slice(30, 70)}  ${token.slice(70)}\n`;
    expect(tokenOf(spaced)).toBeNull();
    expect(looseTokenOf(spaced)).toBe(token);
    // A cursor move to the right, rendered as a space.
    const moved = renderTerminalText(`${token.slice(0, 25)}\x1b[1C${token.slice(25)}\r\n`);
    expect(tokenOf(moved)).toBeNull();
    expect(looseTokenOf(moved)).toBe(token);
    // A wrap whose continuation is indented, with a space inside the first line.
    const wrapped = `${token.slice(0, 20)} ${token.slice(20, 79)}\n      ${token.slice(79)}\n\nStore it.`;
    expect(looseTokenOf(wrapped)).toBe(token);
    // Never before the measured length is on the screen, and never past it.
    expect(looseTokenOf(`${token.slice(0, 25)} ${token.slice(25, 100)}`)).toBeNull();
    expect(looseTokenOf(`${token} Store`)).toBe(token);
    // It stops at anything that is neither the token nor whitespace.
    expect(looseTokenOf(`${token.slice(0, 50)}│${token.slice(50)}`)).toBeNull();
    expect(looseTokenOf('no token here')).toBeNull();
  });

  it('normalises a pasted token: every whitespace inside it removed', () => {
    const token = fixture.token;
    expect(normaliseClaudeToken(`  ${token.slice(0, 79)}\r\n\t   ${token.slice(79)}\n`)).toBe(
      token,
    );
    expect(normaliseClaudeToken(' \n ')).toBe('');
  });

  it('reads the check’s verdict as the CLI states it', () => {
    expect(tokenCheckOf('{"type":"result","is_error":false,"result":"OK"}\n')).toBe('accepted');
    // V-WM10's measured refusal: `api_error_status: 401`, `is_error: true`.
    expect(
      tokenCheckOf('{"type":"result","is_error":true,"api_error_status":401,"result":"x"}'),
    ).toBe('rejected');
    expect(tokenCheckOf('{"type":"result","is_error":true,"api_error_status":529}')).toBe(
      'unknown',
    );
    expect(tokenCheckOf('not json')).toBe('unknown');
  });

  it('scrubs the environment: nothing of the worker’s own, a temporary HOME, a wide terminal', () => {
    const env = scrubbedCliEnvironment('/tmp/claude-sign-in-x');
    expect(Object.keys(env).sort()).toEqual(
      [
        'CLAUDE_CONFIG_DIR',
        'COLUMNS',
        'DISABLE_AUTOUPDATER',
        'HOME',
        'LANG',
        'LINES',
        'PATH',
        'TERM',
      ].sort(),
    );
    expect(env.HOME).toBe('/tmp/claude-sign-in-x');
    expect(env.COLUMNS).toBe('500');
  });
});

/** The fake `claude` as a real child process, with the environment it was given recorded. */
const fakeLauncher = () => {
  const environments: Record<string, string>[] = [];
  const launcher: ClaudeCliLauncher = {
    setupToken: (env) => {
      environments.push({ ...env });
      const child = spawn(process.execPath, [FAKE_CLAUDE, 'setup-token'], {
        env: { ...env },
        cwd: env.HOME,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      return {
        child,
        kill: () => {
          try {
            process.kill(-(child.pid as number), 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        },
      };
    },
    run: (args, env, timeoutMs) => {
      environments.push({ ...env });
      return runBounded(process.execPath, [FAKE_CLAUDE, ...args], env, timeoutMs);
    },
  };
  return { launcher, environments };
};

const until = async (what: string, check: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 500; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('the sign-in against a fake claude replaying V-WM10 (WP-294 (4))', () => {
  let signIn: ClaudeSignIn | null = null;
  afterEach(async () => {
    await signIn?.close();
    signIn = null;
  });

  const start = () => {
    const lines: string[] = [];
    const logger = asLoggerPort(
      createLogger({
        level: 'debug',
        format: 'json',
        role: 'remote-worker',
        destination: { write: (line: string) => lines.push(line) },
      }),
    );
    const secrets: string[] = [];
    const stored: string[] = [];
    const fake = fakeLauncher();
    signIn = createClaudeSignIn({
      launcher: fake.launcher,
      logger,
      onSecret: (_name, value) => secrets.push(value),
      onToken: async (token) => {
        stored.push(token);
      },
    });
    return { signIn, lines, secrets, stored, environments: fake.environments };
  };

  it('offers the address, writes the pasted code to the CLI, captures the token, checks it once and hands it on', async () => {
    const { signIn: session, lines, secrets, stored, environments } = start();
    await session.start();
    await until('the paste prompt', () => session.status().phase === 'waiting_for_code');
    expect(new URL(session.status().url as string).hostname).toBe('claude.com');
    session.submitCode(fixture.good_code);
    await until('the token is stored', () => stored.length === 1);
    expect(stored).toEqual([fixture.token]);
    expect(session.status()).toEqual({ phase: 'idle', url: null, failure: null });
    // The code and the token were handed to the redactor before anything else saw them.
    expect(secrets).toEqual([fixture.good_code, fixture.token]);
    // Two processes — setup-token, then the check — each with no variable of the worker's own,
    // and the check with the token as the CLI reads it.
    expect(environments).toHaveLength(2);
    for (const env of environments) {
      for (const name of Object.keys(env)) {
        expect(name, name).toMatch(
          /^(PATH|HOME|CLAUDE_CONFIG_DIR|TERM|LANG|COLUMNS|LINES|DISABLE_AUTOUPDATER|CLAUDE_CODE_OAUTH_TOKEN)$/,
        );
      }
    }
    expect(environments[0]?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(environments[1]?.CLAUDE_CODE_OAUTH_TOKEN).toBe(fixture.token);
    // Each temporary HOME is removed afterwards.
    await session.close();
    for (const env of environments) expect(existsSync(env.HOME as string)).toBe(false);
    // Nothing of the screen, the code or the token in any log line.
    const log = lines.join('\n');
    for (const planted of [fixture.token, fixture.good_code, 'Paste code here', 'oauth']) {
      expect(log).not.toContain(planted);
    }
  });

  it('says a refused code, and stores nothing', async () => {
    const { signIn: session, stored } = start();
    await session.start();
    await until('the paste prompt', () => session.status().phase === 'waiting_for_code');
    session.submitCode('not-the-code#nope');
    await until('the refusal', () => session.status().phase === 'failed');
    expect(session.status()).toEqual({ phase: 'failed', url: null, failure: 'code_refused' });
    expect(stored).toEqual([]);
  });

  it('checks a pasted token: a refused one is token_rejected and never stored', async () => {
    const { signIn: session, stored } = start();
    session.acceptToken(`sk-ant-oat01-${'R'.repeat(95)}`);
    await until('the verdict', () => session.status().phase === 'failed');
    expect(session.status().failure).toBe('token_rejected');
    expect(stored).toEqual([]);
    session.acceptToken(fixture.token);
    await until('the token is stored', () => stored.length === 1);
    expect(stored).toEqual([fixture.token]);
  });

  it('runs one session at a time, takes a code only when asked, and Cancel ends it', async () => {
    const { signIn: session } = start();
    expect(() => session.submitCode('early')).toThrow(/not waiting for a code/);
    await session.start();
    await expect(session.start()).rejects.toThrow(/already running/);
    await until('the paste prompt', () => session.status().phase === 'waiting_for_code');
    session.cancel();
    expect(session.status()).toEqual({ phase: 'idle', url: null, failure: null });
    await session.start();
    await until('the paste prompt again', () => session.status().phase === 'waiting_for_code');
  });

  it('ends a session past its cap as timed_out', async () => {
    const fake = fakeLauncher();
    signIn = createClaudeSignIn({
      launcher: fake.launcher,
      logger: asLoggerPort(
        createLogger({
          level: 'silent',
          format: 'json',
          role: 'remote-worker',
          destination: { write: () => undefined },
        }),
      ),
      onSecret: () => undefined,
      onToken: async () => undefined,
      timeoutMs: 200,
    });
    await signIn.start();
    await until('the cap', () => signIn?.status().phase === 'failed');
    expect(signIn.status().failure).toBe('timed_out');
  });

  it('says the CLI is unavailable when it cannot be started', async () => {
    signIn = createClaudeSignIn({
      launcher: {
        setupToken: (env) => {
          const child = spawn('/nonexistent/claude', ['setup-token'], { env: { ...env } });
          return { child, kill: () => child.kill('SIGKILL') };
        },
        run: async () => ({ stdout: '', code: null }),
      },
      logger: asLoggerPort(
        createLogger({
          level: 'silent',
          format: 'json',
          role: 'remote-worker',
          destination: { write: () => undefined },
        }),
      ),
      onSecret: () => undefined,
      onToken: async () => undefined,
    });
    await signIn.start();
    await until('the failure', () => signIn?.status().phase === 'failed');
    expect(signIn.status().failure).toBe('cli_unavailable');
  });
});

/**
 * A `claude` that is not a process: its screen is emitted by the test, its stdin recorded, and each
 * check answers only when the test says — so the order of a paste, a cancel and a verdict is the
 * test's, not a scheduler's.
 */
const stubLauncher = () => {
  const clis: {
    readonly emit: (text: string) => void;
    readonly written: string[];
    killed: boolean;
  }[] = [];
  const checks: {
    readonly token: string;
    readonly answer: (verdict: 'accepted' | 'rejected') => void;
  }[] = [];
  const launcher: ClaudeCliLauncher = {
    setupToken: () => {
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      const written: string[] = [];
      const stdin = Object.assign(new EventEmitter(), {
        write: (text: string) => {
          written.push(text);
          return true;
        },
      });
      Object.assign(child, { stdout, stderr: new EventEmitter(), stdin });
      const cli = { emit: (text: string) => stdout.emit('data', text), written, killed: false };
      clis.push(cli);
      return {
        child: child as unknown as ChildProcess,
        kill: () => {
          if (cli.killed) return;
          cli.killed = true;
          queueMicrotask(() => child.emit('close', null));
        },
      };
    },
    run: (_args, env) =>
      new Promise<{ readonly stdout: string; readonly code: number | null }>((resolve) => {
        checks.push({
          token: env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
          answer: (verdict) =>
            resolve({
              stdout:
                verdict === 'accepted'
                  ? '{"type":"result","is_error":false,"result":"OK"}\n'
                  : '{"type":"result","is_error":true,"api_error_status":401}\n',
              code: verdict === 'accepted' ? 0 : 1,
            }),
        });
      }),
  };
  return { launcher, clis, checks };
};

describe('never trapped at “Checking with Claude” (the owner’s report, 2026-11-06)', () => {
  let signIn: ClaudeSignIn | null = null;
  afterEach(async () => {
    vi.useRealTimers();
    await signIn?.close();
    signIn = null;
  });

  const TOKEN_A = `sk-ant-oat01-${'A'.repeat(95)}`;
  const TOKEN_B = `sk-ant-oat01-${'B'.repeat(95)}`;

  const begin = (store: (token: string) => Promise<void> = async () => undefined) => {
    const lines: string[] = [];
    const secrets: string[] = [];
    const stored: string[] = [];
    const stub = stubLauncher();
    signIn = createClaudeSignIn({
      launcher: stub.launcher,
      logger: asLoggerPort(
        createLogger({
          level: 'debug',
          format: 'json',
          role: 'remote-worker',
          destination: { write: (line: string) => lines.push(line) },
        }),
      ),
      onSecret: (_name, value) => secrets.push(value),
      onToken: async (token) => {
        await store(token);
        stored.push(token);
      },
    });
    return { session: signIn, lines, secrets, stored, ...stub };
  };

  it.each(['starting', 'waiting_for_code', 'checking'] as const)(
    'a pasted token wins over a browser sign-in that is %s',
    async (at) => {
      const { session, clis, checks, stored } = begin();
      await session.start();
      if (at !== 'starting') clis[0]?.emit(fixture.screen);
      if (at === 'checking') session.submitCode(fixture.good_code);
      expect(session.status().phase).toBe(at);
      expect(session.inProgress()).toBe(true);
      session.acceptToken(fixture.token);
      // The session yields: its CLI is ended, and its ending is no failure.
      expect(clis[0]?.killed).toBe(true);
      expect(session.status().phase).toBe('checking');
      await until('the check', () => checks.length === 1);
      expect(checks[0]?.token).toBe(fixture.token);
      checks[0]?.answer('accepted');
      await until('the token is stored', () => stored.length === 1);
      expect(stored).toEqual([fixture.token]);
      expect(session.status()).toEqual({ phase: 'idle', url: null, failure: null });
      expect(session.inProgress()).toBe(false);
    },
  );

  it('cancel, then paste: the superseded check blocks nothing, its verdict is discarded, and close() awaits it', async () => {
    const { session, checks, stored } = begin();
    session.acceptToken(TOKEN_A);
    await until('the first check', () => checks.length === 1);
    // Only a paste during the current sign-in's own check is refused, and it says why.
    expect(() => session.acceptToken(TOKEN_B)).toThrow(SignInBusyError);
    session.cancel();
    expect(session.status()).toEqual({ phase: 'idle', url: null, failure: null });
    expect(session.inProgress()).toBe(false);
    session.acceptToken(TOKEN_B);
    await until('the second check', () => checks.length === 2);
    expect(checks[1]?.token).toBe(TOKEN_B);
    checks[1]?.answer('accepted');
    await until('the second token is stored', () => stored.length === 1);
    expect(stored).toEqual([TOKEN_B]);
    // The first check still runs: close() waits for it, and its verdict changes nothing.
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(false);
    checks[0]?.answer('accepted');
    await closing;
    expect(stored).toEqual([TOKEN_B]);
    expect(session.status()).toEqual({ phase: 'idle', url: null, failure: null });
  });

  it('is in progress from the moment start() is called, before its session exists', async () => {
    const { session } = begin();
    const starting = session.start();
    expect(session.inProgress()).toBe(true);
    await expect(session.start()).rejects.toThrow(SignInBusyError);
    await starting;
    expect(session.inProgress()).toBe(true);
    session.cancel();
    expect(session.inProgress()).toBe(false);
  });

  it('a check superseded while its token is stored leaves the newer sign-in’s phase alone', async () => {
    let releaseStore: () => void = () => undefined;
    const storeGate = new Promise<void>((resolve) => {
      releaseStore = resolve;
    });
    const { session, checks, stored } = begin(async (token) => {
      if (token === TOKEN_A) await storeGate;
    });
    session.acceptToken(TOKEN_A);
    await until('the first check', () => checks.length === 1);
    checks[0]?.answer('accepted');
    // A's verdict is in and its store is under way when the person cancels and pastes B.
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.cancel();
    session.acceptToken(TOKEN_B);
    await until('the second check', () => checks.length === 2);
    releaseStore();
    await until('A is stored', () => stored.includes(TOKEN_A));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.status().phase).toBe('checking');
    checks[1]?.answer('accepted');
    await until('B is stored', () => stored.includes(TOKEN_B));
    expect(session.status()).toEqual({ phase: 'idle', url: null, failure: null });
  });

  it('checks a token pasted wrapped and indented, as one token', async () => {
    const { session, checks, secrets } = begin();
    session.acceptToken(`  ${fixture.token.slice(0, 79)}\r\n     ${fixture.token.slice(79)}\n`);
    await until('the check', () => checks.length === 1);
    expect(checks[0]?.token).toBe(fixture.token);
    expect(secrets).toEqual([fixture.token]);
    checks[0]?.answer('rejected');
  });

  it('refuses a paste of another shape before any check runs, without its value in the refusal', async () => {
    const { session, checks, secrets, clis } = begin();
    await session.start();
    clis[0]?.emit(fixture.screen);
    for (const pasted of [
      'sk-ant-api03-FAKE-planted-value-of-another-kind-000000000000000000',
      `sk-ant-oat01-${'S'.repeat(20)}`,
      'hello',
      `sk-ant-oat01-${'Q'.repeat(60)}!`,
    ]) {
      let refusal: unknown = null;
      try {
        session.acceptToken(pasted);
      } catch (error) {
        refusal = error;
      }
      expect(refusal, pasted).toBeInstanceOf(InvalidClaudeTokenError);
      expect((refusal as Error).message).not.toContain('planted');
    }
    // Nothing ran, nothing was taken for a secret, and the browser sign-in carries on.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(checks).toEqual([]);
    expect(secrets).toEqual([]);
    expect(clis[0]?.killed).toBe(false);
    expect(session.status().phase).toBe('waiting_for_code');
  });

  it('reads a token split by a cursor move after the code, and checks it', async () => {
    const { session, clis, checks } = begin();
    await session.start();
    clis[0]?.emit(fixture.screen);
    session.submitCode(fixture.good_code);
    expect(clis[0]?.written).toEqual([`${fixture.good_code}\r`]);
    const token = fixture.token;
    clis[0]?.emit(`\r\nYour OAuth token:\r\n${token.slice(0, 25)}\x1b[1C${token.slice(25)}\r\n`);
    await until('the check', () => checks.length === 1);
    expect(checks[0]?.token).toBe(token);
    checks[0]?.answer('accepted');
  });

  it(`ends the sign-in ${AFTER_CODE_TIMEOUT_MS / 1_000} s after the code when no token appears, says to paste one, and logs no screen`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { session, clis, lines, checks } = begin();
    await session.start();
    clis[0]?.emit(fixture.screen);
    session.submitCode(fixture.good_code);
    const shown = '\r\nSomething this worker does not read sk-ant-oat01-';
    clis[0]?.emit(shown);
    vi.advanceTimersByTime(AFTER_CODE_TIMEOUT_MS - 1);
    expect(session.status().phase).toBe('checking');
    expect(session.inProgress()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(session.status()).toEqual({
      phase: 'failed',
      url: null,
      failure: 'no_token_after_code',
    });
    expect(clis[0]?.killed).toBe(true);
    expect(checks).toEqual([]);
    expect(session.inProgress()).toBe(false);
    const diagnostic = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.chars_after_code !== undefined);
    expect(diagnostic).toMatchObject({ chars_after_code: shown.length, token_prefix_seen: true });
    const log = lines.join('\n');
    for (const planted of [fixture.good_code, 'does not read', 'Paste code here']) {
      expect(log).not.toContain(planted);
    }
    // A paste works at once afterwards.
    session.acceptToken(fixture.token);
    expect(session.status().phase).toBe('checking');
    vi.useRealTimers();
    await until('the check', () => checks.length === 1);
    checks[0]?.answer('rejected');
    await until('the verdict', () => session.status().phase === 'failed');
    expect(session.status().failure).toBe('token_rejected');
  });
});
