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
import { PLATFORM_TOOL_NAMES, PLATFORM_TOOLS_BY_ROLE } from '@platform/application';
import { agentRoleSchema, artifactTypeSchema } from '@platform/contracts';
import {
  assemblePrompt,
  ENVIRONMENT_PROMPT,
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
          workspacePath: '1_hostile.md',
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
      ticketSnapshot: null,
      reviewSubject: null,
      historySample: null,
      artifacts: [],
      returnFeedback: null,
      record: [],
      reviewChecklists: [],
      observability: [],
    },
    artifactType: artifactTypeSchema.options[0] ?? null,
    // The role prompt is the whole brief here: this suite is about what a *role* puts in the
    // system prompt, and a stage's narrower instruction is another layer's subject.
    focus: null,
    // A `local` project: the CI instruction is a platform layer, not a role's text.
    verification: null,
    // `auto` is the shipped default (BD-016): follow the ticket's own language.
    language: 'auto',
    // Not an ask: this suite is about what a *role* puts in the system prompt (WP-31).
    ask: null,
    // No project prompt files: those are data blocks in the user prompt (WP-92), not a role's text.
    projectPrompts: [],
    // Backlogs 475 and 476: the workspace statement and the run's frame are platform text beside
    // every role, so the hostile checks below cover them too.
    environment: ENVIRONMENT_PROMPT.local,
    run: {
      maxTurns: 200,
      maxBudgetUsd: 40,
      platformTools: ['get_task_context', 'kb_search'],
      repository: true,
    },
  });

/**
 * A sentence of a role prompt that names a platform tool this build refuses — and so no run is
 * given (PROGRESS backlog 476, `availablePlatformTools`) — must say *when your tools include it*:
 * an unconditional "use `ask_human`" sends every run to a tool its list does not have.
 * `report_progress` left this list when it was built (backlog 496); the test below holds a prompt
 * that names it to a role that is given it. `get_conversation` joined it at WP-180: every role's
 * `PLATFORM_TOOLS_BY_ROLE` entry has it, but production refuses it until WP-181 adds it to
 * `IMPLEMENTED_PLATFORM_TOOLS`, so no production run's list carries it yet and the prompts keep the
 * hedge.
 */
const UNBUILT_TOOLS = [
  'ask_human',
  'notify_human',
  'add_ticket_comment',
  'create_followup_ticket',
  'get_conversation',
];
/**
 * Unbuilt in production, but **given to every role** (WP-180 ruling (c)): its sentences keep the
 * hedge above, and it is not exempt from *names only platform tools its role is given* — a role
 * whose prompt names it and whose `PLATFORM_TOOLS_BY_ROLE` entry lacks it fails that case.
 */
const GIVEN_THOUGH_UNBUILT = ['get_conversation'];
const HEDGE = /\b(when|if) your (platform )?tool(s| list)\b/i;
const unhedgedToolSentences = (text: string): readonly string[] =>
  text
    .replaceAll(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => UNBUILT_TOOLS.some((tool) => sentence.includes(`\`${tool}\``)))
    .filter((sentence) => !HEDGE.test(sentence));

describe.each(agentRoleSchema.options.map((role) => [role] as const))(
  'the shipped %s prompt',
  (role) => {
    it('reaches the system prompt under the platform prompt, in that order', () => {
      const assembled = assembleFor(role, 'benign');
      expect(assembled.systemPrompt.indexOf(PLATFORM_PROMPT)).toBe(0);
      expect(assembled.systemPrompt).toContain(ROLE_PROMPTS[role].text.trim());
      expect(assembled.promptVersion).toContain(`${role}@${ROLE_PROMPTS[role].version}`);
    });

    it('promises no unbuilt platform tool unconditionally, and no `.agentic-run/` directory', () => {
      expect(unhedgedToolSentences(ROLE_PROMPTS[role].text)).toEqual([]);
      expect(ROLE_PROMPTS[role].text).not.toContain('.agentic-run/');
    });

    /**
     * Backlog 496: a prompt that tells its role to call a platform tool is a prompt for a role the
     * planner gives that tool (`PLATFORM_TOOLS_BY_ROLE`) — otherwise the instruction names a tool the
     * run's *This run* list says does not exist.
     */
    it('names only platform tools its role is given', () => {
      const named = PLATFORM_TOOL_NAMES.filter((tool) =>
        ROLE_PROMPTS[role].text.includes(`\`${tool}\``),
      );
      const exempt = (tool: string) =>
        UNBUILT_TOOLS.includes(tool) && !GIVEN_THOUGH_UNBUILT.includes(tool);
      const unhedged = named.filter(
        (tool) => !exempt(tool) && !PLATFORM_TOOLS_BY_ROLE[role].includes(tool),
      );
      expect(unhedged).toEqual([]);
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

describe('the unbuilt-tool check', () => {
  it('fails an unconditional sentence and passes a hedged one', () => {
    expect(unhedgedToolSentences('Ask it with `ask_human` and a blocker brief.')).toHaveLength(1);
    expect(
      unhedgedToolSentences('When your platform tools include `ask_human`, ask it there.'),
    ).toEqual([]);
  });
});
