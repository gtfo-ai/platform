import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TARGETS, VERIFY_GROUPS } from './verify-targets.js';

/**
 * CI runs everything `verify` runs.
 *
 * This exists because the two had drifted and nothing noticed: `ignored:check` was a step of
 * `verify` from WP-06 onward and a step of **no CI job at all**, so the guard that caught
 * `apps/server/src/data/` being swallowed by an unanchored `.gitignore` rule — and later the walk
 * into a nested checkout — was enforced only on the machine of whoever happened to run `verify`.
 *
 * The structural half of the fix is in `verify-targets.ts`: `verify` has no list of its own, it is
 * the concatenation of the groups, and each group is one job's one command, so a *step* cannot be
 * in one and not the other. This test closes what that cannot see — a group or a target that no
 * job invokes — and it is not a third list: it reads the table and the workflow file, the two
 * artefacts that actually decide, and compares them.
 *
 * **Why it cannot pass for the wrong reason.** A regex that matched nothing would satisfy every
 * "is contained in" assertion at once, so the workflow parse is asserted first: the commands it
 * found are non-empty *and* every one of them is a real `package.json` script. A typo in either
 * file therefore fails here rather than silently emptying the corpus (standing rule 4).
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (path: string): string => readFileSync(join(repositoryRoot, path), 'utf8');

/**
 * The shell text of every `run:` step in the workflow — inline (`run: cmd`) and block scalar
 * (`run: |` followed by an indented body), minus the shell comments inside a block.
 *
 * Scanned line by line rather than parsed as YAML: the property under test is "this command is a
 * step the workflow executes", which is a statement about `run:` positions, and a YAML dependency
 * would not make the answer more true.
 *
 * **Position matters, and a first attempt got it wrong.** Matching `pnpm run -s (\S+)` anywhere in
 * the file counted the mention of `pnpm run -s verify` in this workflow's own *comment* as a
 * command CI runs — which made `verify` expand to all of its steps and every containment assertion
 * below true for free. That mutation is now pinned by a test of its own, because a guard that
 * accepts prose about itself as evidence is the vacuous pass of standing rule 4.
 */
const runSteps = (workflow: string): string[] => {
  const steps: string[] = [];
  let blockIndent: number | null = null;
  for (const line of workflow.split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (line.trim() === '' || indent > blockIndent) {
        if (!line.trimStart().startsWith('#')) {
          steps.push(line);
        }
        continue;
      }
      blockIndent = null;
    }
    const run = /^\s*(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (run === null) {
      continue;
    }
    const rest = (run[1] ?? '').trim();
    if (rest.startsWith('|') || rest.startsWith('>')) {
      blockIndent = indent;
      continue;
    }
    steps.push(rest);
  }
  return steps;
};

/** Every `pnpm run -s <script>` a workflow executes. */
const commandsIn = (workflow: string): string[] =>
  runSteps(workflow).flatMap((step) =>
    [...step.matchAll(/pnpm run -s ([\w:.-]+)/g)].map((match) => match[1] ?? ''),
  );

const workflowCommands = (): string[] => commandsIn(read('.github/workflows/ci.yml'));

/** A CI command that is itself a verify target stands for the steps that target runs. */
const expand = (command: string): readonly string[] => TARGETS[command] ?? [command];

const packageScripts = (): ReadonlySet<string> => {
  const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  return new Set(Object.keys(manifest.scripts));
};

describe('the verification targets and .github/workflows/ci.yml', () => {
  it('name only scripts that exist, so neither corpus can be empty for a typo', () => {
    const scripts = packageScripts();
    const commands = workflowCommands();

    expect(
      commands.length,
      'no `pnpm run -s …` command was found in the workflow at all',
    ).toBeGreaterThan(0);
    expect(
      commands.filter((command) => !scripts.has(command)),
      'the workflow runs a pnpm script that package.json does not define',
    ).toEqual([]);
    expect(
      Object.values(TARGETS)
        .flat()
        .filter((step) => !scripts.has(step)),
      'a verify target runs a pnpm script that package.json does not define',
    ).toEqual([]);
    expect(
      Object.keys(TARGETS).filter((target) => !scripts.has(target)),
      'a verify target has no package.json script, so nobody can run it',
    ).toEqual([]);
  });

  it('counts a command only where the workflow runs it, never where it talks about it', () => {
    const synthetic = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      # this job used to run pnpm run -s ghost',
      '      - run: pnpm run -s alpha',
      '      - name: a block scalar',
      '        run: |',
      '          pnpm run -s beta',
      '          # pnpm run -s ghost',
      '      - run: pnpm run -s gamma',
      '',
    ].join('\n');

    expect(commandsIn(synthetic)).toEqual(['alpha', 'beta', 'gamma']);

    // And on the real file: it does contain a comment naming a pnpm command (this assertion is
    // what stops the next one passing on a workflow where no such prose exists), and `verify`
    // itself is run by no job — CI runs its groups — so seeing it means prose was counted.
    const comments = read('.github/workflows/ci.yml')
      .split('\n')
      .filter((line) => line.trimStart().startsWith('#') && line.includes('pnpm run -s'));
    expect(
      comments.length,
      'no comment in ci.yml names a pnpm command, so the assertion below proves nothing',
    ).toBeGreaterThan(0);
    expect(workflowCommands()).not.toContain('verify');
  });

  it('runs every step of `verify` in some CI job', () => {
    const inCi = new Set(workflowCommands().flatMap(expand));

    expect(
      (TARGETS.verify ?? []).filter((step) => !inCi.has(step)),
      'these steps gate a local `verify` and nothing on a push — the WP-06 `ignored:check` defect',
    ).toEqual([]);
  });

  it('runs every group and every other target as a CI job of its own', () => {
    const commands = new Set(workflowCommands());

    expect(
      Object.keys(VERIFY_GROUPS).filter((group) => !commands.has(group)),
      'a group of `verify` is run by no CI job, so its steps are enforced only locally',
    ).toEqual([]);
    expect(
      // `verify` itself is the composition, not a job: CI runs its groups as separate jobs.
      Object.keys(TARGETS).filter((target) => target !== 'verify' && !commands.has(target)),
      'a verification target is run by no CI job',
    ).toEqual([]);
  });
});
