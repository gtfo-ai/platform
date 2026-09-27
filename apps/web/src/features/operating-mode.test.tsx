/**
 * The feature cards say what this build does — held to the platform's own tables (WP-36).
 *
 * PROGRESS backlog **72**'s adjacent note asks each feature row for *one* assertion: *"the caveat
 * line is deleted in the same change, so a feature that starts working and leaves the screen saying
 * it does not is a test failure"*. This is the maintenance card's, and it is a **comparison** rather
 * than a copy of the sentence: the card must name every chore type this build performs and every one
 * it refuses, read off `MAINTENANCE_CHORES` in the domain, so a type that changes side and leaves
 * the wizard stale fails here rather than misleading a maintainer at the moment they turn it on.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { featuresConfigSchema } from '@platform/contracts';
import {
  AUTONOMY_POLICY_READERS,
  AUTONOMY_POLICY_WIRE_NAMES,
  FEATURE_READERS,
  MAINTENANCE_CHORE_TYPES,
  MAINTENANCE_CHORES,
  materialiseAutonomy,
  PLATFORM_DEFAULT_CONFIG,
} from '@platform/domain';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../../scripts/census-files.mjs';
import {
  DIAL_TIMING_NOTE,
  FEATURE_CARDS,
  FEATURES_WITHOUT_A_SWITCH,
  POLICIES_THAT_SET_NOTHING,
  PolicyTable,
} from './operating-mode.js';

const maintenance = FEATURE_CARDS.find((card) => card.key === 'maintenance');

/** How the card spells each chore type, so the comparison is about meaning rather than tokens. */
const CARD_WORDS: Readonly<Record<string, string>> = {
  deps: 'dependency bumps',
  kb: 'knowledge-base hygiene',
  flaky: 'Flaky tests',
  docs: 'docs drift',
  lint: 'lint debt',
};

describe('the maintenance feature card', () => {
  it('no longer says that nothing runs, because something does', () => {
    expect(maintenance?.caveat).toBeDefined();
    expect(maintenance?.caveat).not.toContain('no scheduler');
    expect(maintenance?.caveat).not.toContain('Stored;');
    // product/19:126's own column, unchanged: the maintenance pipeline opens merge requests and
    // files no ticket, which is the decision criterion 3 of WP-36 implements.
    expect(maintenance?.touches).toBe('opens merge requests');
  });

  it('names every chore type this build performs, and every one it refuses', () => {
    const caveat = maintenance?.caveat ?? '';
    for (const type of MAINTENANCE_CHORE_TYPES) {
      const word = CARD_WORDS[type] as string;
      expect(caveat, `${type} is named`).toContain(word);
      const performed = MAINTENANCE_CHORES[type].refusal === null;
      // The side it is named on: a performed type is in the first sentence, a refused one in the
      // sentence that says they are refused. Both directions (standing rule 42).
      const refusedSentence = caveat.slice(caveat.indexOf('are refused by name'));
      expect(refusedSentence.includes(word), `${type} is on the right side`).toBe(!performed);
    }
  });
});

/**
 * **The cards against the platform's own tables, both directions** (WP-44, criteria 5 and 6;
 * PROGRESS backlog 108 and 72).
 *
 * Backlog 108: `FEATURE_CARDS` covered five of nine shipped feature keys and nothing compared the
 * two lists, so `features.epic_split` — the one switch that routes an epic to the variant — could be
 * turned on from no screen. Backlog 72: two strings told a maintainer that two working features did
 * not work. Neither is a pinned sentence here: the first is an equality of key sets, the second is
 * the rule that a card may say its feature is unbuilt **only** where `FEATURE_READERS` names no
 * reader — so a feature that gains a reader and keeps its "unbuilt" line fails, and so does a card
 * for a key nothing reads that says nothing about it.
 */
