/**
 * The `platform` image's three updater labels (TD-032 decision 2, WP-272), held to the code that
 * answers for them and, for the pg-boss one, to pg-boss itself.
 *
 * A `LABEL` cannot take a value a `RUN` computed, so `docker/app.Dockerfile` writes the values and
 * this test is what stops them from drifting from `image-labels.ts` (which `migrate --plan`
 * prints) and from the pg-boss schema version `runMigrations` installs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConstructionPlans } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import {
  imageLabels,
  PGBOSS_SCHEMA_LABEL,
  ROLLBACK_FLOOR,
  ROLLBACK_FLOOR_LABEL,
  readPgBossSchemaVersion,
  SCHEMA_GUARD_LABEL,
  SCHEMA_GUARD_VERSION,
} from './image-labels.js';

/** The Dockerfile's reference to the global ARG, spelled without a literal `${…}` in a string. */
const PGBOSS_ARG = ['$', '{PGBOSS_SCHEMA}'].join('');

const DOCKERFILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docker/app.Dockerfile',
);

/** The Dockerfile's logical lines: continuations joined, comments dropped. */
const instructions = (text: string): string[] =>
  text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

/** Every `key="value"` pair of every `LABEL` instruction, in order. */
const labelsOf = (text: string): Map<string, string> => {
  const labels = new Map<string, string>();
  for (const line of instructions(text)) {
    if (!/^LABEL\s/.test(line)) continue;
    for (const match of line.matchAll(/([a-z0-9.-]+)="([^"]*)"/g)) {
      labels.set(match[1] as string, match[2] as string);
    }
  }
  return labels;
};

/** The default of a global `ARG` (declared before the first `FROM`), or `null`. */
const globalArgDefault = (text: string, name: string): string | null => {
  const lines = instructions(text);
  const firstFrom = lines.findIndex((line) => /^FROM\s/.test(line));
  for (const line of lines.slice(0, firstFrom)) {
    const match = new RegExp(`^ARG\\s+${name}=(\\S+)$`).exec(line);
    if (match !== null) return match[1] as string;
  }
  return null;
};

/** The pg-boss schema version pg-boss itself writes when it installs (`INSERT INTO <s>.version`). */
const versionInConstructionPlan = (): number => {
  const match = /INSERT INTO pgboss\.version\s*\(version\)\s*VALUES\s*\('(\d+)'\)/i.exec(
    getConstructionPlans('pgboss'),
  );
  expect(match, 'pg-boss construction plan records a version').not.toBeNull();
  return Number(match?.[1]);
};

describe('the platform image labels (TD-032 decision 2)', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');
  const labels = labelsOf(dockerfile);

  it('carries the schema guard version this build’s assertSchemaIsKnown implements', () => {
    expect(SCHEMA_GUARD_VERSION).toBe(2);
    expect(labels.get(SCHEMA_GUARD_LABEL)).toBe(String(SCHEMA_GUARD_VERSION));
  });

  // `scripts/check-migrations.test.ts` reads the same label the way `migrations:check` reads it.
  it('carries the rollback floor the code answers with', () => {
    expect(labels.get(ROLLBACK_FLOOR_LABEL)).toBe(String(ROLLBACK_FLOOR));
  });

  it('labels the pg-boss schema from the one global ARG, never a second literal', () => {
    expect(labels.get(PGBOSS_SCHEMA_LABEL)).toBe(PGBOSS_ARG);
    // The number appears once in the Dockerfile: the global ARG's default.
    expect(dockerfile.match(/^ARG PGBOSS_SCHEMA=/gm)).toHaveLength(1);
    expect(globalArgDefault(dockerfile, 'PGBOSS_SCHEMA')).toBe(String(readPgBossSchemaVersion()));
  });

  it('derives the pg-boss version from what pg-boss installs, and the image build checks it', () => {
    // pg-boss's own answer, read two independent ways: the manifest its Contractor reads, and the
    // version row its construction plan inserts.
    expect(readPgBossSchemaVersion()).toBe(versionInConstructionPlan());
    // The build-time check: the installed pg-boss's `pgboss.schema` against the ARG, failing the
    // build on a mismatch. Removing it leaves a label nothing verified in the image.
    const check = instructions(dockerfile).find((line) =>
      line.includes(
        "require(require.resolve('pg-boss/package.json',{paths:['./packages/infrastructure']})).pgboss.schema",
      ),
    );
    expect(check).toMatch(/^RUN set -eu;/);
    expect(check).toContain(`!= "${PGBOSS_ARG}"`);
    expect(check).toContain('exit 1');
  });

  it('is what imageLabels — and so migrate --plan — prints', () => {
    const resolved = new Map(
      [...labels].map(([key, value]) => [
        key,
        value.replace(PGBOSS_ARG, globalArgDefault(dockerfile, 'PGBOSS_SCHEMA') ?? ''),
      ]),
    );
    for (const [key, value] of Object.entries(imageLabels())) {
      expect(resolved.get(key), key).toBe(value);
    }
    expect(Object.keys(imageLabels()).sort()).toEqual(
      [PGBOSS_SCHEMA_LABEL, ROLLBACK_FLOOR_LABEL, SCHEMA_GUARD_LABEL].sort(),
    );
  });
});
