import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ACCEPTED_WORKER_PROTOCOLS,
  WORKER_PROTOCOL_VERSION,
} from '../packages/contracts/src/worker.js';
import {
  ProtocolDeclarationError,
  parseProtocolDeclaration,
  protocolFindings,
  readDeclarations,
  runProtocolCheck,
  shapeFindings,
  WORKER_PROTOCOL_PATH,
} from './check-protocol.js';
import { gitRunner } from './commit-range.mjs';
import { checkoutGitEnv, initScratchRepository } from './git-scratch-env.mjs';

/**
 * `protocol:check` (WP-273, TD-032 decision 7) against scratch repositories whose history is a chain
 * of releases, each commit one push to `main`.
 */
const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

const declaration = (version: number, accepted: readonly number[]): string =>
  `/** a worker protocol module */\nexport const WORKER_PROTOCOL_VERSION = ${version};\n\nexport const ACCEPTED_WORKER_PROTOCOLS = [${accepted.join(', ')}] as const;\n`;

interface Scratch {
  readonly root: string;
  readonly env: Record<string, string>;
  /** Writes the module and commits it as one release; answers the commit. */
  readonly release: (text: string | null, message: string) => string;
  /** Writes the module to the working tree only. */
  readonly write: (text: string) => void;
  readonly findings: (base: string) => string[];
}

