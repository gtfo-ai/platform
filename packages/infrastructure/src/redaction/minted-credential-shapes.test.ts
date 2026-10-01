/**
 * The minted-credential shape refresher's own behaviour — WP-107 (TD-012's M6 amendment (1),
 * PROGRESS backlog 276).
 *
 * The database half (a second pool holds a shape another pool's transaction recorded, before the
 * timer) is `test/integration/redaction/minted-credential-shapes.integration.test.ts`, and the
 * per-`ROLE` census is `test/integration/redaction/shape-refresh-roles.integration.test.ts`. What
 * only a unit case can make happen on demand is here: the subscription made before the first read,
 * a notification starting a read, and a run of failed reads crossing the bound — which a real
 * database would have to be broken for, a dozen times in a row.
 */
import {
  type BroadcastListener,
  type LogFields,
  type Logger,
  MINTED_CREDENTIAL_SHAPES_TOPIC,
} from '@platform/application';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import {
  MINTED_CREDENTIAL_SHAPE_FAILURE_BOUND,
  startMintedCredentialShapeRefresh,
} from './minted-credential-shapes.js';
import {
  installedMintedCredentialShapeRules,
  installMintedCredentialShapes,
} from './pattern-redaction.js';

/** A shape no gitleaks rule knows (rule 93: not a real provider's prefix). */
const ROW = { prefix: 'acmepat-', charset: 'token', length: 30 };

afterEach(() => {
  installMintedCredentialShapes([]);
});

interface Line {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly fields: LogFields;
  readonly message: string;
}

const recordingLogger = (): { logger: Logger; lines: Line[] } => {
  const lines: Line[] = [];
  const at =
    (level: Line['level']) =>
    (fields: LogFields, message: string): void => {
      lines.push({ level, fields, message });
    };
  return {
    lines,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  };
};

/** A broadcast with one topic and a hand on the trigger, recording the order of what happened. */
const fakeBroadcast = (order: string[]) => {
  let listener: BroadcastListener | null = null;
  let topics: readonly string[] = [];
  let closed = 0;
  return {
    broadcast: {
      subscribe: async (wanted: readonly string[], heard: BroadcastListener) => {
        order.push('subscribe');
        topics = wanted;
        listener = heard;
        return {
          close: async () => {
            closed += 1;
          },
        };
      },
    },
    notify: () => {
      listener?.({ topic: MINTED_CREDENTIAL_SHAPES_TOPIC, payload: {} });
    },
    topics: () => topics,
    closed: () => closed,
  };
};

