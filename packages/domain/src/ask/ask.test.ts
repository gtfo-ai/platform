/**
 * Ask-the-task's pure half (WP-31).
 *
 * The subject that matters here is {@link classifyTicketComment}, and the reason it gets both
 * directions in every case is the plan row's criterion 5: *"a comment that is an ask produces
 * exactly one ask, and a comment that is not — a plain remark, the platform's own workpad edit, a
 * feedback phrase — produces **none**"*. An assertion that only ever checks "no ask was created"
 * passes for a classifier that refuses everything, which is why every refusal is asserted **by
 * name** rather than by absence.
 */
import { askAnswerDataSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  ASK_TRIGGERS,
  askCommentMarker,
  classifyTicketComment,
  DEFAULT_ASK_BUDGET_USD,
  isPromptExcludedArtifact,
  MAX_ASK_ANSWER_CHARS,
  MAX_ASK_QUESTION_CHARS,
  PLATFORM_COMMENT_MARKERS,
  PROMPT_EXCLUDED_ARTIFACT_TYPES,
} from './ask.js';

/** A minimal `AskAnswer` whose only variable is the answer's length. */
const answerOfLength = (length: number) => ({
  answer: 'a'.repeat(length),
  citations: [],
  unanswered: [],
  confidence: 'low' as const,
});

const verified = (text: string) => classifyTicketComment({ text, authorVerified: true });
const unverified = (text: string) => classifyTicketComment({ text, authorVerified: false });

describe('classifyTicketComment', () => {
  it('reads a triggered comment as an ask, with the trigger removed', () => {
    expect(verified('@agentic ask why did you choose a column?')).toEqual({
      kind: 'ask',
      question: 'why did you choose a column?',
    });
  });

  it('accepts the phrasing product/10:57 actually writes down', () => {
    // `@agentic why` is the second trigger for exactly this: *"why did you choose X?"* is the
    // sentence the product document uses, and a person who types it should not have to learn a verb.
    expect(verified('@agentic why did you skip the rebase?')).toEqual({
      kind: 'ask',
      question: 'did you skip the rebase?',
    });
  });

  it.each(ASK_TRIGGERS)(
    'matches %s whatever case it is typed in, after leading whitespace',
    (trigger) => {
      const upper = trigger
        .replace('agentic', 'AGENTIC')
        .replace(/ (\w+)$/, (m) => m.toUpperCase());
      expect(verified(`\n   ${upper} what happened?`)).toEqual({
        kind: 'ask',
        question: 'what happened?',
      });
    },
  );

  it('refuses a plain remark by name, rather than merely producing nothing', () => {
    expect(verified('Looks good to me, shipping on Friday.')).toEqual({
      kind: 'not_an_ask',
      reason: 'no_trigger',
    });
  });

  it('refuses a mention of the bot that is not a question to it', () => {
    // The trigger has to **open** the comment. A wider rule would turn every mention of `@agentic`
    // in a paragraph into a paid run, on somebody else's ticket.
    expect(verified('I think @agentic ask would be a useful feature here.')).toEqual({
      kind: 'not_an_ask',
      reason: 'no_trigger',
    });
  });

  it.each(PLATFORM_COMMENT_MARKERS)(
    'refuses the platform’s own comment, which carries %s, even when it is triggered',
    (marker) => {
      expect(
        verified(`@agentic ask what is going on? ${marker}0199a0b0-1111-7000-8000-000000000001`),
      ).toEqual({ kind: 'not_an_ask', reason: 'platform_comment' });
    },
  );

  it('checks the platform marker before the trigger, so a loop cannot be read as a question', () => {
    // The ordering is the fail-closed one and it is asserted directly: the workpad and a mirrored
    // ask are both platform comments, and an answer read back as a new question is a budget that
    // empties itself.
    const workpad = `**Asked and answered** — ${askCommentMarker('0199a0b0-1111-7000-8000-000000000002')}\n@agentic ask and what about this?`;
    expect(verified(workpad).kind).toBe('not_an_ask');
    expect(verified(workpad)).toEqual({ kind: 'not_an_ask', reason: 'platform_comment' });
  });

  it('refuses an unverified author — which on this build is every unmapped account (BD-022, Q10)', () => {
    expect(unverified('@agentic ask why did you choose a column?')).toEqual({
      kind: 'not_an_ask',
      reason: 'unverified_identity',
    });
  });

  it('refuses a trigger with nothing after it', () => {
    expect(verified('@agentic ask   ')).toEqual({ kind: 'not_an_ask', reason: 'empty_question' });
  });

  it('never answers two things: every input produces exactly one verdict', () => {
    const inputs = [
      '@agentic ask why?',
      'a remark',
      '@agentic ask',
      `${PLATFORM_COMMENT_MARKERS[0]}x`,
      '',
    ];
    for (const text of inputs) {
      const verdict = verified(text);
      expect(['ask', 'not_an_ask']).toContain(verdict.kind);
    }
  });
});

describe('the caps and the vocabulary', () => {
  it('bounds a question well below the context budget it shares a prompt with', () => {
    // Derived rather than chosen: the cap is about 3 % of `DEFAULT_CONTEXT_BUDGET_TOKENS`' rough
    // character equivalent, so a question can never crowd out the record it asks about.
    expect(MAX_ASK_QUESTION_CHARS).toBe(4_000);
    expect(MAX_ASK_QUESTION_CHARS).toBeLessThan(MAX_ASK_ANSWER_CHARS);
  });

  it('bounds the answer at exactly what the artifact contract accepts', () => {
    // A lower bound here would truncate an answer the platform had already accepted and paid for;
    // a higher one would be a claim `askAnswerDataSchema` does not support.
    expect(MAX_ASK_ANSWER_CHARS).toBe(20_000);
    // `packages/contracts/src/artifacts.ts` carries the same bound as a literal (contracts cannot
    // import domain), so the two are held equal here: the schema accepts the cap and refuses one past it.
    expect(askAnswerDataSchema.safeParse(answerOfLength(MAX_ASK_ANSWER_CHARS)).success).toBe(true);
    expect(askAnswerDataSchema.safeParse(answerOfLength(MAX_ASK_ANSWER_CHARS + 1)).success).toBe(
      false,
    );
  });

  it('starts the per-question cap at Q72 (c)’s figure', () => {
    expect(DEFAULT_ASK_BUDGET_USD).toBe(0.5);
  });

  it('keeps an ask’s answer out of a later stage’s prompt, and nothing else', () => {
    expect(PROMPT_EXCLUDED_ARTIFACT_TYPES).toEqual(['AskAnswer']);
    expect(isPromptExcludedArtifact('AskAnswer')).toBe(true);
    // Both directions (standing rule 42): a rule that excluded everything would pass the first half.
    expect(isPromptExcludedArtifact('ImplementationPlan')).toBe(false);
    expect(isPromptExcludedArtifact('RefinedSpec')).toBe(false);
  });
});
