/**
 * The ten skill files, held to the shape the CLI reads them with.
 *
 * Everything here is read **off disk** (standing rule 7): the directory listing is the source of
 * truth for what exists, so a skill added without a declared version, or a version declared for a
 * skill nobody wrote, fails here rather than at a customer's first run.
 *
 * What this tier deliberately does **not** assert: that a model can use one, or that the CLI
 * discovers them once they are in a workspace. The first needs a credential this repository does
 * not have (the blocker brief in PROGRESS under WP-17); the second is asserted against a real
 * container in `test/e2e/workspace/docker-workspace.e2e.test.ts`, because a fake provider and
 * `FakeClaudeRunner` will happily pass a run whose skills were never copied (standing rule 82).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_SKILL_BYTES,
  PLATFORM_SKILL_NAMES,
  PLATFORM_SKILL_VERSIONS,
  PLATFORM_SKILLS,
  parseSkillFrontmatter,
  platformSkillDirectories,
  platformSkillPath,
} from './skills.js';

/** product/13 § "Skills" names exactly these. A skill that is not in it is a product decision. */
const PRODUCT_13_SKILLS = [
  'ask-human',
  'file-followup-ticket',
  'gitlab-mr',
  'jira-ticket',
  'kb',
  'loki-logs',
  'mr-description',
  'retro',
  'sentry-issue',
  'verify-work',
];

describe('the shipped platform skills', () => {
  it('is exactly the set product/13 names, read off disk', () => {
    expect(platformSkillDirectories()).toEqual(PRODUCT_13_SKILLS);
  });

  it('declares a version for every directory, and a directory for every version', () => {
    expect(Object.keys(PLATFORM_SKILL_VERSIONS).sort()).toEqual([...PLATFORM_SKILL_NAMES].sort());
  });

  /**
   * The rule the whole delivery rests on: the CLI matches a skill by its **directory** name.
   *
   * Measured against the pinned CLI — a `SKILL.md` in `dir-name-here/` whose frontmatter says
   * `name: frontmatter-name` is listed as `dir-name-here` — and the CLI's own error text says the
   * same ("Skill names match the skill's directory name"). Keeping the two equal means it does not
   * matter which of them a later version reads.
   */
  it.each(PLATFORM_SKILL_NAMES)('%s: frontmatter name equals the directory name', (name) => {
    const skill = PLATFORM_SKILLS[name];
    expect(skill).toBeDefined();
    const parsed = parseSkillFrontmatter(readFileSync(platformSkillPath(name), 'utf8'), name);
    expect(parsed.name).toBe(name);
    expect(skill?.description).toBe(parsed.description);
  });

  it.each(PLATFORM_SKILL_NAMES)('%s: has a description a model can choose by', (name) => {
    const description = PLATFORM_SKILLS[name]?.description ?? '';
    // Long enough to say when to use it, short enough that ten of them are cheap to list.
    expect(description.length).toBeGreaterThan(40);
    expect(description.length).toBeLessThanOrEqual(400);
  });

  it.each(PLATFORM_SKILL_NAMES)('%s: fits the provisioning transport', (name) => {
    // The bytes travel as a container environment variable per skill (`workspace/provider.ts`).
    expect(Buffer.byteLength(PLATFORM_SKILLS[name]?.text ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_SKILL_BYTES,
    );
  });

  /**
   * BD-022 and BD-025 are the two rules a skill must carry, and the section is where a reader
   * looks for them. This asserts the **section exists**, not its wording: a test that quoted the
   * sentences would be asserting a string this repository wrote twice (standing rule 3).
   */
  it.each(PLATFORM_SKILL_NAMES)('%s: says what it must never do', (name) => {
    expect(PLATFORM_SKILLS[name]?.text ?? '').toContain('\n## Never\n');
  });

  /**
   * A skill is shipped text, so the usual rule applies: no credential, ever, not even a plausible
   * looking one. The CLI's own docblock says the same about skill files ("Do not store secrets in
   * skill files") because their contents are readable by anything in the workspace.
   */
  it.each(PLATFORM_SKILL_NAMES)('%s: carries no credential-shaped literal', (name) => {
    const text = PLATFORM_SKILLS[name]?.text ?? '';
    for (const shape of [/glpat-[A-Za-z0-9]{20}/, /sk-ant-[A-Za-z0-9]/, /-----BEGIN [A-Z ]*KEY/]) {
      expect(text).not.toMatch(shape);
    }
  });
});

describe('parseSkillFrontmatter', () => {
  it('refuses a file with no frontmatter block', () => {
    expect(() => parseSkillFrontmatter('# kb\n', 'x/SKILL.md')).toThrow(/no YAML frontmatter/);
  });

  it('refuses a frontmatter line that is not `key: value`', () => {
    expect(() => parseSkillFrontmatter('---\nname\n---\n\nbody\n', 'x/SKILL.md')).toThrow(
      /is not 'key: value'/,
    );
  });

  it('refuses a block with no name and one with no description', () => {
    expect(() => parseSkillFrontmatter('---\ndescription: d\n---\n\nb\n', 'x')).toThrow(/'name'/);
    expect(() => parseSkillFrontmatter('---\nname: kb\n---\n\nb\n', 'x')).toThrow(/'description'/);
  });

  it('reads a value containing a colon, because a description usually does', () => {
    const parsed = parseSkillFrontmatter('---\nname: kb\ndescription: a: b\n---\n\nb\n', 'x');
    expect(parsed.description).toBe('a: b');
  });
});
