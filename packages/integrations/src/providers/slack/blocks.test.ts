/**
 * Block Kit: what the adapter builds, and what it refuses.
 *
 * The refusals are the half the fake does not have — its divergence register hands
 * "`blocks` is never validated" to this work package — so every limit below is asserted in **both
 * directions**: the value Slack documents as legal passes, the value one over it is refused. A
 * one-sided limit test passes against a validator that refuses everything.
 */
import { describe, expect, it } from 'vitest';
import {
  ANSWER_ACTION_ID,
  APPROVAL_NO_SUBJECT_NOTE,
  APPROVAL_REPLY_NOTE,
  APPROVE_ACTION_ID,
  approvalBlockId,
  approvalBlocks,
  assertBlockKit,
  BLOCK_LIMITS,
  digestBlocks,
  parseApprovalBlockId,
  parseQuestionBlockId,
  questionBlockId,
  questionBlocks,
  REJECT_ACTION_ID,
  REPLY_TO_ANSWER,
  REVIEW_ACTION_ID,
} from './blocks.js';

const QUESTION_ID = '00000000-0000-4000-8000-00000000d001';
const APPROVAL_ID = '00000000-0000-4000-8000-00000000e001';
const PLAN_ID = '00000000-0000-4000-8000-00000000f001';
const TASK_ID = '00000000-0000-4000-8000-00000000c001';

const section = (text: string): unknown => ({ type: 'section', text: { type: 'mrkdwn', text } });

/** Every string Slack would render: the value of any `text` key, at any depth. */
const renderedText = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(renderedText);
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    key === 'text' && typeof child === 'string' ? [child] : renderedText(child),
  );
};

describe('questionBlocks', () => {
  it('renders one button per option, all carrying the question id', () => {
    const blocks = questionBlocks({
      questionId: QUESTION_ID,
      taskId: TASK_ID,
      markdown: 'Which currency should totals use?',
      options: ['EUR', 'CZK'],
    });
    assertBlockKit(blocks, 'test');
    const actions = blocks.find((block) => block.type === 'actions');
    expect(actions?.block_id).toBe(questionBlockId(QUESTION_ID));
    expect(actions?.elements).toHaveLength(2);
    const [first] = (actions?.elements ?? []) as { action_id: string; value: string }[];
    expect(first?.action_id).toBe(ANSWER_ACTION_ID);
    expect(JSON.parse(first?.value ?? '{}')).toEqual({ q: QUESTION_ID, o: 'EUR', t: TASK_ID });
  });

  it('omits the actions block for an open question rather than sending an empty one', () => {
    const blocks = questionBlocks({
      questionId: QUESTION_ID,
      taskId: TASK_ID,
      markdown: 'Why?',
      options: [],
    });
    assertBlockKit(blocks, 'test');
    expect(blocks.some((block) => block.type === 'actions')).toBe(false);
    // The reply route has to be visible, or an open question looks unanswerable.
    expect(JSON.stringify(blocks)).toContain('Reply in this thread');
  });

  it('keeps the first 25 options and says how many are not shown', () => {
    const options = Array.from({ length: 30 }, (_, index) => `option-${index}`);
    const blocks = questionBlocks({
      questionId: QUESTION_ID,
      taskId: TASK_ID,
      markdown: 'Pick',
      options,
    });
    assertBlockKit(blocks, 'test');
    const actions = blocks.find((block) => block.type === 'actions');
    expect(actions?.elements).toHaveLength(BLOCK_LIMITS.actionsElements);
    expect(JSON.stringify(blocks)).toContain('5 more options not shown');
  });

  it('escapes an option that tries to broadcast, and still fits the button', () => {
    const blocks = questionBlocks({
      questionId: QUESTION_ID,
      taskId: TASK_ID,
      markdown: 'Pick',
      options: ['<!channel>', 'x'.repeat(200)],
    });
    assertBlockKit(blocks, 'test');
    const elements = (blocks.find((block) => block.type === 'actions')?.elements ?? []) as {
      text: { text: string };
    }[];
    expect(elements[0]?.text.text).toBe('&lt;!channel&gt;');
    expect(elements[1]?.text.text.length).toBe(BLOCK_LIMITS.buttonText);
  });

  it('carries the same option unescaped in the button value, and in nothing Slack renders', () => {
    const blocks = questionBlocks({
      questionId: QUESTION_ID,
      taskId: TASK_ID,
      markdown: 'Pick',
      options: ['<!channel>'],
    });
    assertBlockKit(blocks, 'test');
    const [element] = (blocks.find((block) => block.type === 'actions')?.elements ?? []) as {
      value: string;
    }[];

    // Deliberately raw: `inbound.ts` hands this string to the domain as the human's answer, so
    // escaping it would record `&lt;!channel&gt;` as what they chose (see `answerButtonValue`).
    expect(JSON.parse(element?.value ?? '{}')).toEqual({
      q: QUESTION_ID,
      o: '<!channel>',
      t: TASK_ID,
    });
    // It is harmless only because nothing renders it. A refactor that used the value as a label —
    // or put any other unescaped text in a `text` field — turns it back into a broadcast.
    expect(renderedText(blocks).join('\n')).not.toContain('<!channel>');
    expect(renderedText(blocks).join('\n')).toContain('&lt;!channel&gt;');
  });
});

