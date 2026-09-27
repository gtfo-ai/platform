import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vitestConfig, { PROCESS_SUITES } from '../vitest.config.js';
import { censusFiles } from './census-files.mjs';
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

/**
 * Every vitest project is run by a verification target, and so by a CI job (WP-69, backlog 25's
 * fifth criterion).
 *
 * The chain above holds `verify-targets.ts` to the workflow, and stops at the `package.json` script:
 * nothing compared a script's `--project` flags with the projects `vitest.config.ts` declares. A
 * project nobody names is a suite moved out of `verify` — the WP-06 `ignored:check` shape one level
 * down — and WP-69 is the change that could have produced one, by splitting the real-process
 * suites into a project of their own.
 */
const projectsNamedBy = (script: string): string[] =>
  [...script.matchAll(/--project(?:=|\s+)([\w-]+)/g)].map((match) => match[1] ?? '');

const scriptBodies = (): Readonly<Record<string, string>> =>
  (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

const declaredProjects = (): string[] =>
  (vitestConfig.test?.projects ?? []).map((project) => {
    const name = (project as { test?: { name?: unknown } }).test?.name;
    return typeof name === 'string' ? name : '(unnamed)';
  });

describe('the vitest projects and the verification targets', () => {
  it('reads a project name out of a script, whichever spelling it uses', () => {
    expect(projectsNamedBy('vitest run --project unit --project=contract --coverage')).toEqual([
      'unit',
      'contract',
    ]);
    expect(projectsNamedBy('playwright test')).toEqual([]);
  });

  it('runs every project vitest.config.ts declares from some verification target', () => {
    const bodies = scriptBodies();
    const targeted = new Set(
      Object.values(TARGETS)
        .flat()
        .flatMap((script) => projectsNamedBy(bodies[script] ?? '')),
    );
    const declared = declaredProjects();
    // Not vacuous: the config declares projects, and the targets name some (standing rule 4).
    expect(declared.length).toBeGreaterThan(0);
    expect(targeted.size).toBeGreaterThan(0);
    expect(
      declared.filter((name) => !targeted.has(name)),
      'a vitest project no verification target runs — its suites gate nothing on a push',
    ).toEqual([]);
    expect(
      [...targeted].filter((name) => !declared.includes(name)),
      'a verification target names a vitest project that does not exist',
    ).toEqual([]);
  });

  it('puts the real-process suites in `verify` itself, not in a target of their own', () => {
    const bodies = scriptBodies();
    const inVerify = new Set(
      (TARGETS.verify ?? []).flatMap((script) => projectsNamedBy(bodies[script] ?? '')),
    );
    expect(inVerify.has('process')).toBe(true);
  });
});

/**
 * The `process` project holds exactly the test files that use a structural wait (WP-69).
 *
 * A structural wait takes its deadline from the running test's budget, and that budget is only
 * right in the project whose scheduling it was chosen for. So the membership is read off what the
 * files import rather than kept by hand: a new file that imports `structural-wait.js` and is not in
 * `PROCESS_SUITES` runs in the parallel group — the class this row closed — and fails here instead.
 * What it cannot see (review round 1): a dynamic `import()` of the module, and a test that reaches it
 * through a non-test helper file.
 */
/** An import statement, at the start of a line — so a string that spells one (below) is not one. */
const STRUCTURAL_WAIT_IMPORT =
  /^(?:import\b[^;]*?|\}\s*)from '\.{1,2}\/(?:[\w./-]*\/)?structural-wait\.js'/m;
const TEST_FILE = /\.test\.tsx?$/;

describe('the process project’s membership', () => {
  it('is exactly the test files that import a structural wait, in both directions', () => {
    const importers = censusFiles(repositoryRoot, { include: (path) => TEST_FILE.test(path) })
      .filter((file) => STRUCTURAL_WAIT_IMPORT.test(file.contents))
      .map((file) => file.path)
      .sort();
    expect(importers.length, 'no test file imports structural-wait.js').toBeGreaterThan(0);
    expect(importers).toEqual([...PROCESS_SUITES].sort());
  });

  it('recognises the import spellings a test file uses, and not a mention in prose', () => {
    expect(STRUCTURAL_WAIT_IMPORT.test("import { waitUntil } from './structural-wait.js';")).toBe(
      true,
    );
    expect(STRUCTURAL_WAIT_IMPORT.test("} from '../runlet/structural-wait.js';")).toBe(true);
    expect(STRUCTURAL_WAIT_IMPORT.test('see `structural-wait.ts` for the budget')).toBe(false);
    // …and this file, which spells both imports inside strings, is not one of the importers.
    expect(
      STRUCTURAL_WAIT_IMPORT.test('  expect(test("import { x } from \'./structural-wait.js\'"))'),
    ).toBe(false);
  });
});
