/**
 * `workspaceSkillFiles` — the one decision both providers make about skill files.
 *
 * It is a pure function so that the *shape* of a provisioned workspace can be asserted without a
 * daemon; what a real container ends up holding is `docker-workspace.e2e.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { SKILL_CATALOGUE_FIXTURE, workspaceSpecFixture } from './fixtures.js';
import { workspaceSkillFiles } from './skills.js';

describe('the files a workspace is provisioned with', () => {
  it('puts each skill under the plugin directory, inside the checkout', () => {
    expect(workspaceSkillFiles(workspaceSpecFixture(), SKILL_CATALOGUE_FIXTURE)).toEqual([
      {
        path: '.agentic-run/plugins/agentic/skills/ask-human/SKILL.md',
        content: SKILL_CATALOGUE_FIXTURE['ask-human']?.text,
      },
      {
        path: '.agentic-run/plugins/agentic/skills/kb/SKILL.md',
        content: SKILL_CATALOGUE_FIXTURE['kb']?.text,
      },
    ]);
  });

  it('writes nothing inside the project’s own .claude directory', () => {
    const paths = workspaceSkillFiles(workspaceSpecFixture(), SKILL_CATALOGUE_FIXTURE).map(
      (file) => file.path,
    );
    expect(paths.some((path) => path.includes('.claude'))).toBe(false);
  });

  it('is stable in order, so two runs of the same spec produce the same script', () => {
    const reversed = workspaceSpecFixture({ skills: ['kb', 'ask-human'] });
    expect(workspaceSkillFiles(reversed, SKILL_CATALOGUE_FIXTURE)).toEqual(
      workspaceSkillFiles(workspaceSpecFixture(), SKILL_CATALOGUE_FIXTURE),
    );
  });

  it('gives a workspace nothing when the role has no skills', () => {
    expect(
      workspaceSkillFiles(workspaceSpecFixture({ skills: [] }), SKILL_CATALOGUE_FIXTURE),
    ).toEqual([]);
  });

  /**
   * The planner and the launcher ship in one deployment, so a name one of them has and the other
   * does not is a bug rather than a configuration — and a workspace silently missing the skill its
   * `RunSpec` claims is exactly the green standing rule 82 warns about.
   */
  it('refuses a name this deployment does not ship, naming it', () => {
    expect(() =>
      workspaceSkillFiles(
        workspaceSpecFixture({ skills: ['kb', 'retro'] }),
        SKILL_CATALOGUE_FIXTURE,
      ),
    ).toThrow(/"retro"/);
  });
});
