/**
 * The structural waits' bound is the running test's budget, **read off vitest at run time**
 * (WP-69, PROGRESS backlog 25) — and a wait that runs out of its share names what it waited for.
 *
 * Runs in the `process` project, like every file that imports `./structural-wait.js`
 * (`scripts/verify.test.ts` holds the membership).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, TestRunner, vi } from 'vitest';
import {
  currentWaitBudget,
  STRUCTURAL_WAIT_SHARE,
  StructuralWaitExpiredError,
  settlesWithin,
  waitForFile,
  waitForProcessGone,
  waitUntil,
} from './structural-wait.js';

/** Asked at collection time, where no test is running. */
const outsideATest = (() => {
  try {
    currentWaitBudget();
    return null;
  } catch (error) {
    return error as Error;
  }
})();

describe('the budget a structural wait takes its share of', () => {
  it('is the process project’s testTimeout, as vitest resolved it for this test', () => {
    // The number the backlog entry could only infer, read: the project owns 120 s, and no test in
    // the project writes a budget of its own.
    const budget = currentWaitBudget();
    expect(budget.project).toBe('process');
    expect(budget.testTimeoutMs).toBe(120_000);
    expect(budget.allowedMs).toBe(120_000 * STRUCTURAL_WAIT_SHARE);
  });

  it('follows a per-test override, so the wait still fails before the test does', {
    timeout: 8_000,
  }, () => {
    expect(currentWaitBudget().testTimeoutMs).toBe(8_000);
    expect(currentWaitBudget().allowedMs).toBe(6_000);
  });

  it('measures from now, and names no project, when vitest has not recorded either yet', () => {
    // The two fallbacks: a test with no recorded start and a file with no project name. Neither
    // happens under this config; both are what the helper does rather than throw a TypeError.
    const now = Date.now();
    const spy = vi.spyOn(TestRunner, 'getCurrentTest').mockReturnValue({
      timeout: 1_000,
      result: undefined,
      file: { projectName: undefined },
    } as unknown as ReturnType<typeof TestRunner.getCurrentTest>);
    try {
      const budget = currentWaitBudget();
      expect(budget.project).toBe('(unnamed)');
      expect(budget.allowedMs).toBe(1_000 * STRUCTURAL_WAIT_SHARE);
      expect(budget.deadline).toBeGreaterThanOrEqual(now + budget.allowedMs);
    } finally {
      spy.mockRestore();
    }
  });

  it('is refused outside a test, because there is no budget to take a share of', () => {
    expect(outsideATest?.message).toMatch(/must run inside a test/);
  });
});

describe('a wait that runs out', () => {
  it('fails naming the component and the budget, before the test’s own timeout', {
    timeout: 400,
  }, async () => {
    const waited = waitUntil('the shim to spawn the child', () => false);
    await expect(waited).rejects.toBeInstanceOf(StructuralWaitExpiredError);
    await expect(waited).rejects.toThrow(
      /waited for the shim to spawn the child, and it did not happen within 300 ms — 75% of this test's 400 ms budget, which the "process" project owns/,
    );
  });
});

describe('a promise-shaped wait', () => {
  it('answers what the promise answers, and names the component when it never settles', {
    timeout: 400,
  }, async () => {
    expect(await settlesWithin('the frame to arrive', Promise.resolve('spawn.ok'))).toBe(
      'spawn.ok',
    );
    await expect(
      settlesWithin('the shim to answer spawn.ok', new Promise<never>(() => undefined)),
    ).rejects.toThrow(
      /waited for the shim to answer spawn\.ok, and it did not happen within 300 ms/,
    );
  });
});

describe('a wait that is satisfied', () => {
  it('returns once the file exists, and names the path when it never does', {
    timeout: 2_000,
  }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sw-'));
    try {
      const file = path.join(dir, 'ready');
      setTimeout(() => void writeFile(file, 'x'), 50);
      await waitForFile('the marker to be written', file);
      await expect(waitForFile('the other marker', path.join(dir, 'never'))).rejects.toThrow(
        /the other marker \(.*never\)/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns once the operating system no longer knows the pid', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], { stdio: 'ignore' });
    const pid = child.pid as number;
    await waitForProcessGone(pid, 'the child to exit on its own');
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
