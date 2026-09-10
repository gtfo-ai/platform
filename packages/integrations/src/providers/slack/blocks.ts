/**
 * Block Kit: what the adapter renders, and the validation the fake deliberately does not do.
 *
 * `FakeCommunication`'s divergence register, entry 4:
 *
 * > **Kinder, deliberately — `blocks` is never validated.** The port treats it as an opaque
 * > provider payload …, so anything passes here while Slack rejects malformed Block Kit with
 * > `invalid_blocks`. **WP-10 owns that validation and its golden fixtures.**
 *
 * This is that validation. It runs on every outbound message — on what this module built *and* on
 * `blocks` a caller passed in `MessageBody` — before the call leaves the process, because the
 * alternative is finding out from a 200 response with `ok: false` after the pipeline has already
 * recorded that a question was asked. The limits are Slack's own, transcribed with the page each
 * came from; nothing here is a guess.
 *
 * Sources, all retrieved 2026-09-10:
 *  - <https://docs.slack.dev/reference/block-kit/blocks> — "You can include up to 50 blocks in
 *    each message, and 100 blocks in modals or Home tabs."
 *  - <https://docs.slack.dev/reference/block-kit/blocks/section-block> — text 1–3,000 characters;
 *    `block_id` maximum 255; `fields` maximum 10 items, 2,000 characters each.
 *  - <https://docs.slack.dev/reference/block-kit/blocks/actions-block> — "There is a maximum of 25
 *    elements in each action block"; `block_id` maximum 255.
 *  - <https://docs.slack.dev/reference/block-kit/blocks/header-block> — text maximum 150.
 *  - <https://docs.slack.dev/reference/block-kit/block-elements/button-element> — text 75, value
 *    2,000, `action_id` 255, `url` 3,000, `style` is `primary` or `danger`.
 *  - <https://docs.slack.dev/reference/methods/chat.update> — "The `text` field cannot exceed
 *    4,000 characters" (`msg_too_long`).
 *
 * ## Identifying our own buttons
 *
 * A `block_id` is echoed back in the interaction payload, which makes it the only place to put
 * "which question is this". It is `agentic:question:<uuid>` / `agentic:approval:<uuid>`, and the
 * inbound normaliser refuses anything else — a workspace member can add their own buttons to a
 * message they post, and those must not decide a pipeline gate.
 */
import { IntegrationError } from '@platform/application';
import type { Id } from '@platform/contracts';
import { SLACK_PROVIDER_ID } from './http.js';
import { escapeSlackText, isLinkableUrl, toMrkdwn, truncate } from './mrkdwn.js';

/** Documented Block Kit limits. Named so a failure message can quote the one it hit. */
export const BLOCK_LIMITS = {
  blocksPerMessage: 50,
  blockId: 255,
  sectionText: 3000,
  sectionFields: 10,
  sectionFieldText: 2000,
  headerText: 150,
  actionsElements: 25,
  buttonText: 75,
  buttonValue: 2000,
  actionId: 255,
  contextElements: 10,
  /** `chat.postMessage`'s fallback `text`, not a block. */
  messageText: 4000,
} as const;

export const ANSWER_ACTION_ID = 'agentic_answer';
export const APPROVE_ACTION_ID = 'agentic_approve';
export const REJECT_ACTION_ID = 'agentic_reject';

const QUESTION_BLOCK_PREFIX = 'agentic:question:';
const APPROVAL_BLOCK_PREFIX = 'agentic:approval:';

export const questionBlockId = (questionId: Id): string => `${QUESTION_BLOCK_PREFIX}${questionId}`;
export const approvalBlockId = (approvalId: Id): string => `${APPROVAL_BLOCK_PREFIX}${approvalId}`;

/** The question id a `block_id` names, or `null` when the block is not one of ours. */
export const parseQuestionBlockId = (blockId: string | null | undefined): string | null =>
  typeof blockId === 'string' && blockId.startsWith(QUESTION_BLOCK_PREFIX)
    ? blockId.slice(QUESTION_BLOCK_PREFIX.length)
    : null;

