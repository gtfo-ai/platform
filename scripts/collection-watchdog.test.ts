import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { killPids, killProcessTree, processTable, processTree } from './vitest-bounded.mjs';

/**
 * The collection bound, end to end (WP-213 criterion 1, backlog 597, review round 1):
 * `vitest-bounded.mjs` runs a whole vitest over a scratch directory and must stop a stall and name
 * it — with every process of the tree gone — and must leave alone a worker that crashed and a test
 * that outlasts the bound. A signal to the runner stops the whole tree, and `scripts/verify.mjs`
 * prints the stall line the runner reports.
 *
 * A `process` suite (`vitest.config.ts`): it starts vitests of its own, which inside the parallel
 * `unit` group would compete with it. Every canary of these tests is recorded under WP-213 in
 * PROGRESS.
 */
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(SCRIPTS, 'vitest-bounded.mjs');
const BOUND_MS = 3_000;

let directory: string | null = null;
let runner: number | undefined;
const seen = new Set<number>();
/** PIDs of a finished run found still alive — ours, so stopped after the test. */
let leftovers: number[] = [];

afterEach(() => {
  // A run the test abandoned is stopped here, by its PIDs (standing rule 99). The PIDs of a run
  // that ended are not killed blindly — one could have been reused — only its live leftovers.
  if (runner !== undefined) {
    killProcessTree(runner);
    killPids([...seen].filter(alive));
    runner = undefined;
  }
  killPids(leftovers);
  leftovers = [];
  seen.clear();
  if (directory !== null) {
    rmSync(directory, { recursive: true, force: true });
    directory = null;
  }
});

const scratch = (files: Record<string, string>): string => {
  directory = mkdtempSync(join(tmpdir(), 'collection-watchdog-'));
  writeFileSync(
    join(directory, 'vitest.config.mjs'),
    'export default { test: { globals: true } };\n',
  );
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(directory, name), body);
  }
  return directory;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
};

/**
 * This process's environment without what an outer `scripts/verify.mjs` set: under `verify` the
 * scratch run would otherwise write its stall into the outer target's report and name the outer
 * target (measured, review round 1: `FAIL: verify — collection stalled in spin.test.mjs`).
 */
const isolated = (): NodeJS.ProcessEnv => {
  const {
    VERIFY_TARGET: _target,
    VERIFY_STALL_REPORT: _report,
    npm_lifecycle_event: _script,
    ...rest
  } = process.env;
  return rest;
};

interface Run {
  readonly child: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly output: () => { stdout: string; stderr: string };
}

/** Starts the runner over `root`, recording every PID its tree ever has into {@link seen}. */
const start = (root: string, env: Record<string, string>, args: string[] = []): Run => {
  const child = spawn(
    process.execPath,
    [RUNNER, 'run', '--root', root, '--config', join(root, 'vitest.config.mjs'), ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...isolated(), ...env } },
  );
  runner = child.pid;
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const record = setInterval(() => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      for (const pid of processTree(child.pid, processTable())) {
        seen.add(pid);
      }
    }
  }, 100);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => {
      clearInterval(record);
      // Taken before any assertion, so a failing one still leaves them to `afterEach`.
      leftovers = [...seen].filter(alive);
      resolve({ code, signal });
    }),
  );
  return { child, exit, output: () => ({ stdout, stderr }) };
};

const lastLine = (text: string): string | undefined => text.trimEnd().split('\n').at(-1);

/** A test file that writes its worker's PID to `marker`, then spins at its top level. */
const spinning = (marker: string): string =>
  `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, String(process.pid));\nfor (;;) {}\n`;