describe('the feature cards against the platform’s feature table', () => {
  // Every `features.<key>` a project may write — the schema's key set, which since WP-73 (backlog
  // 205) is also exactly the defaults table's, asserted below so the docblock's claim is checked.
  const shipped = Object.keys(featuresConfigSchema.shape).sort();
  const exempt = FEATURES_WITHOUT_A_SWITCH.flatMap((entry) =>
    entry.key === undefined ? [] : [entry.key],
  );

  it('covers every shipped feature key with a card or a declared exemption, and nothing else', () => {
    const covered = [...FEATURE_CARDS.map((card) => card.key), ...exempt].sort();
    expect(covered).toEqual(shipped);
    // A key is a card **or** an exemption, never both — two answers to "can I switch this?".
    expect(FEATURE_CARDS.filter((card) => (exempt as string[]).includes(card.key))).toEqual([]);
  });

  it('compares with `PLATFORM_DEFAULT_CONFIG.features`, which ships a default for every key', () => {
    // `FEATURE_CARDS`' docblock says the cards are held to the defaults table; until backlog 205 the
    // table lacked `history_bootstrap`, so that comparison would have failed and was not made.
    expect(Object.keys(PLATFORM_DEFAULT_CONFIG.features ?? {}).sort()).toEqual(shipped);
  });

  it('has a card for the epic split that says it creates tickets, and only it says so', () => {
    const epic = FEATURE_CARDS.find((card) => card.key === 'epic_split');
    expect(epic?.touches).toContain('creates tickets in your tracker');
    expect(
      FEATURE_CARDS.filter((card) => card.touches.includes('creates tickets')).map(
        (card) => card.key,
      ),
    ).toEqual(['epic_split']);
  });

  it('states each card’s default as the platform ships it', () => {
    const features = PLATFORM_DEFAULT_CONFIG.features as Record<string, { enabled?: boolean }>;
    for (const card of FEATURE_CARDS) {
      // Absent from the defaults is off: every reader of `enabled` defaults a missing value to false.
      const enabled = features[card.key]?.enabled ?? false;
      expect(card.defaultState.startsWith(enabled ? 'on' : 'off'), card.key).toBe(true);
      // And the toggle writes a key the schema has: `features.<key>.enabled`.
      const shape = (featuresConfigSchema.shape as Record<string, unknown>)[card.key];
      expect(shape, `${card.key} is a schema key`).toBeDefined();
    }
  });

  /**
   * **The residual, stated at the check** (PROGRESS backlog 208). This case holds `unbuilt` to
   * `FEATURE_READERS`; it reads nothing else. A *"does nothing in this build"* sentence written into
   * a card's `caveat` — or into an unkeyed `FEATURES_WITHOUT_A_SWITCH.why`, which is where backlog
   * 72's *"Ask the task — not built"* sat — is **not caught** here or anywhere: no source-text guard
   * can tell a limit from a denial, so a recurrence of backlog 72's defect is reviewable, not
   * caught. What the unkeyed entries do get is the route resolution below.
   */
  it('says a feature is unbuilt exactly where the reader table names no reader', () => {
    const readers = FEATURE_READERS as Readonly<Record<string, readonly string[]>>;
    for (const card of FEATURE_CARDS) {
      const read = (readers[card.key] ?? []).length > 0;
      expect(card.unbuilt === undefined, `${card.key}: unbuilt line iff no reader`).toBe(read);
    }
  });
});

