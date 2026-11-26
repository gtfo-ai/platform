/**
 * `scripts/main-push-verified.mjs` — whether a push to `main` may skip `ci.yml` and the docker checks
 * because its pull request already ran them on the same commit.
 *
 * The push path cannot run from a pull request, so it is held here twice: the decision, case by case
 * (every rule refused on its own), and the two workflows' wiring as text. A skipped required check
 * reads as a pass, so every case that is not positive proof must say **not verified**.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import { decide, TREE_STEP } from './main-push-verified.mjs';

const SHA = 'a'.repeat(40);
const CI = '.github/workflows/ci.yml';

const greenRun = {
  id: 1,
  event: 'pull_request',
  head_sha: SHA,
  path: CI,
  status: 'completed',
  conclusion: 'success',
};
const pullIntoMain = { number: 7, head: { sha: SHA }, base: { ref: 'main' } };
const proven = {
  event: 'push',
  ref: 'refs/heads/main',
  sha: SHA,
  forced: false,
  after: SHA,
  workflow: CI,
  runs: [greenRun],
  pulls: [pullIntoMain],
  jobs: [{ run_id: 1, steps: [{ name: TREE_STEP, conclusion: 'success' }] }] as unknown[],
};

describe('the decision', () => {
  it('is verified only with a green pull_request run of this workflow and a pull request into main', () => {
    const result = decide(proven);
    expect(result.verified).toBe(true);
    expect(result.reason).toContain('#7');
  });

  it.each([
    ['a pull_request event', { event: 'pull_request' }],
    ['a schedule', { event: 'schedule' }],
    ['another branch', { ref: 'refs/heads/feature' }],
    ['a force push', { forced: true }],
    ['a payload whose after is another commit', { after: 'b'.repeat(40) }],
    ['a sha that is not one', { sha: 'main', after: 'main' }],
    ['no pull request at all', { pulls: [] }],
    [
      'a pull request with another head',
      { pulls: [{ ...pullIntoMain, head: { sha: 'b'.repeat(40) } }] },
    ],
    [
      'a second pull request with this head into another branch',
      { pulls: [pullIntoMain, { number: 8, head: { sha: SHA }, base: { ref: 'release' } }] },
    ],
    ['no run', { runs: [] }],
    [
      'a run still in progress',
      { runs: [{ ...greenRun, status: 'in_progress', conclusion: null }] },
    ],
    ['a failed run', { runs: [{ ...greenRun, conclusion: 'failure' }] }],
    ['a cancelled run', { runs: [{ ...greenRun, conclusion: 'cancelled' }] }],
    ['a skipped run', { runs: [{ ...greenRun, conclusion: 'skipped' }] }],
    [
      'a green run of another workflow',
      { runs: [{ ...greenRun, path: '.github/workflows/image.yml' }] },
    ],
    ['a green run of another commit', { runs: [{ ...greenRun, head_sha: 'b'.repeat(40) }] }],
    ['a green push run, not a pull request run', { runs: [{ ...greenRun, event: 'push' }] }],
    ['garbage from the API', { runs: [null, 3, 'x'], pulls: [null, {}], jobs: [null, 1] }],
    [
      'a newer red run beside an older green one',
      { runs: [greenRun, { ...greenRun, id: 2, run_number: 9, conclusion: 'failure' }] },
    ],
    ['a run that did not record the tree proof', { jobs: [{ run_id: 1, steps: [] }] }],
    [
      'a run whose tree step was skipped (it tested another tree)',
      { jobs: [{ run_id: 1, steps: [{ name: TREE_STEP, conclusion: 'skipped' }] }] },
    ],
    [
      'a tree proof from another run',
      { jobs: [{ run_id: 99, steps: [{ name: TREE_STEP, conclusion: 'success' }] }] },
    ],
    ['no jobs at all', { jobs: [] }],
  ])('is not verified for %s', (_name, change) => {
    expect(decide({ ...proven, ...change } as typeof proven).verified).toBe(false);
  });

  it('decides on the newest run: a green re-run after a cancelled one is verified', () => {
    const runs = [
      { ...greenRun, id: 0, run_number: 3, conclusion: 'cancelled' },
      { ...greenRun, run_number: 4 },
    ];
    expect(decide({ ...proven, runs }).verified).toBe(true);
  });
});

describe('the command', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'main-push-verified-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ['scripts/main-push-verified.mjs', ...args], {
      encoding: 'utf8',
      // Nothing of the runner's own environment: no token, no API URL that could be reached.
      env: { PATH: process.env.PATH, ...env },
    });

  it('runs everything when it cannot ask the API, and says why', () => {
    const event = join(scratch, 'event.json');
    writeFileSync(event, JSON.stringify({ forced: false, after: SHA }));
    const output = join(scratch, 'output');
    writeFileSync(output, '');
    const result = run(['--workflow', CI, '--github-output'], {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: SHA,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: output,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('verified=false\n');
    expect(result.stderr).toContain('no GH_TOKEN or GITHUB_TOKEN');
  });

  it('decides a pull_request event without asking anything', () => {
    writeFileSync(join(scratch, 'event.json'), JSON.stringify({ forced: false, after: SHA }));
    const result = run(['--workflow', CI], {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REF: 'refs/pull/7/merge',
      GITHUB_SHA: SHA,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: join(scratch, 'event.json'),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('verified=false\n');
    expect(result.stderr).toContain('not a push');
  });

  it('runs everything with no event payload', () => {
    const result = run(['--workflow', CI], {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: SHA,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: join(scratch, 'absent.json'),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('verified=false\n');
    expect(result.stderr).toContain('absent.json');
  });

  it('reads a payload with no forced field as a force push, before asking anything', () => {
    const event = join(scratch, 'unforced.json');
    writeFileSync(event, JSON.stringify({ after: SHA }));
    const result = run(['--workflow', CI], {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: SHA,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_PATH: event,
    });
    expect(result.stdout).toBe('verified=false\n');
    expect(result.stderr).toContain('force push');
  });

  it('refuses a missing or foreign --workflow', () => {
    expect(run([], {}).status).toBe(2);
    expect(run(['--workflow', 'ci.yml'], {}).status).toBe(2);
  });
});

describe('the workflows that skip on it', () => {
  const read = (path: string) => readFileSync(path, 'utf8');
  const triggers = (text: string) => /\non:\n((?:[ \t]+.*\n|\n)+)/.exec(text)?.[1] ?? '';

  it('ci.yml has no push trigger of its own and is called by ci-main.yml on push to main', () => {
    const ci = triggers(read(CI));
    expect(ci).toContain('  pull_request:');
    expect(ci).toContain('  workflow_call:');
    expect(ci).not.toMatch(/^\s*push:/m);

    const main = read('.github/workflows/ci-main.yml');
    expect(triggers(main)).toMatch(/^ {2}push:\n {4}branches: \[main\]\n/);
    expect(main).toContain(
      'run: node scripts/main-push-verified.mjs --workflow .github/workflows/ci.yml --github-output',
    );
    // A failed proof job runs everything: the call is not under the default success().
    expect(main).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the Actions expression is the text under test.
      "if: ${{ !cancelled() && needs.verified.outputs.verified != 'true' }}\n",
    );
    expect(main).toMatch(/\n {4}uses: \.\/\.github\/workflows\/ci\.yml(?: #.*)?\n/);
    // The caller's group is not the callee's prefix, or they would wait for each other.
    expect(main).toMatch(/\nconcurrency:\n {2}group: ci-main-/);
  });

  it.each([
    ['ci.yml', CI, 'lint'],
    ['docker-checks.yml', '.github/workflows/docker-checks.yml', 'plan'],
  ])('%s records the tree proof the script requires, in a full-history job', (_name, path, job) => {
    const text = read(path);
    const start = text.indexOf(`\n  ${job}:\n`);
    const rest = text.slice(start + 1);
    const next = /\n {2}[a-z][\w-]*:\n/.exec(rest);
    const body = next === null ? rest : rest.slice(0, next.index);
    expect(start).toBeGreaterThan(-1);
    const step = body.indexOf(`- name: ${TREE_STEP}\n`);
    expect(step, 'the proof step').toBeGreaterThan(-1);
    expect(body.slice(step)).toMatch(
      /^- name: [^\n]+\n {8}if: steps\.tree\.outputs\.same == 'true'\n/,
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell text is the text under test.
    expect(body).toContain('if [ "${tested}" = "${head}" ]; then');
    expect(body.indexOf('fetch-depth: 0')).toBeGreaterThan(-1);
    expect(body.indexOf('fetch-depth: 0')).toBeLessThan(step);
  });

  it('docker-checks.yml plans no check only when its own proof says verified', () => {
    const text = read('.github/workflows/docker-checks.yml');
    expect(text).toContain(
      'run: node scripts/main-push-verified.mjs --workflow .github/workflows/docker-checks.yml --github-output',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the Actions expression is the text under test.
    expect(text).toContain('VERIFIED: ${{ steps.proof.outputs.verified }}');
    expect(text).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the Actions expression is the text under test.
      'if [ "${VERIFIED:-}" = "true" ]; then\n            echo "checks=[]" >> "$GITHUB_OUTPUT"',
    );
    expect(text).toMatch(/- id: proof\n {8}if: github\.event_name == 'push'\n/);
  });
});
