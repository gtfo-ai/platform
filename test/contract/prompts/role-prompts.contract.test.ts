/**
 * The contract between the prompt **library** and the prompt **assembler**.
 *
 * It lives here rather than in either package because the dependency rule keeps them apart:
 * `@platform/prompts` may import `@platform/contracts` and nothing else, so it cannot drive the
 * assembler, and `@platform/domain` must not know where prompts are stored. The binding is real
 * all the same — `apps/server` hands one to the other on every run — and standing rule 23 says a
 * cross-package obligation belongs in a shared suite rather than in one side's own tests.
 *
 * Parameterised over **every** `AgentRole` (rule 68), and fed the hostile constructs from
 * `HOSTILE_CONSTRUCTS` rather than a hand-picked string, so "the role prompt survives untrusted
 * text" is checked for the roles nobody remembered as well as for the one that motivated the test.
 */
import { agentRoleSchema, artifactTypeSchema } from '@platform/contracts';
import {
  assemblePrompt,
  HOSTILE_CONSTRUCTS,
  HOSTILE_TEXT,
  PLATFORM_PROMPT,
  readDataBlocks,
} from '@platform/domain';
import { ROLE_PROMPTS } from '@platform/prompts';
import { describe, expect, it } from 'vitest';

const NONCE = 'fedcba9876543210fedcba9876543210';

const assembleFor = (role: (typeof agentRoleSchema.options)[number], text: string) =>
  assemblePrompt({
    nonce: { next: () => NONCE },
    role: ROLE_PROMPTS[role],
    pack: {
      status: 'ok',
      documents: [
        {
          tier: 1,
          path: '.agentic/knowledge/technical/hostile-document.md',
          workspacePath: '.agentic-run/context/1_hostile.md',
          reason: 'trigger',
          tokens: 100,
          text,
        },
      ],
      budgetTokens: 12_000,
      totalTokens: 100,
    },
    task: {
      stage: 'refinement',
      attempt: 1,
      ticket: { provider: 'jira', key: 'ACME-1', url: 'https://jira.example.test/browse/ACME-1' },
      artifacts: [],
      returnFeedback: null,
    },
    artifactType: artifactTypeSchema.options[0] ?? null,
  });

describe.each(agentRoleSchema.options.map((role) => [role] as const))(
  'the shipped %s prompt',
  (role) => {
    it('reaches the system prompt under the platform prompt, in that order', () => {
      const assembled = assembleFor(role, 'benign');
      expect(assembled.systemPrompt.indexOf(PLATFORM_PROMPT)).toBe(0);
      expect(assembled.systemPrompt).toContain(ROLE_PROMPTS[role].text.trim());
      expect(assembled.promptVersion).toContain(`${role}@${ROLE_PROMPTS[role].version}`);
    });

    it('never itself contains a data-block marker, which would make the platform a spoofer', () => {
      // The role prompt is the platform's voice. A marker inside it would be a block a reader
      // closes in the wrong place, produced by the platform rather than by an attacker.
      expect(ROLE_PROMPTS[role].text).not.toMatch(/<\/?untrusted-data-[0-9a-f]{4,}/);
    });

    it.each(Object.keys(HOSTILE_CONSTRUCTS))(
      'keeps %s inside the data delimiter and out of its own voice',
      (name) => {
        const construct = HOSTILE_CONSTRUCTS[name as keyof typeof HOSTILE_CONSTRUCTS];
        const assembled = assembleFor(role, HOSTILE_TEXT);
        const reading = readDataBlocks(assembled.userPrompt);
        expect(reading.nonce).toBe(NONCE);
        expect(reading.unterminated).toBe(0);
        expect(reading.blocks[0]?.body).toContain(construct);
        expect(reading.platformVoice.join('\n')).not.toContain(construct);
        expect(assembled.systemPrompt).not.toContain(construct);
      },
    );

    it('keeps its platform voice byte-identical whatever the document says', () => {
      const benign = readDataBlocks(assembleFor(role, 'benign').userPrompt);
      const hostile = readDataBlocks(assembleFor(role, HOSTILE_TEXT).userPrompt);
      expect(hostile.platformVoice).toEqual(benign.platformVoice);
      expect(hostile.blocks.map((block) => block.attributes)).toEqual(
        benign.blocks.map((block) => block.attributes),
      );
    });
  },
);
