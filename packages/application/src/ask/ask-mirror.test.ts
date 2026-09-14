/**
 * The ask mirror's refusals and the comment it renders (WP-31, product/10:57).
 *
 * Five refusals, each a different fact and each asserted **by name** rather than by the absence of
 * a provider call — a duty that refused everything would pass a test that only looked for silence
 * (standing rule 42). The one case that posts is the other side of every one of them.
 *
 * `renderAskComment` is asserted directly because it is where the platform decides what of a
 * model's answer reaches somebody else's ticket tracker: the answer and the citations, as rows,
 * with **no URL the model wrote** — `AskAnswerCitation` has no URL field, and this is the reader
 * that would have used one.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { askCommentMarker } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { renderAskComment } from './mirror.js';
import type { StoredAsk } from './store.js';

const ASK_ID = '00000000-0000-4000-8000-0000000000d1' as Id;
const TASK_ID = '00000000-0000-4000-8000-0000000000b1' as Id;
const RUN_ID = '00000000-0000-4000-8000-0000000000c1' as Id;

const ask = (overrides: Partial<StoredAsk> = {}): StoredAsk => ({
  id: ASK_ID,
  taskId: TASK_ID,
  projectId: '00000000-0000-4000-8000-0000000000a1' as Id,
  source: 'ui',
  askedByUserId: '00000000-0000-4000-8000-0000000000e1' as Id,
  askedByIdentity: null,
  ticketCommentId: null,
  question: 'why a column?',
  runId: RUN_ID,
  status: 'answered',
  answer: 'Because a join on every read would be worse.',
  citations: [],
  droppedCitations: 0,
  answerArtifactId: null,
  refusalReason: null,
  redactionCount: 0,
  mirroredAt: null,
  createdAt: '2026-06-01T09:00:00.000Z' as IsoDateTime,
  answeredAt: '2026-06-01T09:01:00.000Z' as IsoDateTime,
  ...overrides,
});

describe('renderAskComment', () => {
  it('carries the answer, the marker and a link back to the thread', () => {
    const body = renderAskComment(ask(), 'https://agentic.example.test/');
    expect(body).toContain('Because a join on every read would be worse.');
    // The marker is what stops the platform reading its own answer back as a new question.
    expect(body).toContain(askCommentMarker(ASK_ID));
    // The trailing slash of the base URL is trimmed rather than doubled.
    expect(body).toContain(`https://agentic.example.test/tasks/${TASK_ID}`);
    expect(body).not.toContain('.test//tasks');
  });

  it('does not repeat the question', () => {
    // It is already in the thread when the ask came from there, and quoting a `ui` question into
    // somebody else's ticket publishes words the asker typed into a different audience's tool.
    expect(renderAskComment(ask(), 'https://agentic.example.test')).not.toContain('why a column?');
  });

  it('renders every citation kind as a row, and never as a link the model wrote', () => {
    const body = renderAskComment(
      ask({
        citations: [
          { kind: 'run', run_id: RUN_ID, detail: 'the architecture run' },
          {
            kind: 'artifact',
            artifact_type: 'ImplementationPlan',
            version: 2,
            detail: 'the rationale',
          },
          { kind: 'audit', reference: 'action-1', detail: 'the pause' },
          { kind: 'knowledge', reference: 'technical/04.md', detail: 'the rule' },
        ],
      }),
      'https://agentic.example.test',
    );
    expect(body).toContain('Based on:');
    expect(body).toContain(`run \`${RUN_ID}\``);
    expect(body).toContain('ImplementationPlan v2');
    expect(body).toContain('audit entry `action-1`');
    expect(body).toContain('knowledge: `technical/04.md`');
    // The only URL in the whole body is the one this function built.
    expect([...body.matchAll(/https?:\/\/\S+/g)].map((match) => match[0])).toEqual([
      `https://agentic.example.test/tasks/${TASK_ID}`,
    ]);
  });

  it('names an unnamed citation rather than printing `undefined`', () => {
    // `run_id`, `artifact_type`, `version` and `reference` are all nullish in the contract, because
    // which of them a citation carries depends on its kind. A renderer that read the wrong one
    // would put `undefined` on somebody's ticket (standing rule 18).
    const body = renderAskComment(
      ask({
        citations: [
          { kind: 'run', detail: 'a run it did not name' },
          { kind: 'artifact', detail: 'an artifact it did not name' },
          { kind: 'audit', detail: 'an action it did not name' },
          { kind: 'knowledge', detail: 'a page it did not name' },
        ],
      }),
      'https://agentic.example.test',
    );
    expect(body).not.toContain('undefined');
    expect(body).toContain('(unnamed)');
    expect(body).toContain('v?');
  });

  it('omits the citation list entirely when there is none', () => {
    expect(renderAskComment(ask(), 'https://agentic.example.test')).not.toContain('Based on:');
  });
});
