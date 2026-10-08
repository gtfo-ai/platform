/**
 * The acknowledgement rule — TD-029 decision 8 (BD-031, WP-174 ruling (b)).
 *
 * A person's word at a human stage (`qa`, `ready_for_merge`) returns the task, unless it is only an
 * acknowledgement: *"thanks"*, *"LGTM"*, a 👍. This module is the one place that decides which, and
 * it is pure so it can be tested in both directions.
 *
 * Decision 8, as built:
 *
 *  1. The **original** text is at most {@link MAX_ACKNOWLEDGEMENT_CHARS} characters (code points).
 *     A longer word is never an acknowledgement, whatever it is made of.
 *  2. It is normalised: Unicode NFKC, then lower-cased.
 *  3. @-mentions, punctuation (`\p{P}`) and whitespace are removed. An emoji's presentation
 *     selectors, skin-tone modifiers and joiners are dropped too, so `👍🏽` reads as `👍`.
 *  4. What remains is split into tokens: a run of non-space, non-emoji characters, or one emoji.
 *  5. It is an acknowledgement when no token remains (a mention only, punctuation only), or when
 *     **every** token is in the shipped vocabulary or in the project's added words.
 *
 * **One reading is chosen, and it is the failure direction decision 8 chose.** The decision lists
 * `empty (emoji only, mentions only)` *and* names four emoji in the vocabulary. Read as "emoji are
 * removed", every emoji-only comment — a ❌ or a 🐛 included — would be an acknowledgement and the
 * person's objection would be lost; the vocabulary's four emoji would then mean nothing. So an
 * emoji is a **token**: 👍 ✅ 🎉 🙏 are acknowledgements because the vocabulary names them, and
 * any other emoji is a token outside it and returns the task. That is decision 8's chosen
 * direction: an acknowledgement the rule misses costs one run; a request read as thanks is lost.
 * `+1` survives step 3 because `+` is a mathematical symbol (`\p{Sm}`), not punctuation.
 *
 * The project's added words (`human_returns.acknowledgements`, technical/12) are compared after the
 * same NFKC and lower-casing, and only when configured: an empty list adds nothing. They can never
 * remove a shipped word — the list is a union.
 */

/** Decision 8's length bound on the original text. */
export const MAX_ACKNOWLEDGEMENT_CHARS = 80;

/**
 * The shipped vocabulary — English words and four emoji, transcribed from TD-029 decision 8. Words,
 * not statuses: nothing here names a tracker's status.
 */
export const SHIPPED_ACKNOWLEDGEMENT_VOCABULARY: readonly string[] = [
  'thanks',
  'thank',
  'you',
  'thx',
  'ty',
  'lgtm',
  'ok',
  'okay',
  '+1',
  'great',
  'nice',
  'cool',
  'looks',
  'good',
  'approved',
  'perfect',
  'done',
  '👍',
  '✅',
  '🎉',
  '🙏',
];

const normalise = (text: string): string => text.normalize('NFKC').toLowerCase();

/** `@name`, `@first.last`, `@team-x`: the mention and its handle. */
const MENTION = /@[\p{L}\p{N}\p{M}._-]*/gu;
/** Emoji presentation selectors, skin-tone modifiers and the zero-width joiner. */
const EMOJI_DECORATION = /\p{Emoji_Modifier}|\u{FE0E}|\u{FE0F}|\u{200D}/gu;
const PUNCTUATION = /\p{P}/gu;
/** One emoji, or a run of anything that is neither whitespace nor an emoji. */
const TOKEN = /\p{Extended_Pictographic}|[^\s\p{Extended_Pictographic}]+/gu;

/** The tokens decision 8 compares with the vocabulary, after its normalisation and removals. */
export const acknowledgementTokens = (text: string): readonly string[] =>
  normalise(text)
    .replace(MENTION, ' ')
    .replace(EMOJI_DECORATION, '')
    .replace(PUNCTUATION, ' ')
    .match(TOKEN) ?? [];

/**
 * Whether `text` is only an acknowledgement (TD-029 decision 8). `extraWords` is the project's
 * `human_returns.acknowledgements`; pass `[]` when none is configured.
 */
export const isAcknowledgement = (text: string, extraWords: readonly string[]): boolean => {
  if ([...text].length > MAX_ACKNOWLEDGEMENT_CHARS) {
    return false;
  }
  const vocabulary = new Set([
    ...SHIPPED_ACKNOWLEDGEMENT_VOCABULARY,
    // A configured word goes through the comment's own pipeline, so `díky!` is the token `díky`;
    // an entry that tokenises to more than one token can never match one and adds nothing.
    ...extraWords.flatMap((word) => {
      const tokens = acknowledgementTokens(word);
      return tokens.length === 1 ? tokens : [];
    }),
  ]);
  return acknowledgementTokens(text).every((token) => vocabulary.has(token));
};