const waitFor = async (path: string, deadline: number): Promise<void> => {
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`${path} was never written`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('a vitest run under the collection bound', () => {
  it('stops a file that never finishes collecting and names it', async () => {
    const root = scratch({
      'quick.test.mjs': 'export {};\n',
      'stall.test.mjs': 'await new Promise(() => {});\n',
    });
    const report = join(root, 'stalled');
    const started = Date.now();
    const run = start(root, {
      VERIFY_COLLECTION_BOUND_MS: String(BOUND_MS),
      VERIFY_TARGET: 'verify:planted',
      VERIFY_STALL_REPORT: report,
    });
    const { code } = await run.exit;
    runner = undefined;

    expect(lastLine(run.output().stdout)).toBe(
      'FAIL: verify:planted — collection stalled in stall.test.mjs',
    );
    expect(code).toBe(1);
    expect(readFileSync(report, 'utf8')).toBe('stall.test.mjs');
    // Within the bound and the time it takes to start vitest, not the test's own timeout.
    expect(Date.now() - started).toBeLessThan(BOUND_MS + 30_000);
  }, 60_000);

  it('kills every process of the tree, the spinning worker included', async () => {
    const root = scratch({});
    const marker = join(root, 'worker.pid');
    writeFileSync(join(root, 'spin.test.mjs'), spinning(marker));
    const run = start(root, { VERIFY_COLLECTION_BOUND_MS: String(BOUND_MS) });
    await waitFor(marker, Date.now() + 30_000);
    const worker = Number(readFileSync(marker, 'utf8'));
    await run.exit;
    runner = undefined;

    expect(lastLine(run.output().stdout)).toBe(
      'FAIL: vitest — collection stalled in spin.test.mjs',
    );
    // Not vacuous: the runner, vitest and the worker were all seen.
    expect(seen.has(worker)).toBe(true);
    expect(seen.size).toBeGreaterThanOrEqual(3);
    expect(leftovers).toEqual([]);
  }, 60_000);

  it('leaves a crashed worker to vitest and lets the healthy files finish', async () => {
    const root = scratch({
      'crash.test.mjs': "process.kill(process.pid, 'SIGKILL');\n",
      // Six seconds of tests, twice the bound, each one an event the run reports.
      'healthy.test.mjs': [1, 2, 3, 4, 5, 6]
        .map((n) => `it('waits ${n}', () => new Promise((resolve) => setTimeout(resolve, 1000)));`)
        .join('\n'),
    });
    const run = start(root, { VERIFY_COLLECTION_BOUND_MS: String(BOUND_MS) }, [
      '--reporter=default',
    ]);
    const { code } = await run.exit;
    runner = undefined;
    const { stdout, stderr } = run.output();

    expect(`${stdout}${stderr}`).toContain('Worker exited unexpectedly');
    expect(stdout).toMatch(/Tests\s+6 passed/);
    expect(`${stdout}${stderr}`).not.toContain('collection stalled');
    expect(code).toBe(1);
  }, 60_000);

  it('never stops a test that outlasts the bound once its file has collected', async () => {
    const root = scratch({
      'long.test.mjs':
        "it('outlasts the bound', () => new Promise((resolve) => setTimeout(resolve, 6000)), 20000);\n",
    });
    const run = start(root, { VERIFY_COLLECTION_BOUND_MS: String(BOUND_MS) }, [
      '--reporter=default',
    ]);
    const { code } = await run.exit;
    runner = undefined;
    const { stdout, stderr } = run.output();

    expect(stdout).toMatch(/Tests\s+1 passed/);
    expect(`${stdout}${stderr}`).not.toContain('collection stalled');
    expect(code).toBe(0);
  }, 60_000);

  it('stops the whole tree on SIGTERM and exits 143', async () => {
    const root = scratch({});
    const marker = join(root, 'worker.pid');
    writeFileSync(join(root, 'spin.test.mjs'), spinning(marker));
    // A bound the test never reaches: only the signal can end this run.
    const run = start(root, { VERIFY_COLLECTION_BOUND_MS: '600000' });
    await waitFor(marker, Date.now() + 30_000);
    const worker = Number(readFileSync(marker, 'utf8'));
    for (const pid of processTree(run.child.pid as number, processTable())) {
      seen.add(pid);
    }
    run.child.kill('SIGTERM');
    const { code } = await run.exit;
    runner = undefined;

    expect(code).toBe(143);
    expect(seen.has(worker)).toBe(true);
    expect(leftovers).toEqual([]);
  }, 60_000);
});

describe('scripts/verify.mjs and a stalled step', () => {
  /** Runs `verify:ui` with `pnpm` replaced by `script`, and returns its stdout. */
  const verifyWith = async (script: string): Promise<string> => {
    const root = scratch({});
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, 'pnpm'), 0o755);
    const child = spawn(process.execPath, [join(SCRIPTS, 'verify.mjs'), 'verify:ui'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    await new Promise((resolve) => child.on('exit', resolve));
    return stdout;
  };

  it('names the stalled file in its one line', async () => {
    expect(
      await verifyWith('printf %s apps/web/src/stuck.test.ts > "$VERIFY_STALL_REPORT"; exit 1'),
    ).toBe('FAIL: verify:ui — collection stalled in apps/web/src/stuck.test.ts\n');
  });

  it('keeps the plain line for any other failure', async () => {
    expect(await verifyWith('exit 1')).toBe('FAIL: verify:ui\n');
  });
});
