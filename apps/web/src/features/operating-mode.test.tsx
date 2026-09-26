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

import { featuresConfigSchema } from '@platform/contracts';
import {
  FEATURE_READERS,
  MAINTENANCE_CHORE_TYPES,
  MAINTENANCE_CHORES,
  PLATFORM_DEFAULT_CONFIG,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { FEATURE_CARDS, FEATURES_WITHOUT_A_SWITCH } from './operating-mode.js';

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
  // Every `features.<key>` a project may write — the schema's key set, which is one wider than the
  // defaults table (`history_bootstrap` ships no default; its reader treats absent as off).
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

  it('says a feature is unbuilt exactly where the reader table names no reader', () => {
    const readers = FEATURE_READERS as Readonly<Record<string, readonly string[]>>;
    for (const card of FEATURE_CARDS) {
      const read = (readers[card.key] ?? []).length > 0;
      expect(card.unbuilt === undefined, `${card.key}: unbuilt line iff no reader`).toBe(read);
    }
  });
});
