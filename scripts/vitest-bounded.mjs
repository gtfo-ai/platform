#!/usr/bin/env node
/**
 * `vitest`, with a bound on **collection** (WP-213, PROGRESS backlog 597). Every `package.json`
 * script a verification target runs that starts vitest starts it through this file
 * (`scripts/verify.test.ts` holds that), and the arguments are vitest's own.
 *
 * **Why.** `testTimeout` and `hookTimeout` apply once a test runs. A test file whose top level or a
 * `describe` body never returns is never a test, so nothing bounded it: 597 was a `describe` body
 * scanning for a quote that never closed (backlog 618), and vitest printed its `RUN` banner and
 * then nothing, with a worker at 100 % CPU. CI's `timeout-minutes` ends such a job; a local
 * `verify` or an agent's run read as slow and cost a session.
 *
 * **What.** vitest runs with `test/support/collection-reporter.ts` on an IPC channel, which reports
 * when each file's collection begins and ends, and that the run is still active. A run stalls when
 * a file began collecting at least {@link COLLECTION_BOUND_MS} ago, has not ended, **and** nothing
 * else in the run has happened for that long either — which is the row's wording, *no file
 * finishes collecting for N*, and is what keeps a file whose worker crashed (vitest reports the
 * crash only when the run ends) from stopping a healthy run that goes on (review round 1). Then
 * every process of vitest's tree is sent `SIGKILL` by its PID (standing rule 99 — a tree is stopped
 * by its PIDs, never by a name), and the run prints `FAIL: <target> — collection stalled in <file>`,
 * the file being the one still collecting rather than the last one collected. Under
 * `scripts/verify.mjs` the file is also written to `VERIFY_STALL_REPORT`, so the target's one
 * stdout line names it.
 *
 * A slow *test* is `testTimeout`'s, never this bound's: its file has finished collecting.
 *
 * **Signals** (review round 1). SIGINT, SIGTERM and SIGHUP are forwarded to vitest; when vitest
 * exits, or {@link SIGNAL_GRACE_MS} later, or on a second signal, every PID of the tree as it stood
 * when the signal came is sent `SIGKILL` — a fork worker spinning in a `describe` body never reads
 * its parent's death, and would otherwise be left running under PID 1. The runner then exits with
 * `128 +` the signal's number. The PIDs are the ones recorded at the signal, so a process of the tree
 * that exited and whose number the system reused within those seconds would receive the `SIGKILL`
 * instead; that window is the grace period, and it is accepted rather than closed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * How long one file may take to collect. The slowest collection measured on `main` (WP-213, a
 * whole `unit` + `contract` + `process` run with coverage at a one-minute load of 6–10) was 3.9 s,
 * `fake-workspace-provider.contract.test.ts`; `ui`'s slowest was 3.5 s. Two minutes is thirty times
 * that, for a busy host.
 */
export const COLLECTION_BOUND_MS = 120_000;

/** Overrides the bound — for this runner's own test, which plants a stall and cannot wait two minutes. */
export const COLLECTION_BOUND_ENV = 'VERIFY_COLLECTION_BOUND_MS';

/** A path `scripts/verify.mjs` reads after a failed step: the stalled file, when there was one. */
export const STALL_REPORT_ENV = 'VERIFY_STALL_REPORT';

/** How long vitest is given to stop on a forwarded signal before its tree is killed. */
export const SIGNAL_GRACE_MS = 5_000;

const FORWARDED_SIGNALS = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);

const REPORTER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'support',
  'collection-reporter.ts',
);

/**
 * The files collecting now and since when, oldest first, and when the run last did anything.
 *
 * @param {number} boundMs
 * @param {number} startedAt
 */
export const createCollectionWatchdog = (boundMs, startedAt) => {
  /** @type {Map<string, { readonly file: string; readonly since: number }>} */
  const collecting = new Map();
  let lastActivity = startedAt;
  return {
    /** @param {{ readonly project: string; readonly file: string }} module @param {number} at */
    queued(module, at) {
      collecting.set(`${module.project}\0${module.file}`, { file: module.file, since: at });
      lastActivity = at;
    },
    /** @param {{ readonly project: string; readonly file: string }} module @param {number} at */
    collected(module, at) {
      collecting.delete(`${module.project}\0${module.file}`);
      lastActivity = at;
    },
    /** @param {number} at */
    active(at) {
      lastActivity = at;
    },
    /**
     * The oldest file still collecting, once it and the whole run have been quiet for the bound.
     *
     * @param {number} at
     * @returns {string | null}
     */
    stalled(at) {
      if (at - lastActivity < boundMs) {
        return null;
      }
      for (const { file, since } of collecting.values()) {
        if (at - since >= boundMs) {
          return file;
        }
      }
      return null;
    },
  };
};

