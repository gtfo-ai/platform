/**
 * **The local page's token** — WP-292, TD-031's 2026-11-04 worker-UI amendment §2.
 *
 * 32 random bytes in unpadded base64url, generated on the worker's first start and kept in the
 * `worker-state` volume as `ui-token`, mode `0600`, written with an atomic rename (the credential
 * file's rule, `credential.ts`). **Rotated by deleting the file**: the next start makes a new one.
 * Every start logs the page's URL with the token in the **fragment** (`#token=…`), which no browser
 * sends in a request line; the page moves it to `sessionStorage` and strips it from the address.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The token's file name inside `APP_WORKER_STATE_DIR`. */
export const UI_TOKEN_FILE = 'ui-token';

/** 32 bytes, unpadded base64url: 43 characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The stored token, or a new one stored `0600` — a file in another shape is replaced. */
export const ensureUiToken = async (stateDir: string): Promise<string> => {
  const target = path.join(stateDir, UI_TOKEN_FILE);
  try {
    const stored = (await readFile(target, 'utf8')).trim();
    if (TOKEN_SHAPE.test(stored)) return stored;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('base64url');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${token}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  return token;
};

/** Whether `presented` is the token — compared in constant time over equal-length digests. */
export const isUiToken = (token: string, presented: string | null): boolean => {
  if (presented === null) return false;
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  // Equal lengths first, without branching on the content: a different length is a refusal, and
  // comparing `a` with itself keeps the work the same.
  return timingSafeEqual(a, b.length === a.length ? b : a) && b.length === a.length;
};

/** The page's address for a person, the token in the fragment (amendment §2). */
export const uiAddressOf = (publishedPort: number, token: string): string =>
  `http://127.0.0.1:${publishedPort}/#token=${token}`;

/** The page's address under `APP_WORKER_UI_AUTH=none` (TD-031's no-bearer amendment §1). */
export const plainUiAddressOf = (publishedPort: number): string =>
  `http://127.0.0.1:${publishedPort}`;
