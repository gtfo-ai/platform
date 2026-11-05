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
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asLoggerPort, createLogger } from '../logging.js';
import {
  asksForCode,
  type ClaudeCliLauncher,
  type ClaudeSignIn,
  createClaudeSignIn,
  refusedCode,
  renderTerminalText,
  runBounded,
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

  it('joins a token a terminal wrapped, and nothing after it', () => {
    const token = fixture.token;
    const wrapped = `Your OAuth token:\n\n ${token.slice(0, 78)}\n ${token.slice(78)}\n\nStore this token securely.`;
    expect(tokenOf(wrapped)).toBe(token);
    // A line that did not end at the token is not a wrap: the next line is not joined.
    expect(tokenOf(`${token.slice(0, 60)} (copied)\n${token.slice(60)}`)).toBe(token.slice(0, 60));
    // Joined only up to the measured length: words that follow are never part of it.
    expect(tokenOf(`${token}\nStore this token`)).toBe(token);
    expect(tokenOf('sk-ant-oat01-short')).toBeNull();
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
    expect(() => session.acceptToken(fixture.token)).toThrow(/already running/);
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
