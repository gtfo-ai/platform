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
 * From the **platform's own filesystem**: `@platform/prompts` reads `packages/prompts/skills/` at
 * import and the launcher's composition root hands the catalogue to the provider, which writes it
 * into the run's volume through the same kind of helper container that writes the egress
 * configuration. Nothing is bind-mounted from the host into a run container (technical/05), and
 * nothing is baked into `platform-runtime`.
 *
 * Baking them into the run image was the alternative and it was rejected for one measurable reason:
 * the digest the platform records in `runs.prompt_version` (`skillSetVersionOf`) is computed from
 * the bytes **this process** has. If the files came from an image, the audit would describe a
 * version of a file the run never saw whenever the image and the deployment differ by a commit —
 * and the two are separately deployable. Copying from the process that records the digest makes
 * that class of drift impossible rather than unlikely. It also means a skill edit ships without an
 * image rebuild; `platform-launcher` already copies `packages/` wholesale
 * (`docker/launcher.Dockerfile`), so `packages/prompts/skills/` is in it by construction.
 *
 * ## The layout is measured, not assumed
 *
 * `PLATFORM_SKILLS_PLUGIN_DIRECTORY` carries the measurement: `.claude/skills/_platform/<name>/`
 * is not discovered by the pinned CLI, a plugin directory is, and the plugin's skills are named
 * `agentic:<name>`.
 */
import type { WorkspaceSpec } from '@platform/application';
import { PLATFORM_SKILLS_PLUGIN_DIRECTORY, WorkspaceError } from '@platform/application';

/** One shipped skill: the shape `@platform/prompts` produces, named structurally. */
export interface PlatformSkillFile {
  readonly name: string;
  readonly version: string;
  readonly text: string;
}

/**
 * The skills a provider may provision, by name.
 *
 * A construction dependency of both providers, with **no default**: a provider built without one
 * would create workspaces with no skills in them and nothing would say so (standing rules 18, 31,
 * 55). `@platform/prompts` throws at import when the directory is missing, so a deployment that
 * lost the files fails to start rather than running blind.
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
 * Which files a workspace gets for `spec.skills`, in a stable order.
 *
 * A name the catalogue does not have is an **error**, not an omission: the planner and the launcher
 * ship in the same deployment, so a disagreement between them is a bug rather than a configuration,
 * and a workspace silently missing the skill its run was told it had is the kind of green that
 * standing rule 82 is about.
 */
export const workspaceSkillFiles = (
  spec: WorkspaceSpec,
  catalogue: PlatformSkillCatalogue,
): readonly WorkspaceSkillFile[] =>
  [...spec.skills].sort().map((name) => {
    const skill = catalogue[name];
    if (skill === undefined) {
      throw new WorkspaceError(
        'invalid_spec',
        `the workspace spec names the platform skill ${JSON.stringify(name)}, which this deployment does not ship`,
        { runId: spec.runId },
      );
    }
    return {
      path: `${PLATFORM_SKILLS_PLUGIN_DIRECTORY}/skills/${name}/SKILL.md`,
      content: skill.text,
    };
  });