/** The `/api/…` paths the app's own sources name, normalised as the client census normalises them. */
const clientPaths = (): ReadonlySet<string> => {
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repoRoot = resolve(webRoot, '../../..');
  // Tracked and untracked-but-committable (standing rule 85) through the one census helper
  // (WP-68); tests are out, as in the census.
  const files = censusFiles(repoRoot, {
    pathspecs: ['apps/web/src/*.ts', 'apps/web/src/*.tsx'],
    include: (file) => !/\.test\.tsx?$/.test(file),
  });
  const found = new Set<string>();
  for (const file of files) {
    const source = file.contents
      .split('\n')
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
      .join('\n');
    for (const [, , path] of source.matchAll(/(['"`])(\/api\/[^'"`]*)\1/g)) {
      if (path !== undefined) {
        found.add(
          path
            .replaceAll(/\$\{[^}]*\}/g, '{}')
            .replace(/\/$/, '')
            .replace(/\?.*$/, ''),
        );
      }
    }
  }
  return found;
};

/**
 * The unkeyed exemptions, resolved rather than trusted (WP-62, PROGRESS backlog 208).
 *
 * Each names the routes of the control its `why` says is on, and each route must be a path the app
 * actually calls. That the server serves it is `apps/server/src/routes/client-census.test.ts`'s
 * equality, so together the two say the control exists end to end. What is still not read is the
 * `why` sentence itself — the residual stated above.
 */
describe('the features without a switch (backlog 208)', () => {
  const paths = clientPaths();

  it('names, for every entry without a key, routes the app really calls', () => {
    const unkeyed = FEATURES_WITHOUT_A_SWITCH.filter((entry) => entry.key === undefined);
    expect(unkeyed.map((entry) => entry.name)).toEqual([
      'Steer',
      'Take over / hand back',
      'Cost estimate before spend',
    ]);
    for (const entry of unkeyed) {
      expect(entry.routes?.length ?? 0, entry.name).toBeGreaterThan(0);
      for (const route of entry.routes ?? []) {
        expect(paths.has(route), `${entry.name}: ${route}`).toBe(true);
      }
    }
  });

  it('refuses a route the app does not call (the canary)', () => {
    expect(paths.has('/api/tasks/{}/ask-the-task-not-built')).toBe(false);
    expect(paths.size).toBeGreaterThan(20);
  });
});

/**
 * The dial's policy list marks what sets nothing (WP-62, criterion 6; PROGRESS backlog 72).
 *
 * The mark is held to the platform's own reader table in both directions rather than pinned, and
 * the rendered list is read back: the marked rows are exactly the unread policies, and every other
 * row carries no mark.
 */
describe('the policy list on the dial', () => {
  const unread = Object.entries(AUTONOMY_POLICY_READERS)
    .filter(([, entry]) => entry.kind === 'unread')
    .map(
      ([policy]) => AUTONOMY_POLICY_WIRE_NAMES[policy as keyof typeof AUTONOMY_POLICY_WIRE_NAMES],
    )
    .sort();

  it('marks exactly the policies the reader table says nothing reads', () => {
    expect(Object.keys(POLICIES_THAT_SET_NOTHING).sort()).toEqual(unread);
  });

  it('renders the mark on those rows and on no other', () => {
    const materialised = materialiseAutonomy({
      level: 'autonomous',
      at: '2026-09-26T09:00:00.000Z' as never,
      appliedBy: null,
    });
    render(
      <PolicyTable
        autonomy={{
          level: 'autonomous',
          materialised: true,
          preset_version: materialised.preset_version,
          current_preset_version: materialised.preset_version,
          preset_outdated: false,
          applied_at: materialised.applied_at,
          applied_by: null,
          policies: materialised.policies,
          is_custom: false,
          overrides: [],
          readiness_level: 2,
          suggested_cap: 'autonomous',
          above_suggested_cap: false,
        }}
      />,
    );
    expect(
      screen.getByText(
        'The 15 policies this position holds — 13 in force, 2 that set nothing by themselves',
      ),
    ).toBeDefined();
    const marked = screen
      .getAllByText('sets nothing')
      .map((badge) => badge.closest('li')?.firstElementChild?.textContent ?? '')
      .sort();
    expect(marked).toEqual(unread);
  });
});

describe('the line under the dial (WP-62 review round 1)', () => {
  it('names the three policies frozen at task start and says the rest are read live', () => {
    for (const frozen of ['business review', 'stop after architecture', 'human review rounds']) {
      expect(DIAL_TIMING_NOTE).toContain(frozen);
    }
    expect(DIAL_TIMING_NOTE).toContain('read when they are used');
    // The false sentence the round removed: a task does not keep its whole starting position.
    expect(DIAL_TIMING_NOTE).not.toContain('not running ones');
  });
});
