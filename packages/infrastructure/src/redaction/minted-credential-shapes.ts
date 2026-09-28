/**
 * Reading `minted_credential_shapes` into the process's redaction rules — TD-012's M5 amendment,
 * WP-80, PROGRESS backlog 259.
 *
 * The minting process writes a shape in the transaction of the mint's audit row
 * (`../integrations/postgres-audit-log.ts`); **every** product process reads the unexpired ones
 * and compiles one step-2 rule per shape (`installMintedCredentialShapes`). The amendment says
 * *"at composition and on the existing configuration refresh"*; the platform has no process-wide
 * configuration refresh (the repository-config refresh is per project and on demand), so this is
 * that refresh, stated as what it is: a read at start that **fails the start** when it cannot be
 * made, and a read every {@link MINTED_CREDENTIAL_SHAPE_REFRESH_MS} after that which **keeps the
 * last rules** when it fails — a transient database error must not take a process's rules away.
 *
 * **The window, stated rather than implied.** A shape minted in one process reaches another's rules
 * at its next refresh, so a value quoted into text that the second process stores within that
 * interval of the mint is covered by the `glpat-` pattern rule and nothing else. A run credential is
 * minted before its container is created, and the text that quotes it has to be written by the
 * agent, pushed to a provider and delivered back by a webhook, so the interval is far shorter than
 * the path; it is not zero, and a notification on commit would narrow it further at the cost of one
 * more held connection per process.
 */
import type { Logger, MintedCredentialShape } from '@platform/application';
import { mintedCredentialShapeSchema, silentLogger } from '@platform/application';
import type { SqlExecutor } from '../events/sql.js';
import { installMintedCredentialShapes } from './pattern-redaction.js';

/** How often a process re-reads the shapes. Small, because the table is a handful of rows. */
export const MINTED_CREDENTIAL_SHAPE_REFRESH_MS = 5_000;

interface ShapeRow extends Record<string, unknown> {
  readonly prefix: string;
  readonly charset: string;
  readonly length: number;
}

/**
 * The distinct unexpired shapes. `now()` is the database's, as every freshness comparison on the
 * platform's own tables is. A row that fails the schema — which the table's checks make
 * unreachable — is dropped here and counted by the caller's install.
 */
export const readMintedCredentialShapes = async (
  sql: SqlExecutor,
): Promise<readonly MintedCredentialShape[]> => {
  const { rows } = await sql.query<ShapeRow>(
    `select distinct prefix, charset, length
       from minted_credential_shapes
      where expires_at > now()
      order by prefix, charset, length`,
  );
  const shapes: MintedCredentialShape[] = [];
  for (const row of rows) {
    const parsed = mintedCredentialShapeSchema.safeParse({
      prefix: row.prefix,
      charset: row.charset,
      length: Number(row.length),
    });
    if (parsed.success) {
      shapes.push(parsed.data);
    }
  }
  return shapes;
};

export interface MintedCredentialShapeRefresh {
  /** Reads and installs now; resolves to how many rules the process holds after it. */
  refresh(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * Loads the shapes once — **throwing** if it cannot, so a process never starts serving with fewer
 * rules than the database says it needs — then refreshes them on an unref'd interval until stopped.
 */
export const startMintedCredentialShapeRefresh = async (options: {
  readonly sql: SqlExecutor;
  readonly logger?: Logger;
  readonly intervalMs?: number;
}): Promise<MintedCredentialShapeRefresh> => {
  const logger = options.logger ?? silentLogger;
  const refresh = async (): Promise<number> => {
    const shapes = await readMintedCredentialShapes(options.sql);
    const { installed, refused } = installMintedCredentialShapes(shapes);
    if (refused > 0) {
      logger.error(
        { installed, refused },
        'a minted-credential shape could not be compiled into a redaction rule and was skipped; a run credential of that shape is redacted in this process only by the exact-value step of the process that minted it (PROGRESS backlog 259)',
      );
    }
    return installed;
  };
  const installed = await refresh();
  logger.info(
    { rules: installed },
    'minted-credential shape rules loaded: a run credential minted by any process is redacted by its shape in this one (TD-012, WP-80)',
  );
  let running: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    running = refresh().catch((error: unknown) => {
      logger.warn(
        { err: error },
        'the minted-credential shape refresh failed; this process keeps the rules it had (PROGRESS backlog 259)',
      );
    });
  }, options.intervalMs ?? MINTED_CREDENTIAL_SHAPE_REFRESH_MS);
  timer.unref();
  return {
    refresh,
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
};
