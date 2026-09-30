/**
 * The one table of queue definitions (WP-86, PROGRESS backlog 262) — its rows, and the census that
 * keeps it the only place a queue's options are written (criterion 2).
 *
 * ## The census
 *
 * Every production `.defineQueue(` call must pass `jobQueueDefinition(JOB_QUEUES.<key>)`, and the
 * set of queues those calls name must **equal** the table, each named once. The equality runs in
 * both directions: a call with an inline literal fails the first assertion, a table row no worker
 * declares or a worker declaring a queue the table lacks fails the second. `migrate` declares every
 * row regardless, so a row no worker serves would still exist — but a queue nothing works is a
 * decision somebody writes down, not a line somebody adds.
 *
 * **Scope**: git's tree (tracked plus untracked-but-not-ignored, standing rule 85), `*.ts`, test
 * tiers excluded — a test declares throwaway queues against the adapters by design, and that
 * exclusion keeps this file out of its own census (standing rule 59). Two production files are
 * exempt by name and say why: this table's own module (`declareJobQueues` iterates the rows it
 * holds), and nothing else.
 *
 * **What it cannot see**, stated rather than implied: it is syntactic. A `defineQueue` reached
 * through a destructured or renamed reference (`const { defineQueue: d } = jobs; d({…})`), or a
 * `createQueue` called on a raw pg-boss instance, is invisible to it; the one raw `createQueue` in
 * production is `migrate`'s, which reads this table (`packages/infrastructure/src/db/migrator.ts`).
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';
import {
  declareJobQueues,
  JOB_QUEUE_DEFINITIONS,
  jobQueueDefinition,
  UnknownJobQueueError,
} from './job-queues.js';
import { isValidJobName, JOB_QUEUES, type JobQueueDefinition } from './jobs.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/** The table's own module: `declareJobQueues` passes each row it holds. */
const EXEMPT = new Set(['packages/application/src/ports/job-queues.ts']);

const isTestTier = (file: string): boolean =>
  file.startsWith('test/') ||
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) ||
  /(?:^|\/)(?:testing|fixtures)\.ts$/.test(file) ||
  file.includes('/src/testing/');

const CALL = /\.defineQueue\(\s*/g;
const TABLE_LOOKUP = /^jobQueueDefinition\(\s*JOB_QUEUES\.([A-Za-z]+)\s*\)/;

interface Site {
  readonly file: string;
  /** The queue name the call resolves to, or `null` when it is not a table lookup. */
  readonly queue: string | null;
  readonly text: string;
}

const sites = (): Site[] => {
  const found: Site[] = [];
  const files = censusPaths(REPO_ROOT, { pathspecs: ['*.ts', '*.tsx'] }).filter(
    (file) => !isTestTier(file) && !EXEMPT.has(file),
  );
  for (const file of files) {
    const source = withoutComments(censusText(REPO_ROOT, file));
    for (const match of source.matchAll(CALL)) {
      const rest = source.slice((match.index ?? 0) + match[0].length);
      const key = TABLE_LOOKUP.exec(rest)?.[1];
      const queue =
        key === undefined ? null : ((JOB_QUEUES as Record<string, string>)[key] ?? `?${key}`);
      found.push({ file, queue, text: rest.slice(0, 60).replace(/\s+/g, ' ') });
    }
  }
  return found;
};

describe('the queue census (WP-86, criterion 2)', () => {
  const found = sites();

  it('reads the tree: it finds the workers’ declarations at all', () => {
    // A census that read nothing would pass every assertion below.
    expect(found.length).toBeGreaterThanOrEqual(JOB_QUEUE_DEFINITIONS.length);
  });

  it('sees a call after a `//` inside a string on the same line (backlog 269)', () => {
    const planted = "const u = 'https://x'; jobs.defineQueue({ name: 'inline' });";
    expect([...withoutComments(planted).matchAll(CALL)]).toHaveLength(1);
  });

  it('refuses a defineQueue call whose argument is not the table’s row', () => {
    const inline = found.filter((site) => site.queue === null || site.queue.startsWith('?'));
    expect(inline.map((site) => `${site.file}: defineQueue(${site.text}`)).toEqual([]);
  });

  it('declares exactly the table, each queue from one site', () => {
    const declared = found.map((site) => site.queue).sort();
    expect(declared).toEqual(JOB_QUEUE_DEFINITIONS.map((definition) => definition.name).sort());
  });
});

describe('JOB_QUEUE_DEFINITIONS', () => {
  it('names every queue once, with a name the port accepts and JOB_QUEUES spells', () => {
    const names = JOB_QUEUE_DEFINITIONS.map((definition) => definition.name);
    expect(new Set(names).size).toBe(names.length);
    const spelled = new Set<string>(Object.values(JOB_QUEUES));
    for (const name of names) {
      expect(isValidJobName(name), name).toBe(true);
      expect(spelled.has(name), name).toBe(true);
    }
  });

  it('puts a dead-letter queue above the queue that names it', () => {
    const seen = new Set<string>();
    for (const definition of JOB_QUEUE_DEFINITIONS) {
      if (definition.deadLetterQueue !== undefined) {
        expect(seen.has(definition.deadLetterQueue), definition.name).toBe(true);
      }
      seen.add(definition.name);
    }
  });

  it('keeps stage.execute’s two-hour expiry and stately policy (TD-004)', () => {
    expect(jobQueueDefinition(JOB_QUEUES.stageExecute)).toMatchObject({
      policy: 'stately',
      expireInSeconds: 7200,
    });
  });
});

describe('jobQueueDefinition', () => {
  it('refuses a queue the table does not carry, by name', () => {
    expect(() => jobQueueDefinition(JOB_QUEUES.budgetWindowReset)).toThrow(UnknownJobQueueError);
    expect(() => jobQueueDefinition('poll.gitlab')).toThrow(/poll\.gitlab.*JOB_QUEUE_DEFINITIONS/);
  });
});

describe('declareJobQueues', () => {
  it('declares every row in order and reports the names', async () => {
    const declared: JobQueueDefinition[] = [];
    const names = await declareJobQueues({
      defineQueue: async (definition) => {
        declared.push(definition);
      },
    });
    expect(declared).toEqual(JOB_QUEUE_DEFINITIONS);
    expect(names).toEqual(JOB_QUEUE_DEFINITIONS.map((definition) => definition.name));
  });
});
