/**
 * Every production source that can put a `wip:` commit on a project's repository — WP-27, counted
 * off disk.
 *
 * product/19:84 is one clause: *"no `wip:` commits except the take-over export"*. Today it holds by
 * **construction** — one function writes a commit message into an export request and it is the
 * take-over's — and nothing said so, which is the shape standing rule **44** is about: a scope claim
 * is a statement about every *other* file, so it cannot be kept true from inside the file that makes
 * it (rule 63). The message's own text is asserted where it is produced
 * (`human-commands.test.ts` › *"pauses the task, interrupts the run and asks its workspace for the
 * export"*, which expects `wip: hand-over to Ada Lovelace`); what that case cannot see is a
 * **second** writer somewhere else, and this is that half.
 *
 * ## Two censuses, because the rule has two ways to break
 *
 * 1. **A `wip:` string anywhere in production.** A second commit path — a librarian commit, a rebase
 *    helper, a fixup the CI gate makes — that spells `wip:` is the literal violation of
 *    product/19:84, whatever type it travels in.
 * 2. **A `commitMessage:` key anywhere in production.** The complementary direction: a second
 *    construction of a {@link WorkspaceExportRequest} or a `RunTakeOverExport` is a second export,
 *    and it is a decision about product/19 §19 even when its message says something else entirely.
 *
 * Both are maps rather than totals, because *where* the hit is is the interesting part: each entry
 * below carries the role its file plays, and a file that is not in the map fails the test until
 * somebody decides which role it has.
 *
 * ## Scope, and what it cannot see
 *
 * git's tree, not a list carried here (standing rule 7): tracked files **and** untracked ones git
 * would let you commit (standing rule 85 — a census that reads only `ls-files` is green on the
 * machine that wrote it and red on the push). Test tiers are excluded on purpose: a test drives the
 * port directly and the contract suite commits `wip: contract suite` by design, which is what a
 * workspace contract *is*. That exclusion is also what keeps this file out of its own census
 * (standing rule 59).
 *
 * It is syntactic, like `task-save-sites.test.ts` and `apps/web/src/no-html.test.ts`, and it lists
 * what it catches rather than claiming closure. It sees a `wip:` that **opens** a string (the
 * character before it is a quote, an apostrophe or a backtick); it does **not** see one assembled
 * (`'wi' + 'p:'`), one reached through a variable, one deeper inside a template
 * (`` `chore: wip: x` ``), or a message a model writes at the end of an agent's own shell — which is
 * BD-025's `PreToolUse(Bash)` policy's business and not this file's.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/**
 * The files allowed to say `wip:` at all, and what each is.
 *
 * `pipeline/commands.ts` is the **writer**: `takeOverTaskCommand` builds the one permitted message,
 * `wip: hand-over to <user>`, and hands it to the stop that releases the workspace. `routes/
 * commands.ts` is the take-over endpoint's own OpenAPI **description**, which quotes that message so
 * an operator reading the schema knows what will land on their branch — prose, not a commit.
 */
const EXPECTED_WIP_SITES: ReadonlyMap<string, number> = new Map([
  ['packages/application/src/pipeline/commands.ts', 1],
  ['apps/server/src/routes/commands.ts', 1],
]);

/**
 * The files that name a `commitMessage` **key**, and what each does with it.
 *
 * Two declarations, one writer, one forwarder. `ports/workspace.ts` is the boundary schema
 * (`workspaceExportRequestSchema`) and `ports/runner.ts` the field on `RunTakeOverExport` that
 * carries it to the process holding the workspace; `pipeline/commands.ts` is the only thing that
 * decides a value; `apps/launcher/src/service.ts` passes the value it was given to
 * `WorkspaceProvider.export` without choosing one. `workspace/provider.ts` is deliberately absent:
 * it *reads* `request.commitMessage` into a `COMMIT_MESSAGE` environment variable for the helper
 * container's `git commit -m "$COMMIT_MESSAGE"`, and reading is not deciding.
 */
const EXPECTED_COMMIT_MESSAGE_SITES: ReadonlyMap<string, number> = new Map([
  ['packages/application/src/ports/workspace.ts', 1],
  ['packages/application/src/ports/runner.ts', 1],
  ['packages/application/src/pipeline/commands.ts', 1],
  ['apps/launcher/src/service.ts', 1],
]);

const gitFiles = (args: readonly string[]): string[] =>
  execFileSync('git', [...args, '-z', '--', '*.ts', '*.tsx'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file.length > 0);

/** Tracked *and* committable-but-untracked, which is the tree the pre-push hook sees (rule 85). */
const sources = (): string[] => [
  ...new Set([
    ...gitFiles(['ls-files']),
    ...gitFiles(['ls-files', '--others', '--exclude-standard']),
  ]),
];

const isTestTier = (file: string): boolean =>
  file.startsWith('test/') ||
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) ||
  /(?:^|\/)(?:testing|fixtures)\.ts$/.test(file) ||
  file.includes('/src/testing/');

/** Crude comment stripping, the same trade `task-save-sites.test.ts` states. */
const withoutComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        return '';
      }
      const comment = line.indexOf('//');
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join('\n');

/**
 * A `wip:` that opens a string literal.
 *
 * The quote is required because `wip:` is also an ordinary object key in this repository —
 * `pipeline/settings.ts` carries BD-010's WIP limits as `wip: WipLimits` — and a guard that fires on
 * legitimate content is a guard somebody switches off (the same reasoning `conflict:check` states
 * about seven `=` characters).
 */
const WIP_LITERAL = /['"`]wip:/gi;

/** A `commitMessage` used as a key: a declaration or a write, never a read. */
const COMMIT_MESSAGE_KEY = /\bcommitMessage\s*:/g;

const census = (pattern: RegExp): Map<string, number> => {
  const found = new Map<string, number>();
  for (const file of sources()) {
    if (isTestTier(file)) {
      continue;
    }
    const body = withoutComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    const hits = body.match(pattern)?.length ?? 0;
    if (hits > 0) {
      found.set(file, hits);
    }
  }
  return found;
};

const asObject = (entries: ReadonlyMap<string, number>): Record<string, number> =>
  Object.fromEntries([...entries].sort());

describe('product/19:84 — the take-over export is the only `wip:` commit (WP-27)', () => {
  it('finds the one writer and the one place that quotes it, and nothing else', () => {
    expect(asObject(census(WIP_LITERAL))).toEqual(asObject(EXPECTED_WIP_SITES));
  });

  it('has one production site that decides a commit message, and it is the take-over', () => {
    expect(asObject(census(COMMIT_MESSAGE_KEY))).toEqual(asObject(EXPECTED_COMMIT_MESSAGE_SITES));
    // Stated as the number the rule rests on, rather than left to be counted off the map: two
    // declarations and a forwarder are not writers, so the writers are the total minus three.
    const sites = [...census(COMMIT_MESSAGE_KEY).values()].reduce((sum, count) => sum + count, 0);
    expect(sites - 3).toBe(1);
  });

  it('reads a tree that includes untracked sources, so a planted writer is seen (rule 85)', () => {
    const all = sources();
    expect(all).toContain('packages/application/src/pipeline/commands.ts');
    expect(all).toContain('packages/application/src/pipeline/wip-commit-sites.test.ts');
  });
});
