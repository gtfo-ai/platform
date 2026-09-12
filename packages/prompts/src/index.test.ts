/**
 * What a shipped role prompt has to satisfy, checked over **every** role rather than over the one
 * the author remembered (standing rule 68: a behaviour parameterised over a set gets a test
 * parameterised over the same set — and ten roles are a set).
 */
import { agentRoleSchema } from '@platform/contracts';
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