/** The table, or a failure, per read — and the order of reads beside the subscription. */
const scriptedSql = (order: string[]) => {
  let rows: readonly Record<string, unknown>[] = [];
  let failing = false;
  const sql: SqlExecutor = {
    query: async <R extends Record<string, unknown>>() => {
      order.push('read');
      if (failing) {
        throw new Error('the database went away');
      }
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
  return {
    sql,
    setRows: (next: readonly Record<string, unknown>[]) => {
      rows = next;
    },
    fail: (value: boolean) => {
      failing = value;
    },
  };
};

describe('the minted-credential shape refresher (WP-107)', () => {
  it('subscribes the shape topic before its first read, and re-reads when a shape is announced', async () => {
    const order: string[] = [];
    const bus = fakeBroadcast(order);
    const table = scriptedSql(order);
    const refresh = await startMintedCredentialShapeRefresh({
      sql: table.sql,
      broadcast: bus.broadcast,
      // An hour: nothing below can be the timer's doing.
      intervalMs: 3_600_000,
    });
    try {
      // Subscribed first, so a shape committed between the two is in the read or announced after.
      expect(order).toEqual(['subscribe', 'read']);
      expect(bus.topics()).toEqual([MINTED_CREDENTIAL_SHAPES_TOPIC]);
      expect(refresh.status()).toMatchObject({ subscribed: true, notifiedReads: 0 });
      expect(installedMintedCredentialShapeRules()).toHaveLength(0);

      table.setRows([ROW]);
      bus.notify();
      await vi.waitFor(() => {
        expect(installedMintedCredentialShapeRules()).toHaveLength(1);
      });
      expect(refresh.status()).toMatchObject({ notifiedReads: 1, timedReads: 0 });
    } finally {
      await refresh.stop();
    }
    expect(refresh.status().subscribed).toBe(false);
    expect(bus.closed()).toBe(1);
  });

  it('closes its subscription when the first read fails, and fails the start', async () => {
    const order: string[] = [];
    const bus = fakeBroadcast(order);
    const table = scriptedSql(order);
    table.fail(true);
    await expect(
      startMintedCredentialShapeRefresh({ sql: table.sql, broadcast: bus.broadcast }),
    ).rejects.toThrow(/went away/);
    expect(bus.closed()).toBe(1);
  });

  /**
   * Criterion 2: failures below the bound warn each time; the bound-th says it once at `error`; the
   * ones past it say nothing above `debug`; and the next success says the process recovered, after
   * which a failure is a warning again.
   */
  it('reports a run of failed reads once at error past the bound, and recovers on a success', async () => {
    const order: string[] = [];
    const bus = fakeBroadcast(order);
    const table = scriptedSql(order);
    table.setRows([ROW]);
    const { logger, lines } = recordingLogger();
    const bound = 3;
    const refresh = await startMintedCredentialShapeRefresh({
      sql: table.sql,
      broadcast: bus.broadcast,
      logger,
      // An hour: every read below is a notification's.
      intervalMs: 3_600_000,
      failureBound: bound,
    });
    const failedRead = async (failures: number): Promise<void> => {
      bus.notify();
      await vi.waitFor(() => {
        expect(refresh.status().consecutiveFailures).toBe(failures);
      });
    };
    const levels = () => lines.filter((line) => line.level !== 'info').map((line) => line.level);
    try {
      lines.length = 0;
      table.fail(true);
      await failedRead(1);
      await failedRead(2);
      expect(levels()).toEqual(['warn', 'warn']);
      await failedRead(3);
      await failedRead(4);
      await failedRead(5);
      // Once at `error`, at the bound, and nothing louder than `debug` after it.
      expect(levels()).toEqual(['warn', 'warn', 'error', 'debug', 'debug']);
      const error = lines.find((line) => line.level === 'error');
      expect(error?.fields).toMatchObject({ consecutive_failures: bound });
      expect(error?.message).toMatch(/failed repeatedly.*keeps the rules it last read/);
      // The rules it had are kept through all of it.
      expect(installedMintedCredentialShapeRules()).toHaveLength(1);

      table.fail(false);
      bus.notify();
      await vi.waitFor(() => {
        expect(refresh.status().consecutiveFailures).toBe(0);
      });
      expect(lines.at(-1)).toMatchObject({ level: 'info', fields: { failed_reads: 5 } });
      expect(lines.at(-1)?.message).toMatch(/succeeded again/);

      // Recovered: the next failure is a warning again, not silence and not a second `error`.
      lines.length = 0;
      table.fail(true);
      await failedRead(1);
      expect(levels()).toEqual(['warn']);
    } finally {
      await refresh.stop();
    }
  });

  it('says nothing about recovering after a failure that stayed below the bound', async () => {
    const order: string[] = [];
    const bus = fakeBroadcast(order);
    const table = scriptedSql(order);
    const { logger, lines } = recordingLogger();
    const refresh = await startMintedCredentialShapeRefresh({
      sql: table.sql,
      broadcast: bus.broadcast,
      logger,
      intervalMs: 3_600_000,
    });
    try {
      lines.length = 0;
      table.fail(true);
      bus.notify();
      await vi.waitFor(() => {
        expect(refresh.status().consecutiveFailures).toBe(1);
      });
      table.fail(false);
      bus.notify();
      await vi.waitFor(() => {
        expect(refresh.status()).toMatchObject({ consecutiveFailures: 0, notifiedReads: 2 });
      });
      expect(lines.map((line) => line.level)).toEqual(['warn']);
      expect(MINTED_CREDENTIAL_SHAPE_FAILURE_BOUND).toBe(12);
    } finally {
      await refresh.stop();
    }
  });

  it('starts one more read for notifications that arrive during a read, never one per notification', async () => {
    const order: string[] = [];
    const bus = fakeBroadcast(order);
    let release: () => void = () => {};
    let reads = 0;
    let hold = false;
    const sql: SqlExecutor = {
      query: async <R extends Record<string, unknown>>() => {
        reads += 1;
        if (hold) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { rows: [] as R[], rowCount: 0 };
      },
    };
    const refresh = await startMintedCredentialShapeRefresh({
      sql,
      broadcast: bus.broadcast,
      intervalMs: 3_600_000,
    });
    try {
      hold = true;
      bus.notify();
      await vi.waitFor(() => {
        expect(reads).toBe(2);
      });
      bus.notify();
      bus.notify();
      bus.notify();
      hold = false;
      release();
      await vi.waitFor(() => {
        expect(reads).toBe(3);
      });
      // Settled: the three notifications during the held read asked for one read, not three.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reads).toBe(3);
    } finally {
      await refresh.stop();
    }
  });
});