export const parseApprovalBlockId = (blockId: string | null | undefined): string | null =>
  typeof blockId === 'string' && blockId.startsWith(APPROVAL_BLOCK_PREFIX)
    ? blockId.slice(APPROVAL_BLOCK_PREFIX.length)
    : null;

// ── Building ─────────────────────────────────────────────────────────────────

export interface SlackTextObject {
  readonly type: 'mrkdwn' | 'plain_text';
  readonly text: string;
  readonly emoji?: boolean;
}

export interface SlackBlock {
  readonly type: string;
  readonly block_id?: string;
  readonly text?: SlackTextObject;
  readonly elements?: readonly unknown[];
  readonly fields?: readonly SlackTextObject[];
}

const mrkdwnSection = (markdown: string): SlackBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text: truncate(toMrkdwn(markdown), BLOCK_LIMITS.sectionText) },
});

const context = (markdown: string): SlackBlock => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text: truncate(toMrkdwn(markdown), BLOCK_LIMITS.sectionText) }],
});

/**
 * The value a button carries back.
 *
 * It holds the option *text* rather than an index, so the normalised answer is the string the
 * human read rather than a number a later refactor could renumber. It is JSON so that it stays
 * one field, and it is length-bounded because Slack rejects a value over 2,000 characters.
 *
 * The option goes in **unescaped**, and this is the one place in this file where untrusted text
 * does not pass through `escapeSlackText`. A button `value` is an opaque round-trip field: Slack
 * never renders it, it comes back verbatim in the interaction payload, and `<!channel>` inside one
 * is a string rather than a broadcast. Escaping it here would corrupt data instead of preventing
 * anything — `inbound.ts` hands this string to the domain as `task.question.answered.answer`, so
 * the human's answer would be recorded as `&lt;!channel&gt;`. What has to stay true is that the
 * value is never *displayed*: the label comes from the button's `text`, which is escaped, and
 * `blocks.test.ts` asserts the raw string appears in no rendered field of the message.
 */
export const answerButtonValue = (questionId: Id, option: string): string => {
  const budget = BLOCK_LIMITS.buttonValue - JSON.stringify({ q: questionId, o: '' }).length;
  return JSON.stringify({ q: questionId, o: truncate(option, Math.max(1, budget)) });
};

const button = (input: {
  actionId: string;
  text: string;
  value: string;
  style?: 'primary' | 'danger';
}): Record<string, unknown> => ({
  type: 'button',
  action_id: input.actionId,
  // `plain_text` is not parsed for control characters, but escaping costs nothing and keeps one
  // rule ("escape everything untrusted") instead of two.
  text: {
    type: 'plain_text',
    text: truncate(escapeSlackText(input.text), BLOCK_LIMITS.buttonText),
  },
  value: input.value,
  ...(input.style === undefined ? {} : { style: input.style }),
});

/** The first message of a task thread. */
export const taskThreadBlocks = (markdown: string): readonly SlackBlock[] => [
  mrkdwnSection(markdown),
];

/**
 * A question: the text, one button per option, and the standing invitation to reply in the thread.
 *
 * A question with no options gets no `actions` block at all — an empty one is `invalid_blocks` —
 * and the context line is what tells the human the thread reply is the answer. A question with
 * more options than an actions block holds keeps the first 25 and says so, because dropping the
 * rest silently would show a human a list that is missing the answer they wanted.
 */
export const questionBlocks = (input: {
  readonly questionId: Id;
  readonly markdown: string;
  readonly options: readonly string[];
}): readonly SlackBlock[] => {
  const shown = input.options.slice(0, BLOCK_LIMITS.actionsElements);
  const dropped = input.options.length - shown.length;
  const blocks: SlackBlock[] = [mrkdwnSection(input.markdown)];
  if (shown.length > 0) {
    blocks.push({
      type: 'actions',
      block_id: questionBlockId(input.questionId),
      elements: shown.map((option) =>
        button({
          actionId: ANSWER_ACTION_ID,
          text: option,
          value: answerButtonValue(input.questionId, option),
        }),
      ),
    });
  }
  blocks.push(
    context(
      dropped > 0
        ? `Reply in this thread to answer (${dropped} more option${dropped === 1 ? '' : 's'} not shown).`
        : 'Reply in this thread to answer.',
    ),
  );
  return blocks;
};

