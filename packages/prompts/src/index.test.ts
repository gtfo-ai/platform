/**
 * What a shipped role prompt has to satisfy, checked over **every** role rather than over the one
 * the author remembered (standing rule 68: a behaviour parameterised over a set gets a test
 * parameterised over the same set — and ten roles are a set).
 */
import { agentRoleSchema, threadReplySchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { packageId, ROLE_PROMPT_VERSIONS, ROLE_PROMPTS, rolePromptPath } from './index.js';

const ROLES = agentRoleSchema.options;

describe('@platform/prompts', () => {
  it('is wired into the workspace', () => {
    expect(packageId).toBe('@platform/prompts');
  });

  it('ships one prompt per role in `AgentRole`, and no others', () => {
    expect(Object.keys(ROLE_PROMPTS).sort()).toEqual([...ROLES].sort());
    expect(Object.keys(ROLE_PROMPT_VERSIONS).sort()).toEqual([...ROLES].sort());
  });
});

describe.each(ROLES.map((role) => [role] as const))('the %s prompt', (role) => {
  const prompt = ROLE_PROMPTS[role];

  it('is substantial prose rather than a placeholder', () => {
    expect(prompt.text.length).toBeGreaterThan(600);
    expect(prompt.text).toContain('\n');
    expect(rolePromptPath(role).endsWith(`${role}/prompt.md`)).toBe(true);
  });

  it('carries a version and a role name the assembler can put in the platform voice', () => {
    // Mirrors `SAFE_ATTRIBUTE_VALUE` in `@platform/domain`, which this package may not import (the
    // dependency rule: prompts sees contracts and nothing else). The **binding** check is
    // `test/contract/prompts/role-prompts.contract.test.ts`, which imports both and drives the real
    // assembler over every shipped prompt; this one is here so a bad version fails in its own
    // package too.
    expect(prompt.version).toMatch(/^[A-Za-z0-9._/-]{1,512}$/);
    expect(prompt.role).toMatch(/^[A-Za-z0-9._/-]{1,512}$/);
  });

  it('contains no invisible character a reviewer of the diff could not see', () => {
    // The class CLAUDE.md's NUL rule is the loudest member of: a source whose diff hides the point
    // of the change. A prompt is source, and a zero-width character in one is invisible twice over
    // — in the diff and in the rendered prompt.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
    expect(prompt.text).not.toMatch(/[\u{0000}-\u{0008}\u{000B}-\u{001F}\u{007F}-\u{009F}]/u);
    expect(prompt.text).not.toMatch(
      /[\u{00AD}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}\u{FEFF}]/u,
    );
  });
});

/** Sentences, whitespace folded: what the per-sentence checks below read. */
const sentencesOf = (text: string): readonly string[] =>
  text
    .replaceAll(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.length > 0);

/** Every backticked or double-quoted span of a sentence. */
const quotedSpans = (sentence: string): readonly string[] =>
  [...sentence.matchAll(/`([^`]+)`|"([^"]+)"|“([^”]+)”/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );

describe.each(ROLES.map((role) => [role] as const))(
  'the %s prompt and the conversation',
  (role) => {
    const text = ROLE_PROMPTS[role].text;

    it('says the conversation blocks and `get_conversation` are data (WP-176 (a))', () => {
      for (const name of ['`conversation`', '`conversation_author`', '`conversation_path`']) {
        expect(text, name).toContain(name);
      }
      expect(text).toMatch(/Both are \*\*data\*\* \(non-negotiable 1\)/);
      expect(text).toContain('`platform="true"`');
      // `get_conversation` is in every role's list since WP-180, but production serves it only from
      // WP-181, so no production run is given it yet: every sentence naming it says *when your
      // platform tools include* it, the hedge the role-prompts contract holds for the other unbuilt
      // tools (backlog 476).
      const naming = sentencesOf(text).filter((sentence) =>
        sentence.includes('`get_conversation`'),
      );
      expect(naming.length).toBeGreaterThan(0);
      for (const sentence of naming) {
        expect(sentence).toMatch(/\bwhen your platform tools include\b/i);
      }
    });

    it('names no tracker status: a sentence about a ticket status quotes only slot-like identifiers (WP-176 (e))', () => {
      // A status name belongs to a project's tracker and its binding, never to a shipped prompt; the
      // prompt names a slot by its product name (`in_progress`, `returned`) or not at all. The residual
      // is stated: an unquoted name in plain prose is not seen.
      const aboutStatus = sentencesOf(text).filter(
        (sentence) => /\bstatus(es)?\b/i.test(sentence) && /\b(ticket|tracker)\b/i.test(sentence),
      );
      for (const sentence of aboutStatus) {
        for (const span of quotedSpans(sentence)) {
          expect(span, sentence).toMatch(/^[a-z][a-z0-9_]*$/);
        }
      }
    });
  },
);

describe('the Developer and the conversation (WP-176 (b))', () => {
  const text = ROLE_PROMPTS.developer.text;

  it('names `thread_replies` and every reply kind the artifact schema has', () => {
    expect(text).toContain('`thread_replies`');
    for (const kind of threadReplySchema.shape.kind.options) {
      expect(text, kind).toContain(`\`${kind}\``);
    }
  });

  it('answers a mixed note one entry per request and never claims a person’s action done', () => {
    expect(text).toContain('one entry per request');
    expect(text).toContain('Never claim that a person');
  });

  it('reads the conversation on a return that carries no request, and asks when it finds nothing', () => {
    expect(text).toMatch(/A return may carry no request at all/);
    expect(text).toMatch(/If you find nothing to fix/);
  });
});

describe('the Reviewer and the conversation (WP-176 (c))', () => {
  const text = ROLE_PROMPTS.reviewer.text;

  it('resolves only its own finding threads, never a person’s', () => {
    expect(text).toContain('`resolved_threads`');
    expect(text).toContain('agentic:review-finding:');
    expect(text).toContain("Never a person's thread");
  });
});
