/**
 * The ten platform skills (product/13 § "Skills") — the files, and the eager load that refuses a
 * deployment which is missing one.
 *
 * A skill is a directory with a `SKILL.md` whose YAML frontmatter carries a `name` and a
 * `description`. Claude Code discovers them and shows the model the description; the body is loaded
 * only when the skill is used, which is what makes ten of them cheap.
 *
 * ## What was measured on this tree, because the design rests on it
 *
 * Against `@anthropic-ai/claude-agent-sdk@0.3.267` and the `claude` binary it pins
 * (0.3.267, darwin-arm64), asking the CLI for a `system`/`init` message and reading its `skills`
 * field — the list of what it discovered:
 *
 *  1. **Discovery under `.claude/skills` is one level deep.** A skill at
 *     `.claude/skills/flat-skill/SKILL.md` is discovered; one at
 *     `.claude/skills/_platform/nested-skill/SKILL.md` is **not** — measured twice, with two
 *     different fixtures. technical/04's line *"copy platform skills into the workspace
 *     `.claude/skills/_platform/`"* therefore describes a layout in which nothing would be
 *     discovered, and this repository does not implement it; the amendment is on that page.
 *  2. **The directory name is the identity.** A `SKILL.md` in `dir-name-here/` whose frontmatter
 *     says `name: frontmatter-name` is listed as `dir-name-here`. The SDK's own option docblock
 *     (`sdk.d.ts:2089-2098`) says names match "the SKILL.md `name` / directory name", and the CLI's
 *     error text is blunter: "Skill names match the skill's directory name (or 'plugin:skill' for
 *     plugin-qualified skills)". The two are equal here **and the test below keeps them equal**,
 *     because a file whose frontmatter disagrees with its directory is a file whose name depends on
 *     which of the two a future version reads.
 *  3. **`.claude/skills` of a parent directory is not discovered from a checkout that is a git
 *     root** — the shipped condition, since the workspace's `cwd` is a clone. (Narrowed after the
 *     review re-derived it: the same fixture *is* discovered when the working directory is not a
 *     git repository, so the boundary is the repository, not the directory depth.) Either way the
 *     skills cannot live beside the checkout.
 *  4. **A directory containing `skills/<name>/SKILL.md`, passed as a plugin, is discovered**, and
 *     its skills are namespaced: `agentic:kb`. That is the delivery this platform uses — see
 *     `PLATFORM_SKILLS_PLUGIN_DIRECTORY` in `@platform/application`, which carries the reasoning for
 *     choosing it over writing into the project's own `.claude/skills`.
 *
 * ## Why these are files rather than prompt text
 *
 * Same reason as `roles/<role>/prompt.md`: a project may ship its own, a human diffs them, and the
 * body is loaded by the CLI on use rather than by the platform on every run. The platform's copy is
 * *provisioned into the workspace* (WP-14a) — it is never bind-mounted from the host (technical/05)
 * and never baked into the run image, so the bytes a run sees come from the same commit as the code
 * that recorded their digest in the audit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The shipped version per skill, declared here rather than in the file's frontmatter.
 *
 * Identical reasoning to {@link ROLE_PROMPT_VERSIONS}: a project may replace a skill file, and a
 * replaced file carrying the platform's version number would claim to be a platform skill. The
 * declared number is what a human and a changelog read; what catches an edit that forgot to bump is
 * the digest `skillSetVersionOf` (in `@platform/domain`) folds into `runs.prompt_version`.
 */
export const PLATFORM_SKILL_VERSIONS = {
  'ask-human': '1',
  'file-followup-ticket': '1',
  'gitlab-mr': '1',
  'jira-ticket': '1',
  kb: '1',
  'loki-logs': '1',
  'mr-description': '1',
  retro: '1',
  'sentry-issue': '1',
  'verify-work': '1',
} as const;

export type PlatformSkillName = keyof typeof PLATFORM_SKILL_VERSIONS;

export interface PlatformSkill {
  readonly name: string;
  readonly version: string;
  /** The frontmatter's one-line `description`: the only part the model sees before it uses it. */
  readonly description: string;
  /** The whole file, byte-identical — frontmatter included, because the CLI parses it again. */
  readonly text: string;
}

/**
 * The biggest a `SKILL.md` may be.
 *
 * 16 KiB, against a measured corpus whose largest file is 2 588 bytes: six times the largest thing
 * shipped, and two orders of magnitude under the 1 MB at which the CLI skips a skill outright. The
 * cap is here rather than nowhere because the provisioning transport is a **container environment
 * variable per skill** (`provider.ts` § `#skills`), and an unbounded file would move a failure that
 * belongs in this repository's test run into a `docker create` on a customer's machine.
 */
