/**
 * Types for `git-scratch-env.mjs`, which stays plain JavaScript because a spawned `.mjs` script and
 * a test under any ring import it with no TypeScript resolver loaded.
 */
export declare const GIT_ENVIRONMENT_PREFIX: 'GIT_';

export interface ScratchAuthor {
  readonly name: string;
  readonly email: string;
}

export declare const SCRATCH_AUTHOR: ScratchAuthor;

export type Environment = Record<string, string | undefined>;

export interface ScratchGitEnvOptions {
  /** The environment to start from; `process.env` by default. Its `GIT_*` names are dropped. */
  readonly parent?: Environment;
  readonly author?: ScratchAuthor;
  /** `git -c`-shaped entries, passed through `GIT_CONFIG_COUNT` after `core.hooksPath`. */
  readonly config?: Readonly<Record<string, string>>;
  /** Names added last. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface InitScratchRepositoryOptions extends ScratchGitEnvOptions {
  /** Arguments after `git init -q`, such as `['-b', 'main']` or `['--bare']`. */
  readonly initArgs?: readonly string[];
}

export declare function withoutInheritedGit(parent?: Environment): Record<string, string>;

export declare function scrubInheritedGit(env?: Environment): string[];

export declare function scratchGitEnv(
  scratchRoot: string,
  options?: ScratchGitEnvOptions,
): Record<string, string>;

export declare function checkoutGitEnv(parent?: Environment): Record<string, string>;

export declare class ScratchRepositoryEscapeError extends Error {
  readonly scratchRoot: string;
  readonly gitDir: string;
  constructor(scratchRoot: string, gitDir: string);
}

export declare function assertScratchRepository(scratchRoot: string, env?: Environment): void;

export declare function initScratchRepository(
  scratchRoot: string,
  options?: InitScratchRepositoryOptions,
): Record<string, string>;