describe('what a message says a thread reply does (WP-88, backlog 299, review round 1)', () => {
  it('tells a question’s reader a reply answers it only when no other question is open', () => {
    const text = JSON.stringify(
      questionBlocks({ questionId: QUESTION_ID, taskId: TASK_ID, markdown: 'Why?', options: [] }),
    );
    expect(text).toContain(REPLY_TO_ANSWER);
    expect(REPLY_TO_ANSWER).toContain('unless another question here is still open');
  });

  it('tells an approval’s reader a reply never decides it, and no longer invites a reason', () => {
    const text = JSON.stringify(
      approvalBlocks({
        approvalId: APPROVAL_ID,
        taskId: TASK_ID,
        markdown: 'Approve the plan?',
        kind: 'plan',
        subjectArtifactId: PLAN_ID,
      }),
    );
    expect(text).toContain(APPROVAL_REPLY_NOTE);
    expect(text).toContain('never approves or requests changes');
    expect(text).not.toContain('with your reasoning');
  });
});

describe('approvalBlocks', () => {
  const REVIEW_URL = `https://agentic.example.test/tasks/${TASK_ID}`;
  const elementsOf = (blocks: readonly { type: string; elements?: readonly unknown[] }[]) =>
    (blocks.find((block) => block.type === 'actions')?.elements ?? []) as {
      action_id: string;
      style?: string;
      value?: string;
      url?: string;
      text: { text: string };
    }[];

  it('renders exactly two decisions and the task page, styled and identified', () => {
    const blocks = approvalBlocks({
      approvalId: APPROVAL_ID,
      taskId: TASK_ID,
      markdown: 'Approve the plan?',
      kind: 'plan',
      subjectArtifactId: PLAN_ID,
      reviewUrl: REVIEW_URL,
    });
    assertBlockKit(blocks, 'test');
    const actions = blocks.find((block) => block.type === 'actions');
    expect(actions?.block_id).toBe(approvalBlockId(APPROVAL_ID));
    const elements = elementsOf(blocks);
    expect(elements.map((element) => element.action_id)).toEqual([
      APPROVE_ACTION_ID,
      REJECT_ACTION_ID,
      REVIEW_ACTION_ID,
    ]);
    expect(elements.map((element) => element.style)).toEqual(['primary', 'danger', undefined]);
    // The link is a link: it carries the platform's URL and no value a click could decide with.
    expect(elements[2]).toMatchObject({ url: REVIEW_URL, text: { text: 'Review plan' } });
    expect(elements[2]?.value).toBeUndefined();
  });

  it('names the task in each value, and the plan it shows on the Approve only (WP-43, S-25.9)', () => {
    const blocks = approvalBlocks({
      approvalId: APPROVAL_ID,
      taskId: TASK_ID,
      markdown: 'x',
      kind: 'plan',
      subjectArtifactId: PLAN_ID,
    });
    const values = elementsOf(blocks).map((element) => JSON.parse(element.value ?? '') as unknown);
    expect(values).toEqual([
      { a: APPROVAL_ID, d: 'approved', t: TASK_ID, s: PLAN_ID },
      { a: APPROVAL_ID, d: 'rejected', t: TASK_ID },
    ]);
  });

  /**
   * BD-006's 2026-11-06 amendment on this door (S-25.9): a plan approval whose message cannot show
   * the plan gets no Approve — only *Review plan* and *Request changes* — and says why. Absent and
   * `null` are the same, so a caller that predates the field fails closed.
   */
  it.each([
    { case: 'null', input: { subjectArtifactId: null } },
    { case: 'absent', input: {} },
  ])('posts no Approve for a plan whose subject is $case', ({ input }) => {
    const blocks = approvalBlocks({
      approvalId: APPROVAL_ID,
      taskId: TASK_ID,
      markdown: 'x',
      reviewUrl: REVIEW_URL,
      ...input,
    });
    assertBlockKit(blocks, 'test');
    expect(elementsOf(blocks).map((element) => element.action_id)).toEqual([
      REJECT_ACTION_ID,
      REVIEW_ACTION_ID,
    ]);
    expect(JSON.stringify(blocks)).toContain(APPROVAL_NO_SUBJECT_NOTE);
    expect(JSON.stringify(blocks)).not.toContain(APPROVE_ACTION_ID);
  });

  it('keeps the Approve of a kind that needs no echo, and carries no plan on it', () => {
    const blocks = approvalBlocks({
      approvalId: APPROVAL_ID,
      taskId: TASK_ID,
      markdown: 'x',
      kind: 'budget',
      subjectArtifactId: null,
      reviewUrl: REVIEW_URL,
    });
    const elements = elementsOf(blocks);
    expect(elements.map((element) => element.action_id)).toEqual([
      APPROVE_ACTION_ID,
      REJECT_ACTION_ID,
      REVIEW_ACTION_ID,
    ]);
    expect(JSON.parse(elements[0]?.value ?? '')).toEqual({
      a: APPROVAL_ID,
      d: 'approved',
      t: TASK_ID,
    });
    expect(elements[2]?.text.text).toBe('Review budget');
  });

  it.each([
    'javascript:alert(1)',
    `https://agentic.example.test/${'x'.repeat(BLOCK_LIMITS.buttonUrl)}`,
  ])('drops a review link Slack may not be handed (%#)', (reviewUrl) => {
    const blocks = approvalBlocks({
      approvalId: APPROVAL_ID,
      taskId: TASK_ID,
      markdown: 'x',
      kind: 'plan',
      subjectArtifactId: PLAN_ID,
      reviewUrl,
    });
    assertBlockKit(blocks, 'test');
    expect(elementsOf(blocks).map((element) => element.action_id)).toEqual([
      APPROVE_ACTION_ID,
      REJECT_ACTION_ID,
    ]);
  });

  it('refuses a button url over Slack’s limit, and accepts one at it', () => {
    const at = `https://a.example/${'x'.repeat(BLOCK_LIMITS.buttonUrl - 'https://a.example/'.length)}`;
    const blocksWith = (url: string) => [
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'a', text: { type: 'plain_text', text: 'Go' }, url },
        ],
      },
    ];
    expect(() => assertBlockKit(blocksWith(at), 'test')).not.toThrow();
    expect(() => assertBlockKit(blocksWith(`${at}x`), 'test')).toThrow(/url exceeds 3000/);
  });
});

