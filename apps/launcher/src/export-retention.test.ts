/**
 * The export directory's retention (WP-44, Q93): fourteen days, only the launcher's own files, never
 * through a symlink. On a real directory, because `lstat` and `unlink` are the behaviour.
 */
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TAKEN_OVER_WORKSPACE_KEEP_DAYS } from '@platform/application';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_FILE_NAME, EXPORT_RETENTION_MS, sweepExportDirectory } from './export-retention.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = new Date('2026-09-26T12:00:00.000Z');
const OLD_RUN = '00000000-0000-4000-8000-0000000000a1';
const NEW_RUN = '00000000-0000-4000-8000-0000000000a2';

const ageFile = async (file: string, days: number): Promise<void> => {
  const at = new Date(NOW.getTime() - days * DAY_MS);
  await utimes(file, at, at);
};

describe('the take-over export retention', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wp44-export-sweep-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is the taken-over workspace’s own window, not a second number', () => {
    expect(EXPORT_RETENTION_MS).toBe(TAKEN_OVER_WORKSPACE_KEEP_DAYS * DAY_MS);
    expect(TAKEN_OVER_WORKSPACE_KEEP_DAYS).toBe(14);
  });

  it('removes a tarball past fourteen days and keeps one inside them — both sides of the edge', async () => {
    const old = path.join(dir, `${OLD_RUN}.tar`);
    const fresh = path.join(dir, `${NEW_RUN}.tar`);
    await writeFile(old, 'old');
    await writeFile(fresh, 'fresh');
    await ageFile(old, 14.01);
    await ageFile(fresh, 13.99);
    const report = await sweepExportDirectory({ directory: dir, now: NOW });
    expect(report).toEqual({ examined: 2, removed: 1, failed: 0 });
    expect(await readdir(dir)).toEqual([`${NEW_RUN}.tar`]);
  });

  it('leaves every name it did not write, however old', async () => {
    const operator = path.join(dir, 'notes.txt');
    const lookalike = path.join(dir, 'backup.tar');
    await writeFile(operator, 'mine');
    await writeFile(lookalike, 'mine too');
    await ageFile(operator, 400);
    await ageFile(lookalike, 400);
    const report = await sweepExportDirectory({ directory: dir, now: NOW });
    expect(report).toEqual({ examined: 0, removed: 0, failed: 0 });
    expect((await readdir(dir)).sort()).toEqual(['backup.tar', 'notes.txt']);
  });

  it('never follows or removes a symlink, even one with the launcher’s name', async () => {
    const target = path.join(dir, 'elsewhere');
    await mkdir(target);
    const victim = path.join(target, 'keep.me');
    await writeFile(victim, 'x');
    await ageFile(victim, 400);
    await symlink(victim, path.join(dir, `${OLD_RUN}.tar`));
    const report = await sweepExportDirectory({ directory: dir, now: NOW });
    expect(report.removed).toBe(0);
    expect((await lstat(path.join(dir, `${OLD_RUN}.tar`))).isSymbolicLink()).toBe(true);
    expect((await lstat(victim)).isFile()).toBe(true);
  });

  it('treats a directory that was never created as empty', async () => {
    const report = await sweepExportDirectory({ directory: path.join(dir, 'absent'), now: NOW });
    expect(report).toEqual({ examined: 0, removed: 0, failed: 0 });
  });

  it('owns exactly the name the launcher composes', () => {
    expect(EXPORT_FILE_NAME.test(`${OLD_RUN}.tar`)).toBe(true);
    expect(EXPORT_FILE_NAME.test(`${OLD_RUN}.tar.gz`)).toBe(false);
    expect(EXPORT_FILE_NAME.test(`../${OLD_RUN}.tar`)).toBe(false);
  });
});