/**
 * `root` and every process descended from it, parents before children.
 *
 * @param {number} root
 * @param {ReadonlyArray<readonly [number, number]>} table `[pid, ppid]` rows
 * @returns {number[]}
 */
export const processTree = (root, table) => {
  const tree = [root];
  for (let index = 0; index < tree.length; index += 1) {
    for (const [pid, ppid] of table) {
      if (ppid === tree[index] && !tree.includes(pid)) {
        tree.push(pid);
      }
    }
  }
  return tree;
};

/** @returns {Array<[number, number]>} every process's `[pid, ppid]` */
export const processTable = () => {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (ps.status !== 0) {
    throw new Error(`ps exited with ${ps.status ?? ps.signal}: ${ps.stderr}`);
  }
  return ps.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      return [pid ?? 0, ppid ?? 0];
    });
};

/**
 * Sends `SIGKILL` to each PID. A process that has already gone is not an error.
 *
 * @param {readonly number[]} pids
 */
export const killPids = (pids) => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') {
        throw error;
      }
    }
  }
};

/**
 * Sends `SIGKILL` to `root` and its descendants, by PID, children first.
 *
 * @param {number} root
 */
export const killProcessTree = (root) => {
  killPids(processTree(root, processTable()).reverse());
};

/**
 * @param {string} target
 * @param {string} file
 */
export const stallLine = (target, file) => `FAIL: ${target} — collection stalled in ${file}`;

/** @param {readonly string[]} args */
const run = async (args) => {
  const require = createRequire(import.meta.url);
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const boundMs = Number(process.env[COLLECTION_BOUND_ENV] ?? COLLECTION_BOUND_MS);
  // `--reporter` replaces vitest's defaults, so they are named again unless the caller chose.
  const chosen = args.some((arg) => arg === '--reporter' || arg.startsWith('--reporter='));
  const { configDefaults } = await import('vitest/config');
  const defaults = chosen
    ? []
    : configDefaults.reporters.flatMap((reporter) =>
        typeof reporter === 'string' ? [`--reporter=${reporter}`] : [],
      );
  const child = spawn(process.execPath, [vitest, ...args, ...defaults, `--reporter=${REPORTER}`], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  const root = /** @type {number} */ (child.pid);
  const watchdog = createCollectionWatchdog(boundMs, Date.now());
  /** @type {string | null} */
  let stalled = null;
  /** @type {NodeJS.Signals | null} */
  let received = null;
  /** @type {number[]} */
  let signalled = [];
  child.on('message', (/** @type {any} */ message) => {
    if (message?.event === 'queued') {
      watchdog.queued(message, Date.now());
    } else if (message?.event === 'collected') {
      watchdog.collected(message, Date.now());
    } else if (message?.event === 'activity') {
      watchdog.active(Date.now());
    }
  });
  const timer = setInterval(
    () => {
      const file = watchdog.stalled(Date.now());
      if (file !== null && stalled === null && received === null) {
        stalled = file;
        killProcessTree(root);
      }
    },
    Math.min(1_000, boundMs),
  );
  /** @type {NodeJS.Timeout | undefined} */
  let grace;
  const killSignalled = () => killPids([...signalled].reverse());
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      if (received !== null) {
        killSignalled();
        killProcessTree(root);
        return;
      }
      received = signal;
      signalled = processTree(root, processTable());
      child.kill(signal);
      grace = setTimeout(() => {
        killSignalled();
        killProcessTree(root);
      }, SIGNAL_GRACE_MS);
    });
  }
  child.on('exit', (code, signal) => {
    clearInterval(timer);
    clearTimeout(grace);
    if (received !== null) {
      // A worker the signal did not reach outlives vitest under PID 1; it is still in the list.
      killSignalled();
      process.exitCode = 128 + constants.signals[received];
      return;
    }
    if (stalled === null) {
      process.exitCode = code ?? 1;
      if (signal !== null) {
        process.stderr.write(`vitest ended on ${signal}\n`);
      }
      return;
    }
    const target = process.env.VERIFY_TARGET ?? process.env.npm_lifecycle_event ?? 'vitest';
    process.stderr.write(`\n${stalled} did not finish collecting in ${boundMs / 1000} s\n`);
    process.stdout.write(`${stallLine(target, stalled)}\n`);
    const report = process.env[STALL_REPORT_ENV];
    if (report !== undefined && report !== '') {
      writeFileSync(report, stalled);
    }
    process.exitCode = 1;
  });
};

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await run(process.argv.slice(2));
}
