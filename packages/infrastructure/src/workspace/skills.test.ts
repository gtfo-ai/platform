/**
 * `workspaceSkillFiles` and `runSkillsFor` — the one decision both providers make about skill files,
 * and the one place the skills a run is given are built (WP-279: from the request, never a catalogue
 * the launcher holds).
 *
 * Pure functions, so the *shape* of a provisioned workspace can be asserted without a daemon; what a
 * real container ends up holding is `docker-workspace.e2e.test.ts`.
 */
import { skillSetVersionOf } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { SKILL_CATALOGUE_FIXTURE, workspaceSpecFixture } from './fixtures.js';
import { runSkillsFor, workspaceSkillFiles } from './skills.js';

const spec = workspaceSpecFixture();
const skills = runSkillsFor(spec.runId, spec.skills, SKILL_CATALOGUE_FIXTURE);

describe('the files a workspace is provisioned with', () => {
  it('puts each skill under the plugin directory, inside the checkout', () => {
    expect(workspaceSkillFiles(spec, skills)).toEqual([
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
    const paths = workspaceSkillFiles(spec, skills).map((file) => file.path);
    expect(paths.some((path) => path.includes('.claude'))).toBe(false);
  });

  it('is stable in order, so two runs of the same spec produce the same script', () => {
    const reversed = workspaceSpecFixture({ skills: ['kb', 'ask-human'] });
    expect(workspaceSkillFiles(reversed, skills)).toEqual(workspaceSkillFiles(spec, skills));
  });

  it('gives a workspace nothing when the role has no skills', () => {
    const none = workspaceSpecFixture({ skills: [] });
    expect(workspaceSkillFiles(none, runSkillsFor(none.runId, [], {}))).toEqual([]);
  });
});

describe('the skills a create request carries (WP-279, TD-031 decision 4)', () => {
  it('carries the digest the planner records in prompt_version', () => {
    const definitions = ['ask-human', 'kb'].map((name) => SKILL_CATALOGUE_FIXTURE[name]);
    expect(skills.digest).toBe(
      skillSetVersionOf(definitions as NonNullable<(typeof definitions)[number]>[]),
    );
    expect(skills.versions).toEqual({ 'ask-human': 'fixture', kb: 'fixture' });
  });

  /**
   * The planner and this builder read one `@platform/prompts` in one process, so a name one of them
   * has and the other does not is a bug — refused by name rather than provisioned with a hole.
   */
  it('refuses to build a skill this deployment does not ship, naming it', () => {
    expect(() => runSkillsFor(spec.runId, ['kb', 'retro'], SKILL_CATALOGUE_FIXTURE)).toThrow(
      /"retro"/,
    );
  });

  it('refuses bytes whose digest is not the one the request names', () => {
    const tampered = {
      ...skills,
      files: { ...skills.files, kb: { 'SKILL.md': 'not the planned bytes' } },
    };
    expect(() => workspaceSkillFiles(spec, tampered)).toThrow(
      expect.objectContaining({ code: 'invalid_spec', reason: 'skill_set_invalid' }),
    );
    expect(() => workspaceSkillFiles(spec, tampered)).toThrow(/digest to skills@[0-9a-f]{16}/);
  });

  it('refuses a version that is not the one the digest folded', () => {
    const bumped = { ...skills, versions: { ...skills.versions, kb: '99' } };
    expect(() => workspaceSkillFiles(spec, bumped)).toThrow(/they are not the bytes/);
  });

  it('refuses the content of other skills than the spec names, and a second file', () => {
    expect(() => workspaceSkillFiles(workspaceSpecFixture({ skills: ['kb'] }), skills)).toThrow(
      /exactly the skills the WorkspaceSpec names/,
    );
    const extra = {
      ...skills,
      files: { ...skills.files, kb: { ...skills.files['kb'], 'run.sh': 'echo unverified' } },
    };
    expect(() => workspaceSkillFiles(spec, extra)).toThrow(/SKILL\.md and nothing else/);
  });
});