/** An approval: Approve / Request changes, and nothing that could be mistaken for either. */
export const approvalBlocks = (input: {
  readonly approvalId: Id;
  readonly markdown: string;
}): readonly SlackBlock[] => [
  mrkdwnSection(input.markdown),
  {
    type: 'actions',
    block_id: approvalBlockId(input.approvalId),
    elements: [
      button({
        actionId: APPROVE_ACTION_ID,
        text: 'Approve',
        value: JSON.stringify({ a: input.approvalId, d: 'approved' }),
        style: 'primary',
      }),
      button({
        actionId: REJECT_ACTION_ID,
        text: 'Request changes',
        value: JSON.stringify({ a: input.approvalId, d: 'rejected' }),
        style: 'danger',
      }),
    ],
  },
  context('Or reply in this thread with your reasoning.'),
];

export interface DigestLine {
  readonly title: string;
  readonly state: string;
  readonly url?: string | null;
  readonly detail?: string | null;
}

/**
 * The digest. One section per line rather than one section holding every line, so a long digest
 * degrades by dropping *lines* (visibly, with a count) instead of by truncating mid-sentence.
 */
export const digestBlocks = (
  heading: string,
  items: readonly DigestLine[],
): readonly SlackBlock[] => {
  const header: SlackBlock = {
    type: 'header',
    text: {
      type: 'plain_text',
      text: truncate(escapeSlackText(heading), BLOCK_LIMITS.headerText),
      emoji: true,
    },
  };
  // The header and the trailing context line each cost one of the 50.
  const room = BLOCK_LIMITS.blocksPerMessage - 2;
  const shown = items.slice(0, room);
  const dropped = items.length - shown.length;
  const lines = shown.map((item) => {
    // Same class as the `mrkdwn` link converter, different call site: a digest line's URL comes
    // from a ticket, so it is untrusted, and interpolating it raw would let `…><!channel>` close
    // the link and open a broadcast. Escape it, and only bracket a scheme Slack may be handed.
    const link =
      item.url == null || !isLinkableUrl(item.url)
        ? escapeSlackText(item.title)
        : `<${escapeSlackText(item.url)}|${escapeSlackText(item.title)}>`;
    const detail =
      item.detail == null || item.detail === '' ? '' : ` — ${escapeSlackText(item.detail)}`;
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncate(
          `• ${link} — *${escapeSlackText(item.state)}*${detail}`,
          BLOCK_LIMITS.sectionText,
        ),
      },
    } satisfies SlackBlock;
  });
  return [
    header,
    ...lines,
    context(
      dropped > 0
        ? `${items.length} items, ${dropped} not shown.`
        : `${items.length} item${items.length === 1 ? '' : 's'}.`,
    ),
  ];
};

// ── Validating ───────────────────────────────────────────────────────────────

const invalid = (action: string, detail: string): IntegrationError =>
  new IntegrationError('invalid_request', SLACK_PROVIDER_ID, detail, { action });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textLength = (value: unknown): number | null => {
  if (!isRecord(value)) {
    return null;
  }
  return typeof value.text === 'string' ? value.text.length : null;
};

const checkText = (
  where: string,
  value: unknown,
  limit: number,
  action: string,
  required: boolean,
): void => {
  const length = textLength(value);
  if (length === null) {
    if (required) {
      throw invalid(action, `${where} needs a text object with a string "text"`);
    }
    return;
  }
  if (length === 0) {
    throw invalid(action, `${where} text is empty; Slack rejects it as invalid_blocks`);
  }
  if (length > limit) {
    throw invalid(action, `${where} text is ${length} characters; Slack's limit is ${limit}`);
  }
};

