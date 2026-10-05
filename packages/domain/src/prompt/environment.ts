/**
 * What a run's shell can execute — the platform's statement of its own run image (PROGRESS backlog
 * 475, the first local test on Autix, 2026-10-05).
 *
 * The Architect of a PHP project planned `php bin/doctrine migrations:diff` and `composer
 * generate:model` "never by hand" for a workspace that has neither PHP nor Composer, and the
 * Developer then spent 27 turns reverse-engineering the generators before writing the migration by
 * hand and skipping the generated layer — departures it never reported. Nothing in either prompt
 * said what the workspace is. This module says it, in the platform's voice, from facts about the
 * image rather than from a probe at run time.
 *
 * ## Where the facts come from, and what keeps them true
 *
 * {@link RUN_IMAGE_CONTENTS} is a transcription of `docker/base.Dockerfile` (the Node image and its
 * `apt-get install` list) and `docker/runtime.Dockerfile` (the CLIs copied out of the `tools` stage
 * and the one `npm install -g`). `environment.test.ts` reads both files and fails when they and this
 * constant disagree in either direction, and fails when the prompt below stops naming one of them —
 * so a tool added to the image is a red build until somebody decides what the model is told.
 *
 * **What it cannot know, stated:** an operator may run another image
 * (`APP_WORKSPACE_RUNTIME_IMAGE`, read by the launcher, never by the process that plans a run). The
 * prompt says *the shipped image*, and a richer custom image is under-described rather than
 * over-described — the direction that wastes a capability rather than a run.
 *
 * ## Why a closed set of literals
 *
 * For {@link VERIFICATION_PROMPT}'s reason (`assembly.ts`): this text is in layers 1–3, so it is
 * the platform's voice and is digested into `promptVersion`; a type that admits only these two
 * strings is what keeps anything assembled from configuration out of it. The two entries differ
 * only in their second rule, by the project's verification mode.
 */

/** The shipped run image, as its two Dockerfiles build it. Held to them by `environment.test.ts`. */
export const RUN_IMAGE_CONTENTS = {
  /** The image a run container is created from (`docker/runtime.Dockerfile`). */
  image: 'platform-runtime',
  /** The major version of the `node:<major>-…` image `docker/base.Dockerfile` pins by digest. */
  nodeMajor: 24,
  /** `docker/base.Dockerfile`'s `apt-get install` list, in its order. */
  osPackages: ['bash', 'ca-certificates', 'curl', 'git', 'jq', 'openssh-client', 'ripgrep'],
  /** The binaries `docker/runtime.Dockerfile` copies out of its `tools` stage, in its order. */
  clis: ['gh', 'glab', 'logcli', 'sentry-cli', 'jira', 'acli'],
  /** `docker/runtime.Dockerfile`'s `npm install -g` packages. */
  npmGlobals: ['@sentry/mcp-server'],
} as const;

/**
 * Toolchains a project commonly expects that the image does **not** have — named in the prompt
 * because a model told only what *is* there still tries `php` first (measured on Autix: the
 * Developer's first attempts were `php`, `composer` and `vendor/bin/…`).
 */
export const RUN_IMAGE_ABSENT_TOOLCHAINS = [
  'PHP or Composer',
  'Python or pip',
  'a JVM',
  'Ruby',
  'Go',
  'Docker',
  'a database server',
] as const;

const IMAGE_PARAGRAPH = `**Your shell runs in the platform's run container** — the shipped \`platform-runtime\` image — not
on a developer's machine. It has Node.js 24 with \`npm\`, \`bash\` and the coreutils, \`git\`,
\`curl\`, \`jq\`, \`rg\` (ripgrep, from the \`ripgrep\` package), \`ssh\` (from \`openssh-client\`) and
\`ca-certificates\`, and the platform's provider CLIs \`gh\`, \`glab\`, \`logcli\`, \`sentry-cli\`,
\`jira\` and \`acli\` (with the \`@sentry/mcp-server\` package). **Nothing else is installed**: no PHP
or Composer, no Python or pip, no JVM, no Ruby, no Go, no Docker and no database server. Outbound
network reaches only the hosts the operator allowed — the model API, the project's git host and a
package registry only where one was declared — so a command that downloads may be refused.`;

const MISSING_TOOL_RULE = `1. **A missing tool is a fact about this workspace, not about the project.** A command whose
   interpreter is not listed above fails with \`command not found\`. Do not install a runtime, and
   do not reverse-engineer what a missing generator, code generator or build tool would have
   produced by reading its sources — that spends the run on the tool instead of the change.`;

/**
 * The platform's statement of the workspace, by the project's verification mode — `null` for a role
 * with no shell (the planner's `environmentPromptFor`), which runs nothing and would read it as noise.
 */
export const ENVIRONMENT_PROMPT = {
  local: `${IMAGE_PARAGRAPH}

${MISSING_TOOL_RULE}
2. **The project's own checks run here only when their toolchain is listed above.** One whose
   toolchain is not cannot be run in this workspace, by any spelling: say in your artifact which
   command you could not run and why, and leave the verdict to the project's CI pipeline on the
   merge request.`,
  ci: `${IMAGE_PARAGRAPH}

${MISSING_TOOL_RULE}
2. **The project's own toolchain runs in its CI pipeline** (see *Verification*), on the merge
   request. A file the project normally produces with a tool this workspace lacks — a migration
   diff, generated code, a lockfile — is written by hand to match what the tool would have
   produced, said so in your artifact, and judged there.`,
} as const;

/** The platform's workspace statement; see {@link ENVIRONMENT_PROMPT}. */
export type EnvironmentPrompt = (typeof ENVIRONMENT_PROMPT)[keyof typeof ENVIRONMENT_PROMPT];
