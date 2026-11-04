/**
 * Provisioning the platform's skills into a workspace — WP-14a.
 *
 * The one function both implementations of `WorkspaceProvider` use to decide **what files** a
 * workspace gets, so that the fake cannot be kinder than the Docker provider about the contents
 * (standing rule 1). Docker turns the list into a helper container's script; the fake writes it
 * into its in-memory tree.
 *
 * ## Where the bytes come from, and why not from the run image
 *
 * From the **core's own filesystem**: `@platform/prompts` reads `packages/prompts/skills/` at
 * import, the process that plans the run builds the skills' content with {@link runSkillsFor} — the
 * server's launcher provisioner, or the core's run package for a remote worker — and the create
 * request carries it (TD-031 decision 4, WP-279). The launcher writes **exactly what it is given**
 * into the run's volume through the same kind of helper container that writes the egress
 * configuration, after recomputing the set's digest ({@link workspaceSkillFiles}). Until WP-279 the
 * launcher read its own `@platform/prompts` copy; that copy is retired, because a worker's launcher
 * may be a build behind the core whose planner recorded the digest. Nothing is bind-mounted from the
 * host into a run container (technical/05), and nothing is baked into `platform-runtime`.
 *
 * Baking them into the run image was the alternative and it was rejected for one measurable reason:
 * the digest the platform records in `runs.prompt_version` (`skillSetVersionOf`) is computed from
 * the bytes **the core** has. If the files came from an image, the audit would describe a version of
 * a file the run never saw whenever the image and the deployment differ by a commit — and the two
 * are separately deployable. Carrying them from the process that records the digest, and checking
 * the digest where they are written, makes that class of drift impossible rather than unlikely.
 *
 * ## The layout is measured, not assumed
 *
 * `PLATFORM_SKILLS_PLUGIN_DIRECTORY` carries the measurement: `.claude/skills/_platform/<name>/`
 * is not discovered by the pinned CLI, a plugin directory is, and the plugin's skills are named
 * `agentic:<name>`.
 */
import type { RunSkills, WorkspaceSpec } from '@platform/application';
import { PLATFORM_SKILLS_PLUGIN_DIRECTORY, WorkspaceError } from '@platform/application';
import { runSkillsIssues, SKILL_FILE } from '@platform/contracts';
import { skillSetVersionOf } from '@platform/domain';

/** One shipped skill: the shape `@platform/prompts` produces, named structurally. */
export interface PlatformSkillFile {
  readonly name: string;
  readonly version: string;
  readonly text: string;
}

/**
 * The skills the **core** ships, by name — what {@link runSkillsFor} reads. The server's
 * composition passes `PLATFORM_SKILLS` (`@platform/prompts`); no provider holds one since WP-279.
 */
export type PlatformSkillCatalogue = Readonly<Record<string, PlatformSkillFile>>;

/** A file to write into the workspace, at a path relative to the checkout. */
export interface WorkspaceSkillFile {
  /** Relative to the checkout (`/work/repo`), always under the plugin directory. */
  readonly path: string;
  readonly content: string;
}

/**
 * The git exclude entry that keeps the platform's directory out of the project's commits.
 *
 * `.git/info/exclude` rather than `.gitignore`: the first is local to this clone and can never be
 * committed, the second is a file of the project's that the platform would be editing. The entry is
 * anchored with a leading `/` so it matches the platform's directory at the checkout root and not a
 * directory of the same name anywhere in the tree (the repository's own `.gitignore` rule, applied
 * to somebody else's repository).
 *
 * It matters because the Developer role commits and pushes: an unignored `.agentic-run/` is swept
 * up by `git add -A` and arrives in the merge request as ten files nobody asked for.
 */
export const WORKSPACE_GIT_EXCLUDE_ENTRY = '/.agentic-run/';

/**
 * The content of the skills `names` — each one's `SKILL.md` and declared version, and the set's
 * digest exactly as the planner folds it into `runs.prompt_version` (`skillSetVersionOf`) — for a
 * create request or a run package (TD-031 decision 4, WP-279).
 *
 * A name the catalogue does not have is an **error**, not an omission: the planner and this
 * function read the same `@platform/prompts` in the same process, so a disagreement is a bug, and a
 * workspace silently missing the skill its run was told it had is the green standing rule 82 is
 * about.
 */
export const runSkillsFor = (
  runId: string,
  names: readonly string[],
  catalogue: PlatformSkillCatalogue,
): RunSkills => {
  const skills = [...new Set(names)].sort().map((name) => {
    const skill = catalogue[name];
    if (skill === undefined) {
      throw new WorkspaceError(
        'invalid_spec',
        `the workspace spec names the platform skill ${JSON.stringify(name)}, which this deployment does not ship`,
        { runId, reason: 'skill_set_invalid' },
      );
    }
    return skill;
  });
  return {
    digest: skillSetVersionOf(skills),
    files: Object.fromEntries(skills.map((skill) => [skill.name, { [SKILL_FILE]: skill.text }])),
    versions: Object.fromEntries(skills.map((skill) => [skill.name, skill.version])),
  };
};

/**
 * Which files a workspace gets for `spec.skills`, in a stable order — from the skills the **request**
 * carried, after checking them (WP-279): exactly the spec's names, each one's `SKILL.md` and nothing
 * else, and a digest equal to the one their names, versions and bytes give. Anything else is
 * `invalid_spec` (`skill_set_invalid`) naming what disagreed — both providers call this, so the fake
 * is never kinder than Docker (standing rule 1).
 *
 * Recomputing is the point: the digest is what `runs.prompt_version` records, so a launcher that
 * wrote bytes whose digest it did not check could provision a run the audit describes wrongly.
 */
export const workspaceSkillFiles = (
  spec: WorkspaceSpec,
  skills: RunSkills,
): readonly WorkspaceSkillFile[] => {
  const refuse = (message: string, detail?: string): never => {
    throw new WorkspaceError('invalid_spec', message, {
      runId: spec.runId,
      reason: 'skill_set_invalid',
      ...(detail === undefined ? {} : { detail }),
    });
  };
  const issues = runSkillsIssues(skills, spec.skills);
  if (issues.length > 0) {
    refuse(`the skills the create request carried do not fit its spec: ${issues.join('; ')}`);
  }
  const definitions = [...spec.skills].sort().map((name) => ({
    name,
    version: skills.versions[name] as string,
    text: skills.files[name]?.[SKILL_FILE] as string,
  }));
  const digest = skillSetVersionOf(definitions);
  if (digest !== skills.digest) {
    refuse(
      `the skills the create request carried digest to ${digest}, and the request says ${skills.digest}: they are not the bytes the run was planned with (TD-031 decision 4)`,
    );
  }
  return definitions.map((skill) => ({
    path: `${PLATFORM_SKILLS_PLUGIN_DIRECTORY}/skills/${skill.name}/${SKILL_FILE}`,
    content: skill.text,
  }));
};
