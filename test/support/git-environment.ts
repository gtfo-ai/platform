/**
 * Drops every inherited `GIT_*` name from the test worker's own environment — the vitest **setup
 * file** of every project (`vitest.config.ts`, WP-162, PROGRESS backlog 499).
 *
 * A test that hands a production module a scratch root in-process (`censusPaths(root)`,
 * `readCommits(range, root)`) cannot hand it an environment, and the module's `git` child inherits
 * this worker's. Run by a linked worktree's `pre-push` hook, that environment carries
 * `GIT_DIR=<common>/.git/worktrees/<name>`, and git honours it before the `cwd` the module passes:
 * the census then lists the shared repository and a fixture's `git commit` writes into it. So the
 * prefix rule of `scripts/git-scratch-env.mjs` is applied here once, before any test file's module
 * graph runs. A read of this checkout is unaffected: git finds it by discovery from the `cwd` it is
 * given, which in a linked worktree is the worktree the hook named. One case it changes: in a
 * `pre-commit` hook git also exports `GIT_INDEX_FILE` (the temporary index of a partial commit), so a
 * read of this checkout would see the real index instead; no pre-commit job runs tests today.
 *
 * A child a test spawns still takes `scratchGitEnv` or `checkoutGitEnv` explicitly
 * (`scripts/git-scratch-env-census.test.ts`), which also adds what this cannot: no global
 * configuration, no hooks, a discovery ceiling, and the `rev-parse` guard.
 */
import process from 'node:process';
import { scrubInheritedGit } from '../../scripts/git-scratch-env.mjs';

scrubInheritedGit(process.env);
