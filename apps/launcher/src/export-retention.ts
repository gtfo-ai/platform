/**
 * The retention of the take-over export directory (WP-44, PROGRESS backlog 68, Q93).
 *
 * Until this module nothing deleted from `APP_WORKSPACE_EXPORT_DIR`: the launcher wrote one tarball
 * per take-over that asked for one and the volume grew for ever — so the tarball was immortal while
 * the transcript beside it is purged by `APP_TRANSCRIPT_RETENTION_DAYS`, the opposite of any policy
 * anybody chose. Q93 is answered per its recommendation: the directory gets **the same retention the
 * workspace volume has for a taken-over run** — `TAKEN_OVER_WORKSPACE_KEEP_DAYS`, fourteen days
 * (technical/05 §5) — read from the one constant rather than restated, so the two windows cannot
 * drift apart.
 *
 * ## Why here, on the launcher's sweep, and not in the API process
 *
 * The launcher is the writer, it already runs a retention pass on a timer (`LauncherService.sweep`)
 * and it is the one process guaranteed to mount the directory: the API container mounts the same
 * volume to *serve* it, but a split deployment may leave the variable unset there, and a sweep that
 * ran only where the reader happens to be configured would be a sweep that sometimes never runs.
 *
 * ## What it removes, and what it leaves
 *
 * Only what the launcher itself writes: a **regular file** named `<uuid>.tar` whose modification
 * time is older than the window. The name test is the scope — an operator who keeps something else
 * on the volume keeps it — and the file test is `lstat`, so a symlink is never followed and never
 * removed (the directory is shared, and a sweep that followed a link would delete somewhere else).
 * The clock is the file's own mtime, which is the moment the export finished writing it: the
 * take-over's instant is not recorded anywhere this process can read (`workspaces` has never held a
 * row), and the difference is the few seconds an export takes.
 *
 * A file that cannot be removed is **reported and kept**, never retried in a loop: the next pass an
 * hour later is the retry, and the summary line counts it so an operator can see a volume that has
 * stopped shrinking.
 */
import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TAKEN_OVER_WORKSPACE_KEEP_DAYS } from '@platform/application';

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Q93: the export directory keeps a tarball exactly as long as the taken-over workspace. */
export const EXPORT_RETENTION_MS = TAKEN_OVER_WORKSPACE_KEEP_DAYS * DAY_MS;

/** The only names this sweep may remove: what `LauncherService.endRun` writes, `<run id>.tar`. */
export const EXPORT_FILE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tar$/;

export interface ExportSweepReport {
  /** Files whose name is one this sweep owns. */
  readonly examined: number;
  readonly removed: number;
  /** Removals that failed; the files are still there and the next pass tries again. */
  readonly failed: number;
}

/**
 * One pass over the export directory.
 *
 * A directory that does not exist is an empty report, not an error: a launcher that has never
 * exported anything has never created it (`#writeTarball` makes it on first use).
 */
export const sweepExportDirectory = async (input: {
  readonly directory: string;
  readonly now: Date;
  readonly retentionMs?: number;
}): Promise<ExportSweepReport> => {
  const cutoff = input.now.getTime() - (input.retentionMs ?? EXPORT_RETENTION_MS);
  let names: string[];
  try {
    names = await readdir(input.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { examined: 0, removed: 0, failed: 0 };
    }
    throw error;
  }
  let examined = 0;
  let removed = 0;
  let failed = 0;
  for (const name of names) {
    if (!EXPORT_FILE_NAME.test(name)) {
      continue;
    }
    const file = path.join(input.directory, name);
    const info = await lstat(file).catch(() => null);
    if (info === null || !info.isFile()) {
      continue;
    }
    examined += 1;
    if (info.mtimeMs >= cutoff) {
      continue;
    }
    try {
      await unlink(file);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { examined, removed, failed };
};
