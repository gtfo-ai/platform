/**
 * **The worker bundle's launcher token, generated at first start** — WP-284 (1).
 *
 * `compose.worker.yml` runs this once before the launcher and the worker (`launcher-token`, a
 * one-shot service of the `platform` image): it writes 32 random bytes, base64url, to the file it is
 * given — `0600`, atomically — **only when the file does not exist yet**, so a restart keeps the
 * token both containers already read through `APP_LAUNCHER_TOKEN_FILE`. Nobody types it and nothing
 * else holds it: the file lives on a volume only the launcher and the worker mount.
 *
 * `node --import ./scripts/ts-source-resolver.mjs apps/server/src/remote-worker/launcher-token.ts <file>`
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/** Writes a fresh token to `file` unless one is there; answers whether it wrote one. */
export const ensureLauncherToken = async (file: string): Promise<boolean> => {
  try {
    const existing = await stat(file);
    if (existing.isFile() && existing.size > 0) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, randomBytes(32).toString('base64url'), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
  return true;
};

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);
if (isMain) {
  const file = process.argv[2];
  if (file === undefined || !path.isAbsolute(file)) {
    process.stderr.write('usage: launcher-token.ts <absolute path of the token file>\n');
    process.exitCode = 2;
  } else {
    try {
      const wrote = await ensureLauncherToken(file);
      process.stdout.write(
        wrote
          ? `a launcher token was generated at ${file}\n`
          : `the launcher token at ${file} is kept\n`,
      );
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  }
}
