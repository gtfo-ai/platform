/**
 * The word→sentence table of `task_stages.outcome` (WP-73, PROGRESS backlog 213): every word of the
 * platform's own vocabulary has a sentence, the two families included by reference are said
 * generically, and no sentence is the raw machine word a person used to read on the task screen.
 */
import { taskStageOutcomeWordSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { stageOutcomeSentence, stageOutcomeWordSentence } from './task-detail.js';

describe('the stage outcome sentences', () => {
  it('gives every platform word a sentence of its own, never the word itself', () => {
    const sentences = taskStageOutcomeWordSchema.options.map(stageOutcomeWordSentence);
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const [index, word] of taskStageOutcomeWordSchema.options.entries()) {
      expect(sentences[index], word).not.toBe(word);
      expect(sentences[index], word).toMatch(/\.$/);
    }
  });

  it('says a verdict and an event generically, and a word through the table', () => {
    expect(stageOutcomeSentence('request_changes')).toBe('Verdict: request changes.');
    expect(stageOutcomeSentence('mr.merged')).toBe('Moved on by mr.merged.');
    expect(stageOutcomeSentence('task.completed')).toBe('Ended because the task completed.');
    expect(stageOutcomeSentence('take_over.expired')).toBe(
      'Escalated: the take-over saw no activity for five working days.',
    );
  });
});
