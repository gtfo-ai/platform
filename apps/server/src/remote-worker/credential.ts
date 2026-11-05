/**
 * **The worker credential and the device login** — WP-283 (1), TD-031 decisions 7 and 10c,
 * BD-032 decision 8.
 *
 * The credential (`wkr_<id>_<secret>`) is the worker's identity: it authenticates `handshake` and
 * `claims` and is tied to the user who approved the machine. It lives in **one file** on the
 * `worker-state` volume, `credential`, written `0600` with an atomic rename, and is read back at
 * every start — so a worker restarted by its updater is the same machine, and deleting the file (or
 * revoking the worker on the core) is how a developer logs it out.
 *
 * With no file, the worker logs in with RFC 8628's device flow on the platform's own auth (never
 * claude.ai's): `POST device` → a user code the worker **logs** with the verification URL, then
 * `POST device/token` every `interval` seconds — `slow_down` adds five seconds (RFC 8628 §3.5),
 * `access_denied`/`expired_token` start over with a new code — until the developer approves it and
 * the credential is answered, once.
 *
 * **A credential belongs to one core** (WP-294, TD-031's first-run amendment §3): the file records
 * the core's origin on its second line, and a credential recorded for another origin is ignored — a
 * worker repointed at another platform logs in there anew. A file with no second line (written
 * before WP-294, for the one core its environment named) is read for whichever core is configured.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@platform/application';
import { workerCredentialSchema } from '@platform/contracts';
import { type CoreClient, isTransient } from './core-client.js';
import { backoffMs, sleepMs } from './retry.js';

/** The credential's file name inside `APP_WORKER_STATE_DIR`. */
export const CREDENTIAL_FILE = 'credential';

/** RFC 8628 §3.5: a `slow_down` adds this to the polling interval. */
export const SLOW_DOWN_STEP_SECONDS = 5;

/**
 * The stored credential, or `null` when there is none, the file holds something else, or it was
 * recorded for another core than `origin` (WP-294).
 */
export const readStoredCredential = async (
  stateDir: string,
  origin?: string,
): Promise<string | null> => {
  let text: string;
  try {
    text = await readFile(path.join(stateDir, CREDENTIAL_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const [first = '', second = ''] = text.trim().split('\n');
  const recordedFor = second.trim();
  if (origin !== undefined && recordedFor !== '' && recordedFor !== origin) return null;
  const parsed = workerCredentialSchema.safeParse(first.trim());
  return parsed.success ? parsed.data : null;
};

/**
 * Writes the credential `0600`, atomically: a crash leaves the old file or the new one. `origin`,
 * when given, is recorded on the second line: the core the credential belongs to (WP-294).
 */
export const storeCredential = async (
  stateDir: string,
  credential: string,
  origin?: string,
): Promise<void> => {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = path.join(stateDir, CREDENTIAL_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${credential}\n${origin === undefined ? '' : `${origin}\n`}`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
};

export interface DeviceLoginOptions {
  readonly core: CoreClient;
  readonly stateDir: string;
  readonly logger: Logger;
  /** `true` to stop waiting (the process is stopping). */
  readonly stopped: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called with each new code — what a person types on the approval page. */
  readonly onCode?: (code: {
    readonly userCode: string;
    readonly verificationUri: string;
    /** When the code expires, by this machine's clock. */
    readonly expiresAt: Date;
  }) => void;
  /** Called when the core gave no code and is asked again after `waitMs` (WP-294's page). */
  readonly onUnreachable?: (error: unknown, waitMs: number) => void;
  /** The core's origin the stored credential must have been recorded for (WP-294). */
  readonly origin?: string;
}

/**
 * The stored credential, or one obtained with the device flow and stored. Resolves `null` only when
 * {@link DeviceLoginOptions.stopped} turned true first.
 */
export const ensureCredential = async (options: DeviceLoginOptions): Promise<string | null> => {
  const stored = await readStoredCredential(options.stateDir, options.origin);
  if (stored !== null) return stored;
  const sleep = options.sleep ?? sleepMs;
  let failures = 0;
  while (!options.stopped()) {
    let code: Awaited<ReturnType<CoreClient['device']>>;
    try {
      code = await options.core.device();
      failures = 0;
    } catch (error) {
      if (!isTransient(error)) throw error;
      failures += 1;
      const wait = backoffMs(failures);
      options.logger.warn(
        { err: error, wait_ms: wait },
        'the core did not give this worker a device code; asking again',
      );
      options.onUnreachable?.(error, wait);
      await sleep(wait);
      continue;
    }
    options.onCode?.({
      userCode: code.user_code,
      verificationUri: code.verification_uri,
      expiresAt: new Date(Date.now() + code.expires_in * 1_000),
    });
    options.logger.info(
      {
        user_code: code.user_code,
        verification_uri: code.verification_uri,
        expires_in_seconds: code.expires_in,
      },
      `to connect this worker, open ${code.verification_uri} signed in to the platform and enter the code ${code.user_code}`,
    );
    let interval = code.interval;
    const expiresAt = Date.now() + code.expires_in * 1_000;
    while (!options.stopped() && Date.now() < expiresAt) {
      await sleep(interval * 1_000);
      if (options.stopped()) return null;
      let answer: Awaited<ReturnType<CoreClient['deviceToken']>>;
      try {
        answer = await options.core.deviceToken(code.device_code);
      } catch (error) {
        if (!isTransient(error)) throw error;
        continue;
      }
      if (answer.kind === 'credential') {
        await storeCredential(options.stateDir, answer.credential, options.origin);
        options.logger.info(
          { worker_id: answer.workerId },
          'this worker is approved; its credential is stored in the worker-state volume',
        );
        return answer.credential;
      }
      if (answer.kind === 'slow_down') {
        interval += SLOW_DOWN_STEP_SECONDS;
        continue;
      }
      if (answer.kind === 'access_denied' || answer.kind === 'expired_token') {
        options.logger.warn(
          { outcome: answer.kind },
          'the device code was not approved; a new one is asked for',
        );
        break;
      }
    }
  }
  return null;
};
