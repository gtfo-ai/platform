import { describe, expect, it } from 'vitest';
import {
  isRunletByteFrameType,
  RUNLET_BYTE_FRAME_TYPES,
  RUNLET_PROTOCOL_VERSION,
  runletFatalReasonSchema,
  runletFrameSchema,
  runletHostSchema,
  runletSignalSchema,
} from './runlet.js';

/**
 * The frame protocol is a wire format between two processes, one of which (the shim) sits in the
 * run container beside the agent. Every probe below is written the way a *JavaScript* caller
 * reaches this schema — an object literal cast through `unknown` — because a guard that only the
 * compiler enforces is not enforced at a boundary (standing rule 14).
 */
const parse = (frame: unknown) => runletFrameSchema.safeParse(frame);

describe('runlet frame protocol', () => {
  it('accepts every frame the decision names', () => {
    const frames: unknown[] = [
      {
        type: 'hello',
        protocol: RUNLET_PROTOCOL_VERSION,
        token: 'run-token-0000000000000000000000',
      },
      { type: 'hello.ok', protocol: RUNLET_PROTOCOL_VERSION },
      {
        type: 'spawn',
        command: '/usr/bin/claude',
        args: ['--verbose'],
        cwd: '/work/repo',
        env: { PATH: '/usr/bin' },
      },
      { type: 'spawn.ok', pid: 42 },
      { type: 'stdin' },
      { type: 'stdin.end' },
      { type: 'stdout' },
      { type: 'stderr' },
      { type: 'signal', name: 'SIGTERM' },
      { type: 'exit', code: 0, signal: null },
      { type: 'cred.get', request_id: 'cred-1', host: 'gitlab.example.com', protocol: 'https' },
      { type: 'cred.reply', request_id: 'cred-1', credential: { username: 'x', password: 'y' } },
      { type: 'cred.reply', request_id: 'cred-1', credential: null },
      { type: 'ping' },
      { type: 'pong' },
      { type: 'fatal', reason: 'auth_failed', message: 'no' },
    ];
    for (const frame of frames) {
      expect(parse(frame).success, JSON.stringify(frame)).toBe(true);
    }
  });

  it('refuses an unknown frame type and an unknown key on a known one', () => {
    expect(parse({ type: 'exec', command: '/bin/sh' }).success).toBe(false);
    // The header of a byte frame carries no `bytes`: the bytes are the payload. A header that
    // smuggles them would otherwise be silently dropped by a non-strict object.
    expect(parse({ type: 'stdout', bytes: 'aGVsbG8=' }).success).toBe(false);
    expect(parse({ type: 'signal', name: 'SIGTERM', pid: 1 }).success).toBe(false);
  });

  describe('a missing field is never zero (standing rule 16)', () => {
    it('refuses an exit frame without a code, rather than reading it as success', () => {
      const result = parse({ type: 'exit', signal: null });
      expect(result.success).toBe(false);
      // The point of the rule: nothing downstream may see a `0` here.
      expect(parse({ type: 'exit', code: null, signal: 'SIGKILL' }).success).toBe(true);
    });

    it('refuses an exit frame without a signal', () => {
      expect(parse({ type: 'exit', code: 0 }).success).toBe(false);
    });

    it('refuses a cred.reply without a credential field, rather than reading it as "not found"', () => {
      expect(parse({ type: 'cred.reply', request_id: 'cred-1' }).success).toBe(false);
      expect(parse({ type: 'cred.reply', request_id: 'cred-1', credential: null }).success).toBe(
        true,
      );
    });

    it('refuses a signal frame without a name', () => {
      expect(parse({ type: 'signal' }).success).toBe(false);
    });

    it('refuses a hello without a token or with an absent protocol', () => {
      expect(parse({ type: 'hello', protocol: RUNLET_PROTOCOL_VERSION }).success).toBe(false);
      expect(parse({ type: 'hello', token: 'x' }).success).toBe(false);
    });
  });

  describe('spawn', () => {
    const spawn = (over: Record<string, unknown>) => ({
      type: 'spawn',
      command: '/usr/bin/claude',
      args: [],
      cwd: '/work/repo',
      env: {},
      ...over,
    });

    /**
     * `claude` on its own is refused by every implementation of this rule, including a wrong one:
     * weakening the check to `value.includes('/')` left the whole runlet suite (138 tests when it
     * was measured) green. The paths that
     * distinguish an absolute-path rule from "looks like a path" are the *relative* ones that carry
     * a separator — and they are the dangerous ones, because a relative `command` resolves against
     * `cwd`, which is the workspace the agent can write to. (Same shape as the allow-list below:
     * a negative case every candidate implementation refuses proves nothing.)
     */
    it('requires an absolute command and cwd, including against a relative path with a slash', () => {
      for (const command of ['claude', './claude', '../../usr/bin/claude', 'bin/claude', '']) {
        expect(parse(spawn({ command })).success, command).toBe(false);
      }
      for (const cwd of ['repo', './repo', '../repo', 'a/b', '']) {
        expect(parse(spawn({ cwd })).success, cwd).toBe(false);
      }
      expect(parse(spawn({ command: '/usr/bin/claude', cwd: '/work/repo' })).success).toBe(true);
    });

    it('refuses a NUL byte in a path, an env name or an env value', () => {
      expect(parse(spawn({ command: '/usr/bin/claude\0/evil' })).success).toBe(false);
      expect(parse(spawn({ env: { 'A\0B': 'x' } })).success).toBe(false);
      expect(parse(spawn({ env: { A: 'x\0y' } })).success).toBe(false);
    });

    it('refuses an environment name that could smuggle a second variable', () => {
      expect(parse(spawn({ env: { 'A=B': 'c' } })).success).toBe(false);
      expect(parse(spawn({ env: { '': 'c' } })).success).toBe(false);
      expect(parse(spawn({ env: { '2A': 'c' } })).success).toBe(false);
      expect(parse(spawn({ env: { A_2: 'c' } })).success).toBe(true);
    });

    it('refuses a non-string argument list', () => {
      expect(parse(spawn({ args: [1] })).success).toBe(false);
      expect(parse(spawn({ args: 'x' })).success).toBe(false);
    });
  });

  describe('signals are an allow-list, not a relay', () => {
    it('accepts the seven the runtime needs', () => {
      expect(runletSignalSchema.options).toEqual([
        'SIGTERM',
        'SIGKILL',
        'SIGINT',
        'SIGHUP',
        'SIGQUIT',
        'SIGUSR1',
        'SIGUSR2',
      ]);
    });

    it('reports a signal the runner may not send: a crash is not an ordinary exit', () => {
      // The relay allow-list and the exit *report* are deliberately different sets.
      expect(parse({ type: 'exit', code: null, signal: 'SIGSEGV' }).success).toBe(true);
      expect(parse({ type: 'signal', name: 'SIGSEGV' }).success).toBe(false);
      expect(parse({ type: 'exit', code: null, signal: 'kill it' }).success).toBe(false);
    });

    it('refuses a signal that would park the child for ever, and a numeric one', () => {
      expect(parse({ type: 'signal', name: 'SIGSTOP' }).success).toBe(false);
      expect(parse({ type: 'signal', name: 9 }).success).toBe(false);
      expect(parse({ type: 'signal', name: 'sigterm' }).success).toBe(false);
    });
  });

  describe('cred.get is the narrowest surface in the protocol', () => {
    it('has no representation for cleartext', () => {
      const frame = { type: 'cred.get', request_id: 'c1', host: 'example.com', protocol: 'http' };
      expect(parse(frame).success).toBe(false);
    });

    it('refuses a host that is not a lowercase DNS name', () => {
      for (const host of [
        'EXAMPLE.com',
        'example.com:8443',
        'example.com/path',
        'user@example.com',
        '*.example.com',
        'exa mple.com',
        '-example.com',
        'example-.com',
        // The DNS root form. It names the same host as `example.com` and is a *different string*,
        // so letting it on the wire would ask the allow-list to know that — see
        // `spawn-adapter.test.ts` § "matches exactly, without a socket in the way".
        'example.com.',
        '',
        'a'.repeat(64),
        `${'a'.repeat(250)}.example.com`,
        'example.com\0',
      ]) {
        expect(runletHostSchema.safeParse(host).success, host).toBe(false);
      }
    });

    it('accepts the hosts a run legitimately needs', () => {
      for (const host of ['gitlab.example.com', 'a', 'a-b.c-d.example', '127.0.0.1']) {
        expect(runletHostSchema.safeParse(host).success, host).toBe(true);
      }
    });

    it('refuses a request id that is not opaque', () => {
      const base = { type: 'cred.get', host: 'example.com', protocol: 'https' };
      expect(parse({ ...base, request_id: '../../etc' }).success).toBe(false);
      expect(parse({ ...base, request_id: '' }).success).toBe(false);
      expect(parse({ ...base, request_id: 'a'.repeat(65) }).success).toBe(false);
    });
  });

  it('names the three byte-carrying frames and nothing else', () => {
    expect([...RUNLET_BYTE_FRAME_TYPES]).toEqual(['stdin', 'stdout', 'stderr']);
    expect(isRunletByteFrameType('stdout')).toBe(true);
    expect(isRunletByteFrameType('exit')).toBe(false);
  });

  it('enumerates the refusal reasons the two endpoints can report', () => {
    expect(runletFatalReasonSchema.options).toContain('auth_failed');
    expect(runletFatalReasonSchema.options).toContain('connection_taken');
    expect(runletFatalReasonSchema.options).toContain('credential_refused');
  });
});
