import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  captureOutput,
  containsValue,
  hostsSeenBySidecar,
  REAL_MODEL_FLAG,
  REAL_MODEL_PROMPT,
  REAL_MODEL_TOKEN_VARIABLE,
  REAL_MODEL_WALL_CLOCK_MS,
  realModelGate,
} from './real-model-preflight.mjs';

/**
 * WP-140: what `launcher-control-plane-check.mjs --real-model` decides without a daemon. The leg
 * itself needs Docker and a subscription token, so it is run by hand (the command is in
 * `docs/first-local-test.md`); what is asserted here is its gate, its scans and its host list —
 * and, in a real Node process, the two refusals the ruling names, before the check touches anything.
 */

/** Obviously fake (standing rule 93): shaped past the subscription token's own prefix. */
const FAKE_TOKEN = 'FAKE-wp140-oauth-token-not-a-credential';

describe('the gate: the flag and the variable go together', () => {
  it('runs nothing and refuses nothing when neither is given', () => {
    expect(realModelGate([], {})).toEqual({ kind: 'off' });
    expect(realModelGate(['--runner-image', 'platform:dev'], { OTHER: 'x' })).toEqual({
      kind: 'off',
    });
  });

  it('refuses the flag without the variable, naming the variable', () => {
    const gate = realModelGate([REAL_MODEL_FLAG], {});
    expect(gate.kind).toBe('refused');
    expect(gate.kind === 'refused' && gate.message).toMatch(
      /^FAIL: launcher-control-plane-check --real-model — refused: CLAUDE_CODE_OAUTH_TOKEN is unset\./,
    );
    // An empty variable has given nothing, so it is unset.
    expect(realModelGate([REAL_MODEL_FLAG], { [REAL_MODEL_TOKEN_VARIABLE]: '' }).kind).toBe(
      'refused',
    );
  });

  it('refuses the variable without the flag, naming the flag and never the value', () => {
    const gate = realModelGate([], { [REAL_MODEL_TOKEN_VARIABLE]: FAKE_TOKEN });
    expect(gate.kind).toBe('refused');
    const message = gate.kind === 'refused' ? gate.message : '';
    expect(message).toContain('--real-model was not given');
    expect(message).toContain(`is set (length ${String(FAKE_TOKEN.length)})`);
    expect(message).not.toContain(FAKE_TOKEN);
  });

  it('refuses a value too short for the run’s redactor to replace, without printing it', () => {
    const gate = realModelGate([REAL_MODEL_FLAG], { [REAL_MODEL_TOKEN_VARIABLE]: 'FAKE-7c' });
    expect(gate.kind).toBe('refused');
    expect(gate.kind === 'refused' && gate.message).toContain('length 7');
    expect(gate.kind === 'refused' && gate.message).not.toContain('FAKE-7c');
  });

  it('opens with both, and answers the length alone', () => {
    expect(realModelGate([REAL_MODEL_FLAG], { [REAL_MODEL_TOKEN_VARIABLE]: FAKE_TOKEN })).toEqual({
      kind: 'on',
      tokenLength: FAKE_TOKEN.length,
    });
  });

  it('holds the ruling’s fixed turn: the prompt and a two-minute wall clock', () => {
    expect(REAL_MODEL_PROMPT).toBe('Reply with the single word OK.');
    expect(REAL_MODEL_WALL_CLOCK_MS).toBe(120_000);
  });
});

describe('the scans', () => {
  it('finds a value verbatim and never matches an empty one', () => {
    expect(containsValue(`a line ${FAKE_TOKEN} b`, FAKE_TOKEN)).toBe(true);
    expect(containsValue('a line', FAKE_TOKEN)).toBe(false);
    expect(containsValue('anything', '')).toBe(false);
    expect(containsValue('anything', undefined)).toBe(false);
  });

  it('keeps what a stream was given and still writes it', () => {
    const written: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        written.push(String(chunk));
        done();
      },
    });
    const captured = captureOutput([stream]);
    stream.write('one ');
    stream.write(Buffer.from('two'));
    expect(captured.text()).toBe('one two');
    expect(written.join('')).toBe('one two');
  });
});

describe('the hosts a sidecar at LogLevel Connect saw', () => {
  /**
   * The shape of tinyproxy 1.11.2's lines: `Request (file descriptor N): <request line>` at
   * `Connect` for every request, and the refusal at `Notice`. The WP-140 notes carry the lines the
   * leg measured; these are composed from them.
   */
  const log = [
    'CONNECT   Oct 04 12:00:00.000 [7]: Connect (file descriptor 6): 172.18.0.4',
    'CONNECT   Oct 04 12:00:00.001 [7]: Request (file descriptor 6): CONNECT api.anthropic.com:443 HTTP/1.1',
    'INFO      Oct 04 12:00:00.002 [7]: Established connection to host "api.anthropic.com" using file descriptor 7.',
    'CONNECT   Oct 04 12:00:01.000 [7]: Request (file descriptor 6): CONNECT Statsig.Anthropic.com:443 HTTP/1.1',
    'NOTICE    Oct 04 12:00:01.001 [7]: Proxying refused on filtered domain "statsig.anthropic.com"',
    'CONNECT   Oct 04 12:00:02.000 [7]: Request (file descriptor 6): GET http://example.invalid/x HTTP/1.1',
  ];

  it('answers seen, allowed and refused, by host and lower-cased', () => {
    expect(hostsSeenBySidecar(log)).toEqual({
      seen: ['api.anthropic.com', 'example.invalid', 'statsig.anthropic.com'],
      allowed: ['api.anthropic.com', 'example.invalid'],
      refused: ['statsig.anthropic.com'],
    });
  });

  it('sees only refusals in a log rendered at Notice, which is why the leg asserts the level', () => {
    expect(hostsSeenBySidecar([log[4] ?? ''])).toEqual({
      seen: ['statsig.anthropic.com'],
      allowed: [],
      refused: ['statsig.anthropic.com'],
    });
    expect(hostsSeenBySidecar(null)).toEqual({ seen: [], allowed: [], refused: [] });
  });
});

/**
 * The two refusals, each a dry run of the **real** check in a child process: no daemon is needed,
 * because the gate runs before anything is imported or asked of Docker. `DOCKER_HOST` is withheld,
 * so a gate that let either case through would end on the check's *other* refusal, which names
 * `DOCKER_HOST` — a different message, and the assertion would fail by name.
 */
describe('launcher-control-plane-check.mjs refuses before it touches anything (WP-140 criterion 1)', () => {
  const script = join(import.meta.dirname, 'launcher-control-plane-check.mjs');
  const baseEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        name !== 'DOCKER_HOST' &&
        name !== REAL_MODEL_TOKEN_VARIABLE &&
        name !== 'ANTHROPIC_API_KEY'
      ) {
        env[name] = value;
      }
    }
    return env;
  };
  const run = (args: readonly string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 60_000 });

  it('the flag without the variable: exit 2, the variable named, nothing on stdout', () => {
    const result = run([REAL_MODEL_FLAG], baseEnv());
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'FAIL: launcher-control-plane-check --real-model — refused: CLAUDE_CODE_OAUTH_TOKEN is unset.',
    );
    expect(result.stderr).not.toContain('DOCKER_HOST');
  });

  it('the variable without the flag: exit 2, the flag named, the value nowhere', () => {
    const result = run([], { ...baseEnv(), [REAL_MODEL_TOKEN_VARIABLE]: FAKE_TOKEN });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--real-model was not given');
    expect(result.stderr).not.toContain('DOCKER_HOST');
    expect(`${result.stdout}${result.stderr}`).not.toContain(FAKE_TOKEN);
  });
});