const checkButton = (where: string, element: Record<string, unknown>, action: string): void => {
  checkText(`${where} text`, element.text, BLOCK_LIMITS.buttonText, action, true);
  if (typeof element.action_id === 'string' && element.action_id.length > BLOCK_LIMITS.actionId) {
    throw invalid(action, `${where} action_id exceeds ${BLOCK_LIMITS.actionId} characters`);
  }
  if (typeof element.value === 'string' && element.value.length > BLOCK_LIMITS.buttonValue) {
    throw invalid(action, `${where} value exceeds ${BLOCK_LIMITS.buttonValue} characters`);
  }
  if (element.style !== undefined && element.style !== 'primary' && element.style !== 'danger') {
    throw invalid(action, `${where} style must be "primary" or "danger"`);
  }
};

const checkBlock = (index: number, block: unknown, action: string): void => {
  const where = `blocks[${index}]`;
  if (!isRecord(block)) {
    throw invalid(action, `${where} is not an object`);
  }
  if (typeof block.type !== 'string' || block.type === '') {
    throw invalid(action, `${where} has no type`);
  }
  if (typeof block.block_id === 'string' && block.block_id.length > BLOCK_LIMITS.blockId) {
    throw invalid(action, `${where} block_id exceeds ${BLOCK_LIMITS.blockId} characters`);
  }
  if (block.type === 'section') {
    checkText(where, block.text, BLOCK_LIMITS.sectionText, action, !Array.isArray(block.fields));
    if (Array.isArray(block.fields)) {
      if (block.fields.length > BLOCK_LIMITS.sectionFields) {
        throw invalid(action, `${where} has ${block.fields.length} fields; the limit is 10`);
      }
      block.fields.forEach((field, at) => {
        checkText(`${where}.fields[${at}]`, field, BLOCK_LIMITS.sectionFieldText, action, true);
      });
    }
  }
  if (block.type === 'header') {
    checkText(where, block.text, BLOCK_LIMITS.headerText, action, true);
  }
  if (block.type === 'actions') {
    if (!Array.isArray(block.elements) || block.elements.length === 0) {
      throw invalid(action, `${where} is an actions block with no elements`);
    }
    if (block.elements.length > BLOCK_LIMITS.actionsElements) {
      throw invalid(
        action,
        `${where} has ${block.elements.length} elements; the limit is ${BLOCK_LIMITS.actionsElements}`,
      );
    }
    block.elements.forEach((element, at) => {
      if (!isRecord(element)) {
        throw invalid(action, `${where}.elements[${at}] is not an object`);
      }
      if (element.type === 'button') {
        checkButton(`${where}.elements[${at}]`, element, action);
      }
    });
  }
  if (block.type === 'context') {
    if (!Array.isArray(block.elements) || block.elements.length === 0) {
      throw invalid(action, `${where} is a context block with no elements`);
    }
    if (block.elements.length > BLOCK_LIMITS.contextElements) {
      throw invalid(action, `${where} has more than ${BLOCK_LIMITS.contextElements} elements`);
    }
  }
};

/**
 * Refuses Block Kit Slack would refuse, before the request is sent.
 *
 * @throws {IntegrationError} `invalid_request` naming the block and the limit. It never quotes the
 * offending text: a block's text can hold anything a ticket held (BD-022).
 */
export const assertBlockKit = (blocks: unknown, action: string): void => {
  if (blocks === undefined || blocks === null) {
    return;
  }
  if (!Array.isArray(blocks)) {
    throw invalid(action, 'blocks must be an array');
  }
  if (blocks.length === 0) {
    throw invalid(action, 'blocks is empty; omit it instead of sending an empty array');
  }
  if (blocks.length > BLOCK_LIMITS.blocksPerMessage) {
    throw invalid(
      action,
      `${blocks.length} blocks; Slack allows ${BLOCK_LIMITS.blocksPerMessage} in a message`,
    );
  }
  blocks.forEach((block, index) => {
    checkBlock(index, block, action);
  });
};
