/**
 * **The updater's liveness** (backlog 981): a file in its `updates` volume that `compose.worker.yml`'s
 * `healthcheck` reads with `test`, because `ROLE=updater` serves no HTTP and the `platform` image's own
 * `HEALTHCHECK` (`curl 127.0.0.1:${PORT}/healthz`) failed for ever on it — the first self-update on
 * Autix showed the updater `unhealthy` with a failing streak of 122.
 *
 * The file holds the **epoch second by which the next beat is due** ({@link HEARTBEAT_STALE_AFTER_MS}
 * from the beat), so the check needs no clock arithmetic and no knowledge of the interval:
 * `test "$(cat heartbeat)" -gt "$(date +%s)"`. A beat is written on a timer of its own rather than by
 * the poll loop, whose one step may legitimately wait half an hour on a pull or for a run to finish;
 * what it proves is that the process and its event loop are alive. It is written to a temporary file
 * and renamed, so the check never reads half a number.
 */
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The file in the updater's state directory (`APP_UPDATE_STATE_DIR`). */
export const HEARTBEAT_FILE = 'heartbeat';
/** How often the updater writes it. */
export const HEARTBEAT_EVERY_MS = 30_000;
/** How long a beat stays good: three intervals, so one late write is not an unhealthy container. */
export const HEARTBEAT_STALE_AFTER_MS = 3 * HEARTBEAT_EVERY_MS;

/** Writes one beat: the epoch second after which this one is stale. */
export const writeHeartbeat = async (stateDir: string, now: Date): Promise<void> => {
  const file = path.join(stateDir, HEARTBEAT_FILE);
  const temporary = `${file}.tmp`;
  const dueBy = Math.floor((now.getTime() + HEARTBEAT_STALE_AFTER_MS) / 1000);
  await writeFile(temporary, `${dueBy}\n`, { mode: 0o644 });
  await rename(temporary, file);
};
