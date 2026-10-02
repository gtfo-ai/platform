/**
 * **One selector for every integration picker** (WP-122, PROGRESS backlog 388).
 *
 * Three pickers filtered `retired_at === null` by hand; a fourth that forgot would offer a choice
 * the server refuses `409 integration_retired`. The pickers now read `useBindableIntegrations`, and
 * this file holds the selector's rule and **who may still read the unfiltered list**: the
 * Integrations screen, which shows retired rows on purpose. Each picker's own `test:ui` case (in
 * `onboarding.test.tsx`, `project-settings.test.tsx` and `org-settings.test.tsx`) shows a retired
 * row absent from what it renders.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';
import { bindableIntegrations } from './queries.js';

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const row = (id: string, type: string, retired: boolean) => ({
  id,
  type,
  retired_at: retired ? '2026-09-30T09:00:00.000Z' : null,
});

const walk = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

describe('the bindable-integration selector (WP-122)', () => {
  it('keeps live rows, of the type asked for, and never a retired one', () => {
    const items = [
      row('a', 'git', false),
      row('b', 'git', true),
      row('c', 'communication', false),
      row('d', 'communication', true),
    ];
    expect(bindableIntegrations(items).map((item) => item.id)).toEqual(['a', 'c']);
    expect(bindableIntegrations(items, 'communication').map((item) => item.id)).toEqual(['c']);
    expect(bindableIntegrations(items, 'task_management')).toEqual([]);
  });

  it('leaves the unfiltered read to the Integrations screen alone', () => {
    const callers = walk(SOURCE_ROOT)
      .filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.(ts|tsx)$/.test(path))
      .filter((path) => /\buseIntegrations\s*\(/.test(withoutComments(readFileSync(path, 'utf8'))))
      .map((path) => relative(SOURCE_ROOT, path))
      .sort();
    // `queries.ts` defines it and `useBindableIntegrations` wraps it; the screen that lists retired
    // rows on purpose is the one other reader.
    expect(callers).toEqual(['app/queries.ts', 'features/integrations.tsx']);
  });
});