export const MAX_SKILL_BYTES = 16_384;

const skillsRoot = new URL('../skills/', import.meta.url);

/** Where a skill lives on disk — also what a provider registration's `skill.path` must resolve to. */
export const platformSkillPath = (name: string): string =>
  fileURLToPath(new URL(`${name}/SKILL.md`, skillsRoot));

/** `packages/prompts/skills/<name>`: the repository-relative form provider registrations declare. */
export const platformSkillRepoPath = (name: string): string => `packages/prompts/skills/${name}`;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * Reads `name` and `description` out of the frontmatter, and refuses everything else.
 *
 * Deliberately not a YAML parser: this repository has none in its dependency tree, the two fields
 * are both plain scalars, and a parser that accepted anchors and multi-line blocks would accept
 * shapes the *CLI's* parser might read differently. Anything it cannot read is an error at import
 * — these are the platform's own files, so a malformed one is a build defect, not an input.
 */
export const parseSkillFrontmatter = (
  text: string,
  where: string,
): { readonly name: string; readonly description: string } => {
  const match = FRONTMATTER.exec(text);
  if (match === null) {
    throw new Error(`${where}: no YAML frontmatter block (a SKILL.md starts with '---')`);
  }
  const fields = new Map<string, string>();
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) {
      throw new Error(`${where}: frontmatter line ${JSON.stringify(line)} is not 'key: value'`);
    }
    fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (name === undefined || name.length === 0) {
    throw new Error(`${where}: frontmatter has no 'name'`);
  }
  if (description === undefined || description.length === 0) {
    throw new Error(`${where}: frontmatter has no 'description'`);
  }
  return { name, description };
};

/**
 * The skill directories on disk, sorted.
 *
 * Read rather than listed (standing rule 7): the census below compares this against the declared
 * versions in **both** directions, so a skill added without a version — and a version declared for
 * a skill nobody wrote — are each a startup failure rather than a silent omission.
 */
export const platformSkillDirectories = (): readonly string[] => {
  let entries: readonly string[];
  try {
    entries = readdirSync(fileURLToPath(skillsRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    // Rules 18/31/55: an absent directory is a refusal, never an empty list that reads as "this
    // deployment ships no skills".
    throw new Error(
      `${fileURLToPath(skillsRoot)} cannot be read, so this deployment has no platform skills at all`,
      { cause },
    );
  }
  if (entries.length === 0) {
    throw new Error(`${fileURLToPath(skillsRoot)} is empty; the platform ships ten skills`);
  }
  return entries;
};

const load = (name: string): PlatformSkill => {
  const file = platformSkillPath(name);
  const size = statSync(file).size;
  if (size > MAX_SKILL_BYTES) {
    throw new Error(`${file} is ${String(size)} bytes; the cap is ${String(MAX_SKILL_BYTES)}`);
  }
  const text = readFileSync(file, 'utf8');
  const frontmatter = parseSkillFrontmatter(text, file);
  if (frontmatter.name !== name) {
    throw new Error(
      `${file} declares name ${JSON.stringify(frontmatter.name)} in a directory called ` +
        `${JSON.stringify(name)}; the CLI takes the directory name, so the two must agree`,
    );
  }
  const version = (PLATFORM_SKILL_VERSIONS as Record<string, string | undefined>)[name];
  if (version === undefined) {
    throw new Error(`${file} exists but no version is declared for it in PLATFORM_SKILL_VERSIONS`);
  }
  return { name, version, description: frontmatter.description, text };
};

/**
 * Every platform skill, read once at import — the same eager shape as {@link ROLE_PROMPTS} and for
 * the same reason: a skill that is missing for one run is missing for the deployment, and the
 * process that provisions workspaces should fail to start rather than hand out a workspace with a
 * hole in it.
 */
export const PLATFORM_SKILLS: Readonly<Record<string, PlatformSkill>> = (() => {
  const directories = platformSkillDirectories();
  const declared = Object.keys(PLATFORM_SKILL_VERSIONS).sort();
  const missing = declared.filter((name) => !directories.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `PLATFORM_SKILL_VERSIONS declares skills with no directory: ${missing.join(', ')}`,
    );
  }
  return Object.freeze(Object.fromEntries(directories.map((name) => [name, load(name)] as const)));
})();

/** The ten names, sorted — read off disk, so a new skill joins it by existing. */
export const PLATFORM_SKILL_NAMES: readonly string[] = Object.keys(PLATFORM_SKILLS);
