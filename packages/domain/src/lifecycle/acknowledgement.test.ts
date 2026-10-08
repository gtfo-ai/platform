/**
 * The acknowledgement table, in both directions — WP-174 criterion (3) (TD-029 decision 8).
 *
 * The canary, measured at WP-174: with the length bound dropped from `isAcknowledgement`, the
 * 81-character *thanks* below reads as an acknowledgement and "is not an acknowledgement past 80
 * characters" fails.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  acknowledgementTokens,
  isAcknowledgement,
  MAX_ACKNOWLEDGEMENT_CHARS,
  SHIPPED_ACKNOWLEDGEMENT_VOCABULARY,
} from './acknowledgement.js';

/** Exactly 81 characters, every token in the vocabulary. */
const EIGHTY_ONE_CHARACTER_THANKS = `${'thanks '.repeat(11)}thx!`;
/** The same text one character shorter: exactly at the bound. */
const EIGHTY_CHARACTER_THANKS = `${'thanks '.repeat(11)}thx`;

describe('an acknowledgement (WP-174 criterion 3)', () => {
  it.each([
    ['👍'],
    ['thanks!'],
    ['@someone LGTM'],
    ['ok, thank you'],
    ['👍🏽'],
    ['+1'],
    ['Looks good 🎉'],
    ['THANK YOU!!!'],
    ['@first.last @team-x'],
    ['…'],
    [''],
  ])('%j is an acknowledgement', (text) => {
    expect(isAcknowledgement(text, [])).toBe(true);
  });

  it.each([
    ['Looks good, but rename X'],
    ['thanks, but the button is still red'],
    ['Prosím, oprav to tlačítko'],
    ['díky'],
    ['❌'],
    ['🐛'],
    ['ok?? no'],
    ['-1'],
    ["don't merge"],
    ['@someone please fix'],
  ])('%j is not an acknowledgement', (text) => {
    expect(isAcknowledgement(text, [])).toBe(false);
  });

  it('is not an acknowledgement past 80 characters, though every token is in the vocabulary', () => {
    expect([...EIGHTY_ONE_CHARACTER_THANKS].length).toBe(MAX_ACKNOWLEDGEMENT_CHARS + 1);
    expect(
      acknowledgementTokens(EIGHTY_ONE_CHARACTER_THANKS).every((token) =>
        SHIPPED_ACKNOWLEDGEMENT_VOCABULARY.includes(token),
      ),
    ).toBe(true);
    expect(isAcknowledgement(EIGHTY_ONE_CHARACTER_THANKS, [])).toBe(false);
    expect([...EIGHTY_CHARACTER_THANKS].length).toBe(MAX_ACKNOWLEDGEMENT_CHARS);
    expect(isAcknowledgement(EIGHTY_CHARACTER_THANKS, [])).toBe(true);
  });

  it('counts an extra word only when it is configured', () => {
    expect(isAcknowledgement('Díky!', [])).toBe(false);
    expect(isAcknowledgement('Díky!', ['díky'])).toBe(true);
    expect(isAcknowledgement('DÍKY moc', ['díky', 'moc'])).toBe(true);
    // An extra word never removes a shipped one.
    expect(isAcknowledgement('thanks', ['díky'])).toBe(true);
    // …and a request in the project's language is still a request.
    expect(isAcknowledgement('díky, ale přejmenuj to', ['díky'])).toBe(false);
  });

  it('reads a configured word through the comment’s own pipeline (WP-174 review)', () => {
    expect(isAcknowledgement('díky', ['Díky!'])).toBe(true);
    expect(isAcknowledgement('@reviewer DANKE', ['danke.'])).toBe(true);
    // One that tokenises to two tokens adds nothing, so neither half becomes an acknowledgement.
    expect(isAcknowledgement('merci', ['merci-beaucoup'])).toBe(false);
  });

  it('normalises with NFKC before comparing, so a full-width word is the word', () => {
    expect(isAcknowledgement('ＬＧＴＭ', [])).toBe(true);
  });

  it(
    'never reads a text with a letter token outside the vocabulary as an acknowledgement (property)',
    () => {
      const vocabulary = new Set(SHIPPED_ACKNOWLEDGEMENT_VOCABULARY);
      const acknowledgementWord = fc.constantFrom(...SHIPPED_ACKNOWLEDGEMENT_VOCABULARY);
      const foreignWord = fc
        .stringMatching(/^[a-zA-Zá-žÁ-Ž]{1,12}$/)
        .filter((word) => !vocabulary.has(word.normalize('NFKC').toLowerCase()));
      const separator = fc.constantFrom(' ', ', ', '! ', '\n', ' @someone ');
      fc.assert(
        fc.property(
          fc.array(acknowledgementWord, { maxLength: 6 }),
          foreignWord,
          fc.nat(),
          separator,
          (words, foreign, at, glue) => {
            const tokens = [...words];
            tokens.splice(at % (tokens.length + 1), 0, foreign);
            expect(isAcknowledgement(tokens.join(glue), [])).toBe(false);
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it(
    'reads any short text made only of vocabulary words, mentions and punctuation as one (property)',
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              fc.constantFrom(...SHIPPED_ACKNOWLEDGEMENT_VOCABULARY),
              fc.constantFrom('@someone', '!', '.', ','),
            ),
            { maxLength: 8 },
          ),
          (parts) => {
            const text = parts.join(' ');
            fc.pre([...text].length <= MAX_ACKNOWLEDGEMENT_CHARS);
            expect(isAcknowledgement(text, [])).toBe(true);
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});