describe('digestBlocks', () => {
  it('renders a header, one line per item and a count', () => {
    const blocks = digestBlocks('Agentic digest', [
      { title: 'TASK-1', state: 'ready_for_merge', url: 'https://git.example.test/mr/1' },
      { title: 'TASK-2', state: 'blocked', detail: 'waiting on an answer' },
    ]);
    assertBlockKit(blocks, 'test');
    expect(blocks[0]?.type).toBe('header');
    expect(JSON.stringify(blocks)).toContain('<https://git.example.test/mr/1|TASK-1>');
    expect(JSON.stringify(blocks)).toContain('2 items');
  });

  /**
   * The digest line is the second call site of the WP-10 round-1 finding: `item.url` comes from a
   * ticket provider, so it is untrusted, and it used to be interpolated into `<…|…>` raw.
   */
  it('cannot be broken out of by a URL carrying Slack control characters', () => {
    const blocks = digestBlocks('Agentic digest', [
      { title: 'TASK-1', state: 'blocked', url: 'https://git.example.test/1><!channel' },
    ]);
    const rendered = JSON.stringify(blocks);
    expect(rendered, 'the broadcast must not be reachable through the URL').not.toContain(
      '<!channel',
    );
    expect(rendered).toContain('https://git.example.test/1&gt;&lt;!channel');
  });

  it('refuses to link a digest URL whose scheme Slack must not be handed', () => {
    for (const url of ['!channel', '@U0FAKEBOSS', 'javascript:alert', '//evil.example.test']) {
      const rendered = JSON.stringify(
        digestBlocks('Agentic digest', [{ title: 'TASK-1', state: 'blocked', url }]),
      );
      // The title survives as plain text; the link does not happen at all.
      expect(rendered, url).toContain('TASK-1');
      expect(rendered, url).not.toContain(`<${url}`);
    }
    // Control: an allowed scheme still becomes a link, so the assertions above are a refusal and
    // not a renderer that stopped linking altogether (standing rule 10).
    expect(
      JSON.stringify(
        digestBlocks('Agentic digest', [
          { title: 'TASK-1', state: 'blocked', url: 'https://git.example.test/1' },
        ]),
      ),
    ).toContain('<https://git.example.test/1|TASK-1>');
  });

  it('drops lines it cannot fit and says how many, staying inside the 50-block limit', () => {
    const items = Array.from({ length: 80 }, (_, index) => ({
      title: `TASK-${index}`,
      state: 'in_progress',
    }));
    const blocks = digestBlocks('Agentic digest', items);
    assertBlockKit(blocks, 'test');
    expect(blocks.length).toBe(BLOCK_LIMITS.blocksPerMessage);
    expect(JSON.stringify(blocks)).toContain('32 not shown');
  });
});

