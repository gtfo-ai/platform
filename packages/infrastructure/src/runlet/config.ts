/**
 * The shim's own configuration, read from the environment the launcher gives the run container.
 *
 * Naming (TD-020): `APP_*` is the *platform's* settings and these are not the platform's — the
 * runlet is a bundled CLI in a different image, set up by the launcher (WP-14), never by an
 * operator editing `.env`. So it takes tool-native `RUNLET_*` names, and the secret one carries the
 * `_FILE` variant the convention requires. `.env.example` documents them anyway, because an
 * operator debugging a run container will meet them.
 *
 * The token is read from a **file** by preference. Not because that hides it from the agent —
 * nothing inside one container can (see `shim.ts` § "The trust boundary, stated honestly") — but
 * because `/proc/<pid>/environ` is visible to *every* process in the container including any the
 * repository's own `setup` script started, while a file on `/ctl` is one path the launcher controls
 * and can unlink.
 */
import { readFileSync } from 'node:fs';
import * as z from 'zod';
import { validateRunToken } from './token.js';

const positiveInt = z.coerce.number().int().positive();

/**
 * Strict, so a typo in a launcher-rendered variable is a startup failure rather than a default.
 * Unknown `RUNLET_*` names are not the schema's business — `process.env` carries the world — so the
 * caller passes exactly the keys below.
 */
export const runletEnvSchema = z.strictObject({
  RUNLET_CONTROL_SOCKET: z.string().min(1),
  RUNLET_CREDENTIAL_SOCKET: z.string().min(1).optional(),
  RUNLET_TOKEN: z.string().optional(),
  RUNLET_TOKEN_FILE: z.string().min(1).optional(),
  RUNLET_KILL_GRACE_MS: positiveInt.optional(),
  RUNLET_HANDSHAKE_TIMEOUT_MS: positiveInt.optional(),
  RUNLET_CREDENTIAL_TIMEOUT_MS: positiveInt.optional(),
  RUNLET_MAX_CREDENTIAL_REQUESTS: positiveInt.optional(),
  RUNLET_CHILD_UID: z.coerce.number().int().min(0).optional(),
  RUNLET_CHILD_GID: z.coerce.number().int().min(0).optional(),
  RUNLET_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
});

export interface RunletConfig {
  readonly controlSocketPath: string;
  readonly credentialSocketPath: string | null;
  readonly token: string;
  readonly killGraceMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly credentialTimeoutMs?: number;
  readonly maxCredentialRequests?: number;
  readonly childUid: number | null;
  readonly childGid: number | null;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

const optional = <T>(key: string, value: T | undefined): Record<string, T> =>
  value === undefined ? {} : { [key]: value };

/**
 * Reads the config, or throws. There is no partially-configured shim: a missing socket path or a
 * blank token stops the container at startup, which is the failure an operator can see.
 */
export const readRunletConfig = (
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): RunletConfig => {
  const parsed = runletEnvSchema.parse({
    RUNLET_CONTROL_SOCKET: env['RUNLET_CONTROL_SOCKET'],
    ...optional('RUNLET_CREDENTIAL_SOCKET', env['RUNLET_CREDENTIAL_SOCKET']),
    ...optional('RUNLET_TOKEN', env['RUNLET_TOKEN']),
    ...optional('RUNLET_TOKEN_FILE', env['RUNLET_TOKEN_FILE']),
    ...optional('RUNLET_KILL_GRACE_MS', env['RUNLET_KILL_GRACE_MS']),
    ...optional('RUNLET_HANDSHAKE_TIMEOUT_MS', env['RUNLET_HANDSHAKE_TIMEOUT_MS']),
    ...optional('RUNLET_CREDENTIAL_TIMEOUT_MS', env['RUNLET_CREDENTIAL_TIMEOUT_MS']),
    ...optional('RUNLET_MAX_CREDENTIAL_REQUESTS', env['RUNLET_MAX_CREDENTIAL_REQUESTS']),
    ...optional('RUNLET_CHILD_UID', env['RUNLET_CHILD_UID']),
    ...optional('RUNLET_CHILD_GID', env['RUNLET_CHILD_GID']),
    ...optional('RUNLET_LOG_LEVEL', env['RUNLET_LOG_LEVEL']),
  });

  // `_FILE` wins, per TD-020. `trim()` because a file written with a trailing newline is the
  // normal case and a token that differs from the runner's by one byte is a run that never starts.
  const token = validateRunToken(
    parsed.RUNLET_TOKEN_FILE === undefined
      ? parsed.RUNLET_TOKEN
      : readFile(parsed.RUNLET_TOKEN_FILE).trim(),
  );

  return {
    controlSocketPath: parsed.RUNLET_CONTROL_SOCKET,
    credentialSocketPath: parsed.RUNLET_CREDENTIAL_SOCKET ?? null,
    token,
    ...optional('killGraceMs', parsed.RUNLET_KILL_GRACE_MS),
    ...optional('handshakeTimeoutMs', parsed.RUNLET_HANDSHAKE_TIMEOUT_MS),
    ...optional('credentialTimeoutMs', parsed.RUNLET_CREDENTIAL_TIMEOUT_MS),
    ...optional('maxCredentialRequests', parsed.RUNLET_MAX_CREDENTIAL_REQUESTS),
    childUid: parsed.RUNLET_CHILD_UID ?? null,
    childGid: parsed.RUNLET_CHILD_GID ?? null,
    logLevel: parsed.RUNLET_LOG_LEVEL ?? 'info',
  };
};
