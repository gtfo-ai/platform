/**
 * **What the first-run wizard keeps** — WP-294, TD-031's 2026-11-05 first-run amendment §1, §3–4 —
 * and, since WP-295, the *Error reporting* setting.
 *
 * Three files in the `worker-state` volume beside `credential` and `ui-token`, each written `0600`
 * with an atomic rename (a crash leaves the old file or the new one — `credential.ts`'s rule):
 *
 * | file | holds | written by |
 * |---|---|---|
 * | `core-url` | the platform's origin | *Connect to a platform* |
 * | `claude-token` | the developer's Claude token, the CLI's `sk-ant-oat01-…` | *Sign in to Claude* or *Paste a token instead* |
 * | `sentry-dsn` | the *Error reporting* DSN (WP-295, TD-023's 2026-11-05 amendment §3) | the page's *Save*; *Remove* deletes it |
 *
 * Each is read only when the environment has no value (environment → file → wizard), and each is
 * deleted by the page's own undo: *Change platform*, *Sign out* and *Remove*.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_OAUTH_TOKEN_SHAPE } from '@platform/contracts';
import { errorReporting } from '@platform/infrastructure';
import { coreOriginOf } from './config.js';

export const CORE_URL_FILE = 'core-url';
export const CLAUDE_TOKEN_FILE = 'claude-token';
export const SENTRY_DSN_FILE = 'sentry-dsn';

/**
 * A Claude token's shape: the CLI's long-lived OAuth token (V-WM4, V-WM10 — `sk-ant-oat01-`, 108
 * characters as the owner's run printed it). Bounded generously on both sides: the check that
 * matters is Claude's own (`claude-sign-in.ts`'s `checkClaudeToken`).
 */
export const CLAUDE_TOKEN_SHAPE: RegExp = CLAUDE_OAUTH_TOKEN_SHAPE;

const readText = async (file: string): Promise<string | null> => {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

/** Writes `text` `0600`, atomically. */
export const writePrivateFile = async (
  stateDir: string,
  name: string,
  text: string,
): Promise<void> => {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = path.join(stateDir, name);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${text}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
};

export const removeFile = async (stateDir: string, name: string): Promise<void> => {
  await rm(path.join(stateDir, name), { force: true });
};

/** The stored platform origin, or `null` (none, or a file that no longer reads as one). */
export const readStoredCoreUrl = async (stateDir: string): Promise<string | null> => {
  const text = await readText(path.join(stateDir, CORE_URL_FILE));
  return text === null ? null : coreOriginOf(text);
};

/** The stored Claude token, or `null` (none, or a file in another shape). */
export const readStoredClaudeToken = async (stateDir: string): Promise<string | null> => {
  const text = await readText(path.join(stateDir, CLAUDE_TOKEN_FILE));
  return text !== null && CLAUDE_TOKEN_SHAPE.test(text) ? text : null;
};

/** The stored error-reporting DSN, canonical, or `null` (none, or a file that no longer reads as one). */
export const readStoredSentryDsn = async (stateDir: string): Promise<string | null> => {
  const text = await readText(path.join(stateDir, SENTRY_DSN_FILE));
  if (text === null) return null;
  const verdict = errorReporting.parseErrorReportingDsn(text);
  return verdict.ok ? verdict.dsn : null;
};
