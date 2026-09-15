import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MVP_EXIT_CRITERIA } from './changelog.mjs';

/**
 * The release mechanism, asserted against the files that decide it (WP-42, TD-019, technical/11).
 *
 * `scripts/verify.test.ts` holds `verify` to `ci.yml`; this is the same job for `release.yml`, and
 * it exists because **nothing here has ever run**. GitHub Actions cannot be executed from a
 * checkout, so the alternative to these assertions is a workflow whose first execution is also its
 * first test — on the push that cuts a release (standing rule 71). What can be checked offline is
 * every property that is a statement about the *files*: the trigger, the pins, the handshake with
 * `image.yml`, and that the eleven version strings the release moves are all the same string.
 *
 * One part of that workflow *is* executable, and is executed: the shell of the two steps that find
 * and watch the image build runs here against a stub `gh` (`the shell that finds and watches the
 * image build`, below), because that shell is where watching the wrong run turns a release green
 * without its images.
 *
 * What it cannot check is stated here rather than implied: whether release-please's own run
 * produces the version this configuration asks for, whether the identity its commits carry is the
 * one `signoff` names, whether a tag created with an administrator's token really does start
 * `image.yml` (GitHub's documentation says it does; nobody here has seen it), whether such a run
 * reports the tag as its `head_branch` — the scenarios below assume it, because `gh run list`
 * prints it that way, and a release where it is false fails loudly rather than watching the wrong
 * run — and whether a dispatch started from a release run reaches it. Each of those was read out of a pinned source —
 * the action at `45996ed`, release-please 17.6.0, and GitHub's own documentation on `GITHUB_TOKEN`
 * and workflow triggering — and the citations are in `.github/workflows/release.yml`'s header,
 * where the next person to change it will read them.
 *
 * **Why it cannot pass for the wrong reason.** Every corpus it builds is asserted non-empty first:
 * a regex that matched nothing would otherwise satisfy every "each of these is pinned" assertion
 * at once (standing rule 4), which is the failure mode `verify.test.ts` records having shipped.
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (path: string): string => readFileSync(join(repositoryRoot, path), 'utf8');

const readJson = <T>(path: string): T => JSON.parse(read(path)) as T;

/** What git tracks, so no list here has to be maintained by hand (standing rule 7). */
const tracked = (pattern: string): string[] =>
  execFileSync('git', ['ls-files', pattern], { cwd: repositoryRoot, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '');

const RELEASE_WORKFLOW = '.github/workflows/release.yml';
const IMAGE_WORKFLOW = '.github/workflows/image.yml';
const CI_WORKFLOW = '.github/workflows/ci.yml';
const CONFIG = 'release-please-config.json';
const MANIFEST = '.release-please-manifest.json';

interface ReleasePleaseConfig {
  readonly 'initial-version': string;
  readonly 'include-component-in-tag': boolean;
  readonly signoff: string;
  readonly packages: Record<string, { readonly 'extra-files'?: { readonly path: string }[] }>;
}

describe('.github/workflows/release.yml', () => {
  const workflow = read(RELEASE_WORKFLOW);

  it('is triggered by a push to main and by nothing else (technical/11 § Workflows)', () => {
    const triggers = (/\non:\n((?:[ \t]+.*\n|\n)+)/.exec(workflow)?.[1] ?? '').trim();
    expect(triggers).not.toBe('');
    expect(triggers).toBe('push:\n    branches: [main]');
  });

  it('runs release-please v5 against the config and manifest that exist', () => {
    const action = /uses: googleapis\/release-please-action@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)/.exec(
      workflow,
    );
    expect(action).not.toBeNull();
    expect(action?.[2]?.startsWith('v5.')).toBe(true);

    expect(workflow).toContain(`config-file: ${CONFIG}`);
    expect(workflow).toContain(`manifest-file: ${MANIFEST}`);
    expect(existsSync(join(repositoryRoot, CONFIG))).toBe(true);
    expect(existsSync(join(repositoryRoot, MANIFEST))).toBe(true);
  });

  /**
   * An **equality**, not a containment: the point of this assertion is the "and no more" half, and
   * `arrayContaining` plus "every entry ends in `: write`" admitted any further write scope that
   * happened to be added — `packages: write` would have passed both. The four below are each
   * justified at the line in the workflow, and a fifth is a decision somebody makes here.
   *
   * **`checks: read` was one of them and is not any more.** `gh run watch` does make a read that
   * needs it — a job's annotations — but it **tolerates being refused**: cli/cli's
   * `pkg/cmd/run/watch/watch.go` (trunk, read 2026-09-15) matches that one error by name,
   * `err != shared.ErrMissingAnnotationsPermissions`, and prints that the token lacks `checks:read`
   * rather than failing the command. gh's manual note about that permission is about *fine-grained
   * PATs*, which `GITHUB_TOKEN` is not. So the scope bought log detail, not the verdict, and the
   * verdict is what the step exists for.
   */
  it('holds the permissions each of its effects needs, and no more', () => {
    const job = workflow.slice(workflow.indexOf('  release-please:'));
    const permissions = /permissions:\n((?: {6}(?:#.*|[a-z-]+: \w+)\n)+)/.exec(job)?.[1] ?? '';
    const granted = [...permissions.matchAll(/^ {6}([a-z-]+): (\w+)$/gm)].map(
      (match) => `${match[1]}: ${match[2]}`,
    );
    expect([...granted].sort()).toEqual([
      // `gh workflow run`, and the `gh run list`/`gh run watch` that find and follow the image
      // build — without them the tag would publish no image, silently. The reads come with it.
      'actions: write',
      'contents: write',
      'issues: write',
      'pull-requests: write',
    ]);
  });

  /**
   * The release pull request's own CI, which is a property of *which token opens it*.
   *
   * A pull request opened with `GITHUB_TOKEN` starts no workflow run, so `ci.yml`'s `pull_request`
   * jobs — `dco` among them — never report on the release PR, and the required checks an
   * administrator applies then make it unmergeable. The out is a token the repository does not
   * carry; what is asserted here is that the workflow *takes* one, that it falls back, and that the
   * cost of the fallback is written down where the person merging the first release will read it
   * (Q90). The value of that secret is nowhere in this repository and never will be (BD-002).
   */
  it('takes an administrator’s token, falls back, and states what the fallback costs', () => {
    expect(workflow).toContain(
      'token: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
    );

    const header = workflow.slice(0, workflow.indexOf('\non:\n'));
    expect(header).not.toBe('');
    expect(header).toContain(
      '**The release PR gets no CI run unless an administrator provides a token.**',
    );
    // The three ways a PR with no run of its own can still be merged, and the one that makes the
    // `dco` verdict reachable at all.
    expect(header).toContain('close and reopen');
    expect(header).toContain('merge_group');
    expect(header).toContain('Q90');

    // Both ends (standing rule 42): a secret nobody is told to create is a secret nobody creates.
    for (const path of ['CONTRIBUTING.md', 'docs/TODO.md']) {
      expect(read(path)).toContain('RELEASE_PLEASE_TOKEN');
    }
  });

  /**
   * The handshake criterion 1 is really about, asserted from **both** ends (standing rule 42) —
   * and now from both *paths*, because there are two and the earlier version of this file believed
   * in one.
   *
   * Which route the tag takes to `image.yml` is a property of the token that created it. With
   * `RELEASE_PLEASE_TOKEN` set the tag is an ordinary push, so `image.yml`'s `push: tags: ['v*']`
   * starts the build by itself and a dispatch would start a **second** run on the same ref —
   * `image.yml`'s concurrency queues rather than cancels, so that run rebuilds five images on two
   * architectures, republishes identical tags, and is waited for under the same `timeout-minutes`.
   * On the `GITHUB_TOKEN` fallback the tag starts nothing and the dispatch, the documented
   * exception, is the only way in. Both are stated here; *which one runs* is executed against a
   * stub `gh` in the describe below.
   */
  it('reaches image.yml by the one route the tag’s own token leaves open', () => {
    // The branch is decided by the same expression the token itself is chosen by, so the two
    // halves cannot come to disagree about which path a release took.
    expect(workflow).toContain("TAG_STARTED_A_RUN: ${{ secrets.RELEASE_PLEASE_TOKEN != '' }}");
    expect(workflow).toContain(
      'token: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}',
    );
    expect(workflow).toMatch(/gh workflow run image\.yml --ref "\$TAG"/);
    expect(workflow).toContain('TAG: ${{ steps.release.outputs.tag_name }}');

    const header = workflow.slice(0, workflow.indexOf('\non:\n'));
    expect(header).toContain(
      '**How the tag reaches `image.yml` depends on which token created it, and both paths are built.**',
    );

    // `gh workflow run` returns when the dispatch is *accepted*, so dispatching and stopping there
    // would make this job green for a release whose images never built. Either path ends in the
    // watch, and the run it watches has to be the one this release started: the baseline that
    // answers "was this run already here?" is therefore taken **before** release-please can create
    // anything, which is the only moment at which that question has an answer.
    expect(workflow).toContain('gh run watch "$run_id" --exit-status');
    expect(workflow.indexOf('id: image-runs-before')).toBeLessThan(workflow.indexOf('id: release'));
    expect(workflow).toContain('RUNS_BEFORE: ${{ steps.image-runs-before.outputs.runs }}');

    const image = read(IMAGE_WORKFLOW);
    expect(image).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(image).toMatch(/^ {4}tags: \['v\*'\]$/m);
    expect(image).toContain('"${GITHUB_REF_TYPE}" = "tag"');
    expect(image).toContain('version="${GITHUB_REF_NAME#v}"');
    // The tag scheme lives there and is not copied into the release workflow.
    expect(workflow).not.toContain('imagetools');
  });

  it('acts on a release only when one was created', () => {
    // A step writes `if:` either as its first key (`- if: …`) or under its name; both are here.
    const conditionals = [...workflow.matchAll(/^\s+(?:- )?if: (.+)$/gm)].map((match) => match[1]);
    expect(conditionals.length).toBeGreaterThan(0);
    for (const condition of conditionals) {
      expect(condition).toBe("${{ steps.release.outputs.release_created == 'true' }}");
    }
    // The two effects that must not happen on an ordinary push to main.
    expect(conditionals.length).toBeGreaterThanOrEqual(3);
  });

  it('gives the upgrade note the history it is derived from', () => {
    // `git describe` cannot find the previous release tag in a shallow clone, and the note would
    // then claim every migration is new on every release.
    expect(workflow).toMatch(/fetch-depth: 0/);
    expect(workflow).toContain('node scripts/changelog.mjs --upgrade-note');
  });
});

/**
 * The one part of `release.yml` that can be run from a checkout: the shell of the two steps that
 * decide **which** `image.yml` run a release watches, executed against a stub `gh`
 * (`scripts/fixtures/gh-stub.sh`) and a `sleep` that returns at once.
 *
 * It is worth the harness because the failure it guards against is silent. `gh run watch` on the
 * wrong run reports *that* run's verdict: a release whose images never built goes green, which is
 * the exact outcome the watch was added to prevent. The wrong run is not hypothetical — a manual
 * `workflow_dispatch` or a re-run at the same commit leaves one, and on the administrator-token
 * path the `push: main` build of the very commit being released is always there.
 *
 * What the stub does **not** do is evaluate the `--jq` expression (there is no jq here); it prints
 * the fields `--json` names, tab-separated, which is what `… | @tsv` produces. That is why the
 * workflow keeps its jq to a bare projection and does the selecting in shell — the part that can
 * be run is the part that decides.
 */
describe('the shell that finds and watches the image build', () => {
  const releaseWorkflow = read(RELEASE_WORKFLOW);
  const BASELINE_STEP = 'which image.yml runs already exist for this commit';
  const IMAGE_STEP = 'build and publish the images for the tag';
  const HEAD_SHA = '1b0c5f9a2d3e4f5061728394a5b6c7d8e9f01234';
  const TAG = 'v0.1.0';

  /** A run as `gh run list` would report it, plus the first poll on which it becomes visible. */
  interface StubRun {
    readonly id: number;
    readonly branch: string;
    readonly event: 'push' | 'workflow_dispatch';
    readonly sha?: string;
    /** 1 — already there; n — appears on the nth `gh run list` of the step (a late run). */
    readonly fromCall?: number;
  }

  interface Outcome {
    readonly status: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly calls: readonly string[];
    readonly runsBefore: string;
  }

  /** The `run:` body of a named step, dedented — the file is the only copy of it (rule 7). */
  const runScript = (stepName: string): string => {
    const step = releaseWorkflow.slice(releaseWorkflow.indexOf(`name: ${stepName}`));
    const body = /\n {8}run: \|\n((?: {10}.*\n|[ \t]*\n)+)/.exec(step)?.[1] ?? '';
    // Without this an extraction that stopped matching would "pass" every case below at once.
    expect(body).not.toBe('');
    return body.replace(/^ {10}/gm, '');
  };

  const scenarioFile = (runs: readonly StubRun[]): string =>
    runs
      .map((run) =>
        [run.id, run.sha ?? HEAD_SHA, run.branch, run.event, run.fromCall ?? 1].join('\t'),
      )
      .join('\n')
      .concat('\n');

  /**
   * Runs the baseline step against `before`, then the image step against `after`, exactly as the
   * job does: the baseline's output is the image step's `RUNS_BEFORE`.
   */
  const drive = (scenario: {
    readonly before: readonly StubRun[];
    readonly after: readonly StubRun[];
    readonly administratorToken: boolean;
    readonly watchExit?: number;
  }): Outcome => {
    const directory = mkdtempSync(join(tmpdir(), 'release-yml-'));
    try {
      copyFileSync(join(repositoryRoot, 'scripts/fixtures/gh-stub.sh'), join(directory, 'gh'));
      chmodSync(join(directory, 'gh'), 0o755);
      writeFileSync(join(directory, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(directory, 'before.tsv'), scenarioFile(scenario.before));
      writeFileSync(join(directory, 'after.tsv'), scenarioFile(scenario.after));
      writeFileSync(join(directory, 'gh.log'), '');
      writeFileSync(join(directory, 'outputs'), '');

      const environment = {
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        HOME: directory,
        GH_TOKEN: 'not-a-real-token',
        GITHUB_SHA: HEAD_SHA,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'gtfo-ai/platform',
        GITHUB_OUTPUT: join(directory, 'outputs'),
        STUB_LOG: join(directory, 'gh.log'),
        STUB_DIR: directory,
        TAG,
      };
      const run = (script: string, extra: Record<string, string>) =>
        spawnSync('bash', ['-c', script], {
          cwd: directory,
          encoding: 'utf8',
          env: { ...environment, ...extra },
        });

      const baseline = run(runScript(BASELINE_STEP), {
        STUB_RUNS: join(directory, 'before.tsv'),
      });
      expect(`${baseline.status}: ${baseline.stderr}`).toBe('0: ');
      const runsBefore = /^runs=(.*)$/m.exec(readFileSync(join(directory, 'outputs'), 'utf8'))?.[1];
      expect(runsBefore).toBeDefined();
      // The poll counter is per step; the baseline's own call must not age the scenario.
      rmSync(join(directory, 'calls'), { force: true });

      const image = run(runScript(IMAGE_STEP), {
        STUB_RUNS: join(directory, 'after.tsv'),
        RUNS_BEFORE: runsBefore ?? '',
        TAG_STARTED_A_RUN: String(scenario.administratorToken),
        STUB_WATCH_EXIT: String(scenario.watchExit ?? 0),
      });
      return {
        status: image.status ?? -1,
        stdout: image.stdout,
        stderr: image.stderr,
        calls: readFileSync(join(directory, 'gh.log'), 'utf8')
          .split('\n')
          .filter((line) => line !== ''),
        runsBefore: runsBefore ?? '',
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  const watched = (outcome: Outcome): string[] =>
    outcome.calls
      .filter((call) => call.startsWith('run watch '))
      .map((call) => call.split(' ')[2] ?? '');

  const dispatches = (outcome: Outcome): string[] =>
    outcome.calls.filter((call) => call.startsWith('workflow run '));

  const mainBuild: StubRun = { id: 6900, branch: 'main', event: 'push' };

  it('dispatches on the GITHUB_TOKEN fallback, and watches the run the dispatch created', () => {
    const outcome = drive({
      before: [mainBuild],
      after: [{ id: 7001, branch: TAG, event: 'workflow_dispatch' }, mainBuild],
      administratorToken: false,
    });

    expect(outcome.status).toBe(0);
    expect(dispatches(outcome)).toEqual([`workflow run image.yml --ref ${TAG}`]);
    expect(watched(outcome)).toEqual(['7001']);
  });

  /**
   * The case the run lookup exists for. An older `workflow_dispatch` run at this very commit — a
   * manual start, or a re-run — is the newest match the moment the dispatch is accepted, and the
   * release's own run has not appeared yet. Taking the newest match would watch the older run to
   * *its* verdict, which is already decided.
   */
  it('ignores a run that was already there, and waits for the one this release started', () => {
    const stale: StubRun = { id: 6950, branch: TAG, event: 'workflow_dispatch' };
    const outcome = drive({
      before: [stale, mainBuild],
      after: [{ id: 7010, branch: TAG, event: 'workflow_dispatch', fromCall: 3 }, stale, mainBuild],
      administratorToken: false,
    });

    expect(outcome.status).toBe(0);
    expect(outcome.runsBefore).toContain('6950');
    expect(watched(outcome)).toEqual(['7010']);
  });

  /**
   * The administrator-token path: the tag push has already started the build, so a dispatch would
   * be a second one queued behind it. The `push: main` build of the same commit is always present
   * here, and the tag's run is told from it by the ref — and by the baseline, which contains it.
   */
  it('dispatches nothing when the tag itself started a run, and watches that run', () => {
    const outcome = drive({
      before: [mainBuild],
      after: [{ id: 7020, branch: TAG, event: 'push', fromCall: 2 }, mainBuild],
      administratorToken: true,
    });

    expect(outcome.status).toBe(0);
    expect(dispatches(outcome)).toEqual([]);
    expect(watched(outcome)).toEqual(['7020']);
    expect(outcome.stdout).toContain('not dispatching');
  });

  it('fails when no new run appears, and says what is and is not known at that point', () => {
    const outcome = drive({
      before: [mainBuild],
      after: [mainBuild],
      administratorToken: false,
    });

    expect(outcome.status).toBe(1);
    expect(watched(outcome)).toEqual([]);
    // Bounded rather than hanging: 30 polls, and the message claims only what is true — the
    // release exists, the dispatch was accepted, and whether images were built is not knowable
    // from this step.
    const polls = outcome.calls.filter((call) =>
      call.startsWith('run list --workflow image.yml --event'),
    );
    expect(polls.length).toBe(30);
    expect(outcome.stderr).toContain('the release exists, and the dispatch was accepted');
    expect(outcome.stderr).toContain('start one on that tag by hand');
    expect(outcome.stderr).not.toContain('has no images');
  });

  it('is red when the image build it watched is red (--exit-status)', () => {
    const outcome = drive({
      before: [mainBuild],
      after: [{ id: 7001, branch: TAG, event: 'workflow_dispatch' }, mainBuild],
      administratorToken: false,
      watchExit: 1,
    });

    expect(watched(outcome)).toEqual(['7001']);
    expect(outcome.status).toBe(1);
  });
});

describe('every workflow this repository runs', () => {
  const workflows = tracked('.github/workflows/*.yml');

  it('is a corpus, and every `uses:` in it is pinned to a commit SHA (TD-019)', () => {
    expect(workflows).toContain(RELEASE_WORKFLOW);
    expect(workflows.length).toBeGreaterThanOrEqual(4);

    const uses = workflows.flatMap((path) =>
      [...read(path).matchAll(/^\s*(?:-\s+)?uses: (\S+)(?:\s+#.*)?$/gm)].map((match) => ({
        path,
        ref: match[1] ?? '',
      })),
    );
    // Without this the loop below is vacuously true for a regex that stopped matching.
    expect(uses.length).toBeGreaterThan(10);

    for (const { path, ref } of uses) {
      // A local composite action (`./.github/...`) is this repository's own code and carries no
      // supply-chain question; there are none today, and the shape is allowed for when there are.
      if (ref.startsWith('./')) continue;
      expect(`${path}: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});

describe('the versioning shape (one product version, moved together)', () => {
  const config = readJson<ReleasePleaseConfig>(CONFIG);
  const manifest = readJson<Record<string, string>>(MANIFEST);
  const manifests = tracked('*package.json');

  it('releases one component, at the repository root, tagged `vX.Y.Z`', () => {
    expect(Object.keys(config.packages)).toEqual(['.']);
    expect(Object.keys(manifest)).toEqual(['.']);
    // `include-component-in-tag: false` is what makes the tag `v0.1.0` rather than
    // `platform-v0.1.0`, which is the shape `image.yml`'s `tags: ['v*']` reads.
    expect(config['include-component-in-tag']).toBe(false);
    expect(config['initial-version']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /**
   * Nothing in this repository is published to a registry — every manifest is `private: true` —
   * so a per-package version would be a number with no consumer and eleven chances to disagree.
   * The decision is one product version; this is what makes "together" mechanical rather than
   * remembered: the set of files that must move is read from **git**, not from a list here.
   */
  it('moves every workspace manifest with the root, and knows of no others', () => {
    const extras = (config.packages['.']?.['extra-files'] ?? []).map((file) => file.path);
    expect(manifests.length).toBe(11);
    expect([...extras].sort()).toEqual(manifests.filter((path) => path !== 'package.json').sort());
  });

  it('carries one version string across all eleven manifests and the release manifest', () => {
    const versions = manifests.map((path) => readJson<{ version: string }>(path).version);
    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toBe(manifest['.']);
  });

  /**
   * `0.0.0` is not a version this build claims; it is how release-please is told there has been no
   * release. Its manifest reader skips an entry whose value is exactly `0.0.0`
   * (`src/manifest.ts`, "but a previous version was specified in the manifest" — the branch is
   * guarded by `!== '0.0.0'`), so the first release PR takes its version from `initial-version`
   * instead. Both halves are asserted because either one alone would let the first release be
   * `1.0.0`, which is release-please's default when no previous release is found.
   */
  it('is bootstrapped so the first release is the configured initial version', () => {
    expect(manifest['.']).toBe('0.0.0');
    expect(config['initial-version']).toBe('0.1.0');
  });

  /**
   * `ci.yml`'s `dco` job fails a commit whose `Signed-off-by` e-mail is not its author's, and the
   * release PR's commit is made by the action rather than by a person. The identity below is
   * therefore load-bearing; what can be asserted here is its *shape* — the same `Name <email>`
   * `scripts/commits.mjs` § parseIdentity requires — and not that it matches the author, which
   * only a run can say.
   */
  it('signs off the release commit in the form the DCO gate accepts', () => {
    expect(config.signoff).toMatch(/^.+\s<[^<>\s]+@[^<>\s]+>$/);
  });
});

describe('CHANGELOG.md', () => {
  const changelog = read('CHANGELOG.md');
  const config = readJson<ReleasePleaseConfig>(CONFIG);

  it('is generated, and says which command generates it', () => {
    expect(changelog).toContain('Generated by `pnpm changelog`');
    expect(readJson<{ scripts: Record<string, string> }>('package.json').scripts.changelog).toBe(
      'node scripts/changelog.mjs',
    );
  });

  it('covers the whole history rather than starting at the release commit', () => {
    // A shallow clone counts one commit and the assertion below reads "expected 86 to be less than
    // or equal to 1" (ci.yml at 2788e9c); name the cause instead. CI's unit job fetches full history.
    expect(
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }).trim(),
      'this test reads the repository history and needs a full clone (ci.yml unit job: fetch-depth 0)',
    ).toBe('false');
    const entries = [...changelog.matchAll(/^\* /gm)];
    const commits = execFileSync('git', ['rev-list', '--no-merges', '--count', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim();
    // Every visible entry is a commit, and there are far more of them than one release's worth —
    // the M1–M3 history, which is what makes this the first entry of a first release rather than
    // a changelog that starts today.
    expect(entries.length).toBeGreaterThan(50);
    expect(entries.length).toBeLessThanOrEqual(Number(commits));
  });

  it('states product/14’s exit criteria against the release, each with its status', () => {
    expect(changelog).toContain('### What this release does not claim');
    const product = read('docs/product/14-mvp-scope-and-roadmap.md');
    for (const criterion of MVP_EXIT_CRITERIA) {
      // Quoted from the product document, and still in it: a criterion reworded upstream would
      // otherwise be quoted in release notes for years (standing rule 83).
      expect(product).toContain(criterion.quote);
      expect(changelog).toContain(criterion.quote);
    }
  });

  it('states what upgrading does to the database and what has not been measured', () => {
    expect(changelog).toContain('### Before you upgrade');
    expect(changelog).toContain('A migration is required.');
    expect(changelog).toContain('docs/operator-guide.md');
    expect(changelog).toContain('### What has not been measured');
    expect(changelog).toContain('never been run against a model');
  });

  /**
   * release-please inserts a released section **before** the first heading matching its
   * `DEFAULT_VERSION_HEADER_REGEX` (`src/updaters/changelog.ts`, v17.6.0) and otherwise demotes
   * the whole file below its own. The preview heading below is what makes the first case the one
   * that happens — a file without it would come back from the release PR rearranged.
   */
  it('carries a heading release-please will insert its released section above', () => {
    const versionHeader = /\n###? v?[0-9[]/s;
    expect(versionHeader.test(changelog)).toBe(true);
    expect(changelog).toContain(`## ${config['initial-version']} (unreleased)`);
  });
});

describe("TD-019's hygiene list", () => {
  it.each([
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    '.github/CODEOWNERS',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/ISSUE_TEMPLATE/bug.yml',
    '.github/ISSUE_TEMPLATE/feature.yml',
    '.github/ISSUE_TEMPLATE/integration-request.yml',
  ])('ships %s', (path) => {
    expect(existsSync(join(repositoryRoot, path))).toBe(true);
  });

  it('routes review to an owner GitHub can resolve', () => {
    const owners = [...read('.github/CODEOWNERS').matchAll(/^\S+\s+(@\S+)$/gm)].map(
      (match) => match[1] ?? '',
    );
    expect(owners.length).toBeGreaterThan(0);
    // A user or a team; an organisation name alone is not a valid owner, and a bare e-mail would
    // not be reviewable. `@org/team` and `@user` are the two shapes GitHub resolves.
    for (const owner of owners) expect(owner).toMatch(/^@[A-Za-z\d](?:[\w-]*)(?:\/[\w.-]+)?$/);
  });
});

/**
 * The required checks a ruleset on `main` has to name (TD-019: "Required checks and merge queue
 * configured as a ruleset on `main`").
 *
 * A ruleset is repository configuration and cannot be read from a checkout, so what this holds is
 * the *list an operator applies*: CONTRIBUTING.md names it, and the names have to be exactly the
 * job names `ci.yml` reports — a required check naming a job that does not exist blocks every pull
 * request forever, and a job missing from the list gates nothing. Both directions, so neither can
 * go stale (the shape `client-census.test.ts` uses for the read API).
 */
describe('the required checks named in CONTRIBUTING.md', () => {
  it('are exactly the jobs ci.yml runs', () => {
    const jobs = [...read(CI_WORKFLOW).matchAll(/^ {4}name: (.+)$/gm)].map((match) =>
      (match[1] ?? '').trim(),
    );
    expect(jobs.length).toBeGreaterThan(5);

    // Only that section: the rest of the file has bullet lists of its own, and one of them is a
    // list of `pnpm` targets that would otherwise read as a required check.
    const after = read('CONTRIBUTING.md').split('## Branch protection')[1] ?? '';
    const section = after.split('\n## ')[0] ?? '';
    expect(section).not.toBe('');
    const named = [...section.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1] ?? '');

    expect([...named].sort()).toEqual([...jobs].sort());
  });
});
