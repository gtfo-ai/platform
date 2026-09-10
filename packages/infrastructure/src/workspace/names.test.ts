import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import {
  assertRunId,
  controlDirectory,
  controlSocketPath,
  egressContainerName,
  MAX_UNIX_SOCKET_PATH,
  mirrorPath,
  runContainerName,
  runNetworkName,
  workspaceVolumeName,
} from './names.js';

const RUN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('run id guard', () => {
  it('accepts a uuid and builds every object name from it', () => {
    expect(assertRunId(RUN)).toBe(RUN);
    expect(workspaceVolumeName(RUN)).toBe(`ws-${RUN}`);
    expect(runContainerName(RUN)).toBe(`ws-${RUN}`);
    expect(runNetworkName(RUN)).toBe(`run-${RUN}`);
    expect(egressContainerName(RUN)).toBe(`egress-${RUN}`);
  });

  /**
   * Standing rule 43. `../etc` is refused by every candidate implementation — a `startsWith('/')`
   * check, a `includes('..')` check, a `path.normalize` — so it discriminates nothing. These do:
   * a percent-encoded separator survives a `includes('..')` guard and is decoded by anything that
   * treats the value as a URL component; `x/../../y` normalises back inside before it leaves, so a
   * post-normalisation containment check passes it while the *raw* string is still handed to the
   * daemon; the full-width forms survive an ASCII-only separator check; and a uuid with a suffix
   * survives a `startsWith(uuid)` check.
   */
  it.each([
    ['a parent segment', '../etc'],
    ['a percent-encoded separator', '..%2fetc'],
    ['a double-encoded separator', '..%252fetc'],
    ['an escape that normalises back inside', 'x/../../y'],
    ['a full-width separator', '．．／etc'],
    ['a uuid with a trailing dot segment', `${RUN}/.`],
    ['a uuid with a trailing separator', `${RUN}/`],
    ['a uuid with a suffix', `${RUN}-other`],
    ['a NUL-terminated uuid', `${RUN}\0../other`],
    ['an empty string', ''],
    ['a plain name', 'run-1'],
  ])('refuses %s', (_label, candidate) => {
    expect(() => assertRunId(candidate)).toThrow(WorkspaceError);
    expect(() => workspaceVolumeName(candidate)).toThrow(/not a uuid/);
  });

  it('names the shape rather than the value it refused', () => {
    // A run id is not a secret, but an error detail is a log line and a log line is a habit: the
    // guard reports a length, not the string, so the habit is set where it costs nothing.
    try {
      assertRunId('../etc/passwd');
      expect.unreachable('the guard accepted a parent segment');
    } catch (error) {
      expect((error as WorkspaceError).detail).toBe('length 13');
    }
  });
});

/**
 * A carry, pinned rather than fixed (standing rule 26).
 *
 * `runIdSchema` is `idSchema` is `z.uuid()`, and `z.uuid()` accepts an **uppercase** uuid. A run id
 * is a path component of the control volume every run shares, and the directory it names holds the
 * token that authenticates that run's control channel — so on a volume that folds case, two ids
 * this guard accepts as different name one directory.
 *
 * It is unreachable today: every run id is minted by `randomUUID()`, which emits lowercase. That is
 * a property of *today's minting*, not of the guard, which is why it is pinned here and carried in
 * `docs/TODO.md` rather than left to be rediscovered. And it is measured against the volume the
 * test is running on rather than argued about, because `toLowerCase()` is case *mapping* and a
 * filesystem compares with case *folding* — the two disagree, and the instrument that cannot drift
 * is the filesystem itself.
 */
describe('an uppercase run id', () => {
  it('is accepted, and this volume says whether that is a collision', async () => {
    const upper = RUN.toUpperCase();
    // The pin: two distinct run ids, as far as every guard in this file is concerned.
    expect(assertRunId(upper)).toBe(upper);
    expect(controlDirectory('/run/agentic/ctl', upper)).not.toBe(
      controlDirectory('/run/agentic/ctl', RUN),
    );

    const root = realpathSync(await mkdtemp(path.join(tmpdir(), 'agentic-runid-')));
    try {
      const lowerDir = controlDirectory(root, RUN);
      const upperDir = controlDirectory(root, upper);
      await mkdir(lowerDir);
      const folded = existsSync(upperDir);
      if (folded) {
        // This volume (APFS, and Docker Desktop's host mounts) folds: the two directories the
        // guard treats as different are one inode, and the second run would read the first's token.
        expect(statSync(upperDir).ino).toBe(statSync(lowerDir).ino);
      } else {
        // A case-sensitive volume: two ids, two directories, no collision — the branch that is
        // asserted so this case cannot pass by measuring nothing (standing rule 10).
        await mkdir(upperDir);
        expect(statSync(upperDir).ino).not.toBe(statSync(lowerDir).ino);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('control directory', () => {
  it('is the run sub-directory of the control volume', () => {
    expect(controlDirectory('/run/agentic/ctl', RUN)).toBe(`/run/agentic/ctl/${RUN}`);
    expect(controlSocketPath('/run/agentic/ctl', RUN)).toBe(`/run/agentic/ctl/${RUN}/ctl.sock`);
  });

  it('refuses to build a path from anything but a uuid', () => {
    expect(() => controlDirectory('/run/agentic/ctl', '../other-run')).toThrow(/not a uuid/);
  });

  it('normalises the root before comparing, so a trailing slash is not an escape', () => {
    expect(controlDirectory('/run/agentic/ctl/', RUN)).toBe(`/run/agentic/ctl/${RUN}`);
  });

  /**
   * Measured, not reasoned about: a control root under macOS' `os.tmpdir()` produced a 118-byte
   * socket path and `connect` answered **`EINVAL`** — which names nothing and reads like a fault in
   * the frame protocol. `sun_path` holds 104 bytes on macOS and the BSDs, 108 on Linux.
   */
  it('refuses a control socket path longer than a socket address can hold', () => {
    // `/<root>/<uuid>/ctl.sock` is `root.length + 47`, so 56 is the last root that fits and 57 is
    // the first that does not. Both sides, because a guard that refused every path would pass the
    // negative alone (standing rule 42).
    const fits = `/${'d'.repeat(56)}`;
    const oneTooLong = `/${'d'.repeat(57)}`;
    expect(controlSocketPath(fits, RUN)).toHaveLength(MAX_UNIX_SOCKET_PATH);
    expect(() => controlSocketPath(oneTooLong, RUN)).toThrow(/104 bytes, over the 103-byte limit/);
  });

  it('accepts the layout TD-025 actually deploys', () => {
    // 16 + 1 + 36 + 1 + 8 = 62. The assertion from the other side of the boundary (rule 42).
    expect(controlSocketPath('/run/agentic/ctl', RUN).length).toBeLessThanOrEqual(
      MAX_UNIX_SOCKET_PATH,
    );
  });
});

describe('mirror path', () => {
  it('is the project cache key with a .git suffix', () => {
    expect(mirrorPath('/cache', 'acme-web')).toBe('/cache/acme-web.git');
  });

  it.each([
    ['a parent segment', '..'],
    ['a nested parent segment', 'a..b/../..'],
    ['a separator', 'a/b'],
    ['an absolute path', '/etc/passwd'],
    ['an upper-case key', 'Acme'],
    ['an empty key', ''],
    ['a leading dot', '.hidden'],
  ])('refuses %s', (_label, key) => {
    expect(() => mirrorPath('/cache', key)).toThrow(/not a safe path component/);
  });
});