describe('assertBlockKit', () => {
  it('accepts what this module builds', () => {
    expect(() =>
      assertBlockKit(
        questionBlocks({
          questionId: QUESTION_ID,
          taskId: TASK_ID,
          markdown: 'Pick',
          options: ['a'],
        }),
        'test',
      ),
    ).not.toThrow();
    expect(() => assertBlockKit(undefined, 'test')).not.toThrow();
  });

  it('refuses a payload that is not an array of blocks', () => {
    expect(() => assertBlockKit({}, 'test')).toThrow(/must be an array/);
    expect(() => assertBlockKit([], 'test')).toThrow(/is empty/);
    expect(() => assertBlockKit(['nope'], 'test')).toThrow(/is not an object/);
    expect(() => assertBlockKit([{}], 'test')).toThrow(/has no type/);
  });

  it('refuses more blocks than a message holds, and accepts exactly that many', () => {
    const many = (count: number) => Array.from({ length: count }, () => section('x'));
    expect(() => assertBlockKit(many(BLOCK_LIMITS.blocksPerMessage), 'test')).not.toThrow();
    expect(() => assertBlockKit(many(BLOCK_LIMITS.blocksPerMessage + 1), 'test')).toThrow(
      /Slack allows 50/,
    );
  });

  it('refuses section text over 3,000 characters, and accepts exactly 3,000', () => {
    expect(() =>
      assertBlockKit([section('x'.repeat(BLOCK_LIMITS.sectionText))], 'test'),
    ).not.toThrow();
    expect(() =>
      assertBlockKit([section('x'.repeat(BLOCK_LIMITS.sectionText + 1))], 'test'),
    ).toThrow(/3001 characters; Slack's limit is 3000/);
    expect(() => assertBlockKit([section('')], 'test')).toThrow(/is empty/);
  });

  it('refuses header text over 150 characters, and accepts exactly 150', () => {
    const header = (length: number) => [
      { type: 'header', text: { type: 'plain_text', text: 'x'.repeat(length) } },
    ];
    expect(() => assertBlockKit(header(BLOCK_LIMITS.headerText), 'test')).not.toThrow();
    expect(() => assertBlockKit(header(BLOCK_LIMITS.headerText + 1), 'test')).toThrow(
      /limit is 150/,
    );
  });

  it('refuses an actions block with no elements or more than 25, and accepts 25', () => {
    const buttons = (count: number) => [
      {
        type: 'actions',
        elements: Array.from({ length: count }, (_, index) => ({
          type: 'button',
          action_id: `a-${index}`,
          text: { type: 'plain_text', text: 'ok' },
          value: 'v',
        })),
      },
    ];
    expect(() => assertBlockKit(buttons(BLOCK_LIMITS.actionsElements), 'test')).not.toThrow();
    expect(() => assertBlockKit(buttons(BLOCK_LIMITS.actionsElements + 1), 'test')).toThrow(
      /the limit is 25/,
    );
    expect(() => assertBlockKit(buttons(0), 'test')).toThrow(/no elements/);
  });

  it('refuses an over-long button label, value, action_id or block_id', () => {
    const withButton = (button: Record<string, unknown>) => [
      {
        type: 'actions',
        block_id: 'agentic:question:x',
        elements: [{ type: 'button', ...button }],
      },
    ];
    const ok = {
      action_id: 'a',
      text: { type: 'plain_text', text: 'ok' },
      value: 'v',
    };
    expect(() => assertBlockKit(withButton(ok), 'test')).not.toThrow();
    expect(() =>
      assertBlockKit(
        withButton({ ...ok, text: { type: 'plain_text', text: 'x'.repeat(76) } }),
        'test',
      ),
    ).toThrow(/limit is 75/);
    expect(() => assertBlockKit(withButton({ ...ok, value: 'x'.repeat(2001) }), 'test')).toThrow(
      /value exceeds 2000/,
    );
    expect(() => assertBlockKit(withButton({ ...ok, action_id: 'x'.repeat(256) }), 'test')).toThrow(
      /action_id exceeds 255/,
    );
    expect(() =>
      assertBlockKit(
        [{ type: 'section', block_id: 'x'.repeat(256), text: { type: 'mrkdwn', text: 'x' } }],
        'test',
      ),
    ).toThrow(/block_id exceeds 255/);
  });

  it('refuses a button style Slack does not define', () => {
    const styled = (style: string) => [
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'a', text: { type: 'plain_text', text: 'ok' }, style },
        ],
      },
    ];
    expect(() => assertBlockKit(styled('primary'), 'test')).not.toThrow();
    expect(() => assertBlockKit(styled('danger'), 'test')).not.toThrow();
    expect(() => assertBlockKit(styled('destructive'), 'test')).toThrow(/primary.*danger/);
  });

  it('refuses more than 10 section fields, and accepts 10', () => {
    const fields = (count: number) => [
      {
        type: 'section',
        fields: Array.from({ length: count }, () => ({ type: 'mrkdwn', text: 'x' })),
      },
    ];
    expect(() => assertBlockKit(fields(BLOCK_LIMITS.sectionFields), 'test')).not.toThrow();
    expect(() => assertBlockKit(fields(BLOCK_LIMITS.sectionFields + 1), 'test')).toThrow(
      /the limit is 10/,
    );
  });

  it('never quotes the offending text, which may be anything a ticket held', () => {
    const secretish = 'FAKE-token-value-that-must-not-be-echoed';
    try {
      assertBlockKit([section(`${secretish}${'x'.repeat(BLOCK_LIMITS.sectionText)}`)], 'test');
      expect.unreachable('the over-long section should have been refused');
    } catch (error) {
      expect(String(error)).not.toContain(secretish);
    }
  });
});

describe('block ids', () => {
  it('round-trips, and refuses a block id that is not ours', () => {
    expect(parseQuestionBlockId(questionBlockId(QUESTION_ID))).toBe(QUESTION_ID);
    expect(parseApprovalBlockId(approvalBlockId(APPROVAL_ID))).toBe(APPROVAL_ID);
    expect(parseQuestionBlockId(approvalBlockId(APPROVAL_ID))).toBeNull();
    expect(parseQuestionBlockId('someone-elses-block')).toBeNull();
    expect(parseQuestionBlockId(undefined)).toBeNull();
    expect(parseApprovalBlockId(null)).toBeNull();
  });
});
