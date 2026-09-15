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
import { MAINTENANCE_CHORE_TYPES, MAINTENANCE_CHORES } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { FEATURE_CARDS } from './operating-mode.js';

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