/** A repository whose first commit holds no protocol module (the history before WP-273). */
const scratch = (): Scratch => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wp273-protocol-')));
  scratches.push(root);
  const env = initScratchRepository(root, { initArgs: ['-b', 'main'] });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const write = (text: string) => {
    mkdirSync(dirname(join(root, WORKER_PROTOCOL_PATH)), { recursive: true });
    writeFileSync(join(root, WORKER_PROTOCOL_PATH), text);
  };
  writeFileSync(join(root, 'README.md'), 'before the worker protocol\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'root');
  const release = (text: string | null, message: string) => {
    if (text === null) writeFileSync(join(root, 'README.md'), `${message}\n`);
    else write(text);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const findings = (base: string) => {
    const read = readDeclarations(root, base, gitRunner(root, env));
    if (read.tree === null) throw new Error('no tree declaration');
    return protocolFindings(read.tree, read.base, read.previous);
  };
  return { root, env, release, write, findings };
};

describe('the constants this build ships', () => {
  it('are N = 2 accepting [1, 2] — [N-1, N] without a 0 (TD-031 decision 9; bumped by WP-292)', () => {
    expect(WORKER_PROTOCOL_VERSION).toBe(2);
    expect(ACCEPTED_WORKER_PROTOCOLS).toEqual([1, 2]);
  });

  it('are read back from the module text exactly as they are imported', () => {
    const text = readFileSync(join(import.meta.dirname, '..', WORKER_PROTOCOL_PATH), 'utf8');
    expect(parseProtocolDeclaration(text)).toEqual({
      version: WORKER_PROTOCOL_VERSION,
      accepted: [...ACCEPTED_WORKER_PROTOCOLS],
    });
    expect(
      shapeFindings({ version: WORKER_PROTOCOL_VERSION, accepted: ACCEPTED_WORKER_PROTOCOLS }),
    ).toEqual([]);
  });
});

describe('parseProtocolDeclaration', () => {
  it('reads both literals, with or without `as const`', () => {
    expect(parseProtocolDeclaration(declaration(3, [2, 3]))).toEqual({
      version: 3,
      accepted: [2, 3],
    });
    expect(
      parseProtocolDeclaration(
        'export const WORKER_PROTOCOL_VERSION = 2;\nexport const ACCEPTED_WORKER_PROTOCOLS = [1,2];\n',
      ),
    ).toEqual({ version: 2, accepted: [1, 2] });
  });

  it('answers null for a revision that declares neither', () => {
    expect(parseProtocolDeclaration(null)).toBeNull();
    expect(parseProtocolDeclaration('export const other = 1;\n')).toBeNull();
  });

  it('refuses a half declaration, a computed value and a non-integer list', () => {
    expect(() => parseProtocolDeclaration('export const WORKER_PROTOCOL_VERSION = 1;\n')).toThrow(
      /without ACCEPTED_WORKER_PROTOCOLS as a literal/,
    );
    expect(() =>
      parseProtocolDeclaration(
        'export const WORKER_PROTOCOL_VERSION = BASE + 1;\nexport const ACCEPTED_WORKER_PROTOCOLS = [1];\n',
      ),
    ).toThrow(ProtocolDeclarationError);
    expect(() =>
      parseProtocolDeclaration(
        'const v = 1;\nexport const WORKER_PROTOCOL_VERSION = v;\nexport const ACCEPTED_WORKER_PROTOCOLS = range(v);\n',
      ),
    ).toThrow(/not as `export const NAME = <literal>;`/);
    expect(() =>
      parseProtocolDeclaration(
        'export const WORKER_PROTOCOL_VERSION = 2;\nexport const ACCEPTED_WORKER_PROTOCOLS = [N - 1, 2];\n',
      ),
    ).toThrow(/not a list of integer literals/);
  });
});

describe('shapeFindings — rule 1', () => {
  it('admits [N] and [N-1, N]', () => {
    expect(shapeFindings({ version: 1, accepted: [1] })).toEqual([]);
    expect(shapeFindings({ version: 4, accepted: [3, 4] })).toEqual([]);
    expect(shapeFindings({ version: 4, accepted: [4] })).toEqual([]);
  });

  it('refuses a list without N, with N-2 or N+1, unsorted, duplicated, and a version below 1', () => {
    expect(shapeFindings({ version: 2, accepted: [1] })).toEqual([
      'ACCEPTED_WORKER_PROTOCOLS must contain WORKER_PROTOCOL_VERSION (2)',
    ]);
    expect(shapeFindings({ version: 3, accepted: [1, 2, 3] })).toEqual([
      'ACCEPTED_WORKER_PROTOCOLS holds only N-1 and N (TD-031 decision 9); [1, 2, 3] has 1',
    ]);
    expect(shapeFindings({ version: 1, accepted: [1, 2] })).toHaveLength(1);
    expect(shapeFindings({ version: 2, accepted: [2, 1] })).toEqual([
      'ACCEPTED_WORKER_PROTOCOLS must be sorted and distinct; it is [2, 1]',
    ]);
    expect(shapeFindings({ version: 2, accepted: [2, 2] })).toHaveLength(1);
    expect(shapeFindings({ version: 0, accepted: [0] })).toEqual([
      'WORKER_PROTOCOL_VERSION must be a positive integer; it is 0',
      'ACCEPTED_WORKER_PROTOCOLS holds only N-1 and N (TD-031 decision 9); [0] has a value below 1',
    ]);
  });
});

describe('protocolFindings — on scratch repositories', () => {
  it('admits the introduction, an unchanged tree, and a +1 bump that keeps N-1', () => {
    const repo = scratch();
    const base = repo.release(null, 'a release before the protocol module');
    repo.write(declaration(1, [1]));
    expect(repo.findings(base)).toEqual([]);
    const introduced = repo.release(declaration(1, [1]), 'introduce protocol 1');
    expect(repo.findings(introduced)).toEqual([]);
    repo.write(declaration(2, [1, 2]));
    expect(repo.findings(introduced)).toEqual([]);
  });

  it('refuses a skip, which also drops the base from the accepted list', () => {
    const repo = scratch();
    const base = repo.release(declaration(1, [1]), 'protocol 1');
    repo.write(declaration(3, [2, 3]));
    expect(repo.findings(base)).toEqual([
      'WORKER_PROTOCOL_VERSION moved from 1 to 3; a bump is exactly 2 — no skip and no decrease (TD-032 decision 7)',
      'the bump to 3 drops 1 from ACCEPTED_WORKER_PROTOCOLS; the release that bumps N still serves N-1 (expand before contract, TD-032 decision 7)',
    ]);
  });

  it('refuses a decrease', () => {
    const repo = scratch();
    repo.release(declaration(1, [1]), 'protocol 1');
    repo.release(null, 'a release in between');
    repo.release(declaration(2, [1, 2]), 'protocol 2');
    const base = repo.release(null, 'another release');
    repo.write(declaration(1, [1]));
    expect(repo.findings(base)).toEqual([
      'WORKER_PROTOCOL_VERSION moved from 2 to 1; a bump is exactly 3 — no skip and no decrease (TD-032 decision 7)',
      'the bump to 1 drops 2 from ACCEPTED_WORKER_PROTOCOLS; the release that bumps N still serves N-1 (expand before contract, TD-032 decision 7)',
    ]);
  });

  it('refuses a +1 bump that drops the base from the accepted list', () => {
    const repo = scratch();
    const base = repo.release(declaration(1, [1]), 'protocol 1');
    repo.write(declaration(2, [2]));
    expect(repo.findings(base)).toEqual([
      'the bump to 2 drops 1 from ACCEPTED_WORKER_PROTOCOLS; the release that bumps N still serves N-1 (expand before contract, TD-032 decision 7)',
    ]);
  });

  it('refuses a bump whose base bumped over the release before it — TD-032 §7, no two in consecutive pushes', () => {
    const repo = scratch();
    repo.release(declaration(1, [1]), 'protocol 1');
    repo.release(null, 'a release in between');
    const bumped = repo.release(declaration(2, [1, 2]), 'protocol 2');
    repo.write(declaration(3, [2, 3]));
    expect(repo.findings(bumped)).toEqual([
      'the base already bumped WORKER_PROTOCOL_VERSION (1 → 2) over the release before it; no two bumps in consecutive pushes (TD-032 decision 7)',
    ]);
    // One release later the same bump is admitted: the base equals its predecessor.
    const settled = repo.release(null, 'a release that serves protocol 2 alone');
    repo.write(declaration(3, [2, 3]));
    expect(repo.findings(settled)).toEqual([]);
  });

  it('refuses a change to the accepted list without a bump', () => {
    const repo = scratch();
    repo.release(declaration(1, [1]), 'protocol 1');
    repo.release(null, 'between');
    repo.release(declaration(2, [1, 2]), 'protocol 2');
    const base = repo.release(null, 'between again');
    repo.write(declaration(2, [2]));
    expect(repo.findings(base)).toEqual([
      'ACCEPTED_WORKER_PROTOCOLS changed from [1, 2] to [2] without a version bump; the accepted range moves only with WORKER_PROTOCOL_VERSION (TD-032 decision 7)',
    ]);
  });
});

describe('runProtocolCheck — the command line', () => {
  const run = (root: string, argv: readonly string[], env: Record<string, string | undefined>) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runProtocolCheck(argv, {
      root,
      env,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });
    return { code, out: out.join(''), err: err.join('') };
  };

  it('prints one PASS line, or one FAIL line with each finding on stderr', () => {
    const repo = scratch();
    const base = repo.release(declaration(1, [1]), 'protocol 1');
    const env = { ...repo.env, PATH: process.env.PATH };
    expect(run(repo.root, ['--from', base], env)).toEqual({
      code: 0,
      out: `PASS: protocol:check (worker protocol 1, accepts [1], unchanged; explicit range ${base}..HEAD)\n`,
      err: '',
    });
    repo.write(declaration(2, [1, 2]));
    expect(run(repo.root, [`--from=${base}`, '--to=HEAD'], env).out).toBe(
      `PASS: protocol:check (worker protocol 2, accepts [1, 2], bumped from 1; explicit range ${base}..HEAD)\n`,
    );
    repo.write(declaration(3, [2, 3]));
    const failed = run(repo.root, ['--from', base], env);
    expect(failed.code).toBe(1);
    expect(failed.out).toBe('FAIL: protocol:check\n');
    expect(failed.err).toMatch(
      /^packages\/contracts\/src\/worker\.ts: WORKER_PROTOCOL_VERSION moved from 1 to 3/,
    );
    expect(failed.err).toContain('2 finding(s)');
  });

  it('fails when the tree declares no constant, or one it cannot read', () => {
    const repo = scratch();
    const base = repo.release(declaration(1, [1]), 'protocol 1');
    const env = { ...repo.env, PATH: process.env.PATH };
    repo.write('export const nothing = 0;\n');
    expect(run(repo.root, ['--from', base], env)).toMatchObject({
      code: 1,
      out: 'FAIL: protocol:check\n',
      err: expect.stringContaining('the check cannot pass a value it cannot read'),
    });
    repo.write('export const WORKER_PROTOCOL_VERSION = 2;\n');
    expect(run(repo.root, ['--from', base], env)).toMatchObject({
      code: 1,
      err: expect.stringContaining('without ACCEPTED_WORKER_PROTOCOLS'),
    });
  });

  it('fails on a base it cannot resolve, and exits 2 on a usage error', () => {
    const repo = scratch();
    repo.release(declaration(1, [1]), 'protocol 1');
    const env = { ...repo.env, PATH: process.env.PATH };
    expect(run(repo.root, ['--from', 'nope'], env)).toMatchObject({
      code: 1,
      out: 'FAIL: protocol:check\n',
    });
    expect(run(repo.root, ['--bogus'], env)).toMatchObject({
      code: 2,
      out: 'FAIL: protocol:check\n',
    });
    expect(run(repo.root, ['--from'], env)).toMatchObject({ code: 2 });
  });

  it('runs as a program over this checkout and prints its verdict', () => {
    const root = join(import.meta.dirname, '..');
    const out = execFileSync('node', ['scripts/check-protocol.mjs', '--from', 'HEAD'], {
      cwd: root,
      env: checkoutGitEnv(),
      encoding: 'utf8',
    });
    expect(out).toMatch(
      /^PASS: protocol:check \(worker protocol \d+, accepts \[[\d, ]+\], (introduced|unchanged|bumped from \d+); explicit range HEAD\.\.HEAD\)\n$/,
    );
  });
});
