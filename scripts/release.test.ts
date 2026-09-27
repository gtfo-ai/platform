import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
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
import { censusPaths } from './census-files.mjs';
import { changelogHeadingProblems, MVP_EXIT_CRITERIA } from './changelog.mjs';

/**
 * The release mechanism, asserted against the files that decide it (WP-42, WP-71, TD-019,
 * technical/11).
 *
 * `scripts/verify.test.ts` holds `verify` to `ci.yml`; this is the same job for the workflows that
 * publish, and it exists because **no workflow can be run from a checkout**. The alternative to
 * these assertions is a workflow whose first execution is also its first test — on the push that
 * cuts a release (standing rule 71). What can be checked offline is every property that is a
 * statement about the *files*: the triggers, the pins, the gate, the permissions, the one route a
 * version tag takes to the registry.
 *
 * Two parts of `image.yml` *are* executable, and are executed: the step that decides whether this
 * run computes a version at all (the switch), and the step that retags the images and cuts the
 * release, against a stub `docker` and a stub `gh` (`scripts/fixtures/`). Nothing here creates a
 * tag, a release or a registry tag anywhere; the version arithmetic itself is `version.test.ts`'s.
 *
 * What it cannot check, stated rather than implied: that `vars.RELEASE_VERSIONING` reads as the
 * empty string when the variable is unset (GitHub's documentation says so for contexts; nobody here
 * has seen the job skip), that `GITHUB_TOKEN` may create the tag through `gh release create` (Q90's
 * measurement is that only *pull requests* are refused), and that `imagetools create` keeps the
 * digest — the step checks that one at run time rather than trusting it.
 *
 * **Why it cannot pass for the wrong reason.** Every corpus it builds is asserted non-empty first:
 * a regex that matched nothing would otherwise satisfy every "each of these is pinned" assertion
 * at once (standing rule 4), which is the failure mode `verify.test.ts` records having shipped.
 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (path: string): string => readFileSync(join(repositoryRoot, path), 'utf8');

const readJson = <T>(path: string): T => JSON.parse(read(path)) as T;

/**
 * What git knows about — tracked, or untracked and not ignored — so no list here has to be
 * maintained by hand (standing rule 7) and a workflow written but not yet staged is held to the
 * same pins (backlog 10; the list is `census-files.mjs`'s). A tracked path deleted from the working
 * tree is dropped, as `census-files.mjs` drops a vanished one: it is no longer part of the tree —
 * which is the state of `release.yml` between WP-71's deletion and its commit.
 */
const tracked = (pattern: string): string[] =>
  censusPaths(repositoryRoot, { pathspecs: [pattern] }).filter((path) =>
    existsSync(join(repositoryRoot, path)),
  );

const IMAGE_WORKFLOW = '.github/workflows/image.yml';
const CI_WORKFLOW = '.github/workflows/ci.yml';

/** The switch, spelled once here; the workflow and CONTRIBUTING.md are both held to it. */
const SWITCH_VARIABLE = 'RELEASE_VERSIONING';
const SWITCH_VALUE = 'enabled';

/**
 * One job of a workflow: from `  <name>:` to the next job key at the same indentation, or the end.
 * Asserted non-empty by every caller, so a renamed job fails here rather than emptying a corpus.
 */
const jobOf = (workflow: string, name: string): string => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `no job \`${name}\``).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + 1);
  const next = /\n {2}[a-z][\w-]*:\n/.exec(rest.slice(1));
  return next === null ? rest : rest.slice(0, next.index + 1);
};

/** A job's `permissions:` block, as `key: value` strings. */
const permissionsOf = (job: string): string[] => {
  const block = /\n {4}permissions:\n((?: {6}(?:#.*|[a-z-]+: \w+)\n)+)/.exec(job)?.[1] ?? '';
  return [...block.matchAll(/^ {6}([a-z-]+): (\w+)$/gm)].map((match) => `${match[1]}: ${match[2]}`);
};

/** The `run: |` body of the step named `stepName` in `text`, dedented — the file is the only copy. */
const runScript = (text: string, stepName: string): string => {
  const step = text.slice(text.indexOf(`name: ${stepName}`));
  expect(text.includes(`name: ${stepName}`), `no step named \`${stepName}\``).toBe(true);
  const body = /\n {8}run: \|\n((?: {10}.*\n|[ \t]*\n)+)/.exec(step)?.[1] ?? '';
  // Without this an extraction that stopped matching would "pass" every case below at once.
  expect(body).not.toBe('');
  return body.replace(/^ {10}/gm, '');
};

/**
 * **release-please is retired by deletion** (WP-71; TD-019's amendment permits "kept … or
 * deleted").
 *
 * It was kept at the amendment as a manual dispatch "if a batched version is ever wanted again".
 * WP-71 is where versions came back, and they came back as a *retag* in `image.yml`; keeping the
 * old mechanism beside it would have kept a second route to a version tag — `release.yml`
 * dispatched `image.yml` on the tag ref, whose tag arm **built the images again** under the version,
 * which is exactly what TD-019's amendment forbids. So the workflow and its two configuration files
 * go together, and this asserts the absence rather than trusting it.
 */
describe('release-please, retired', () => {
  it('has no workflow, no configuration and no manifest left to run from', () => {
    for (const path of [
      '.github/workflows/release.yml',
      'release-please-config.json',
      '.release-please-manifest.json',
    ]) {
      expect(existsSync(join(repositoryRoot, path)), path).toBe(false);
    }
    const workflows = tracked('.github/workflows/*.yml');
    expect(workflows.length).toBeGreaterThanOrEqual(3);
    for (const path of workflows) expect(read(path), path).not.toContain('release-please-action');
  });

  /*
   * The documents' half, kept from the amendment's round: `CONTRIBUTING.md` no longer tells an
   * administrator to create `RELEASE_PLEASE_TOKEN` or to let Actions open pull requests — a setup
   * step for a workflow that does not exist buys nothing. The one switch it *does* name is below.
   */
  it('is no longer a setup step anybody is told to take', () => {
    const contributing = read('CONTRIBUTING.md');
    expect(contributing).not.toContain('What an administrator sets up once');
    expect(contributing).not.toContain('RELEASE_PLEASE_TOKEN');
    expect(contributing).toContain(
      '`release.yml` and release-please’s two configuration files are **deleted**',
    );
  });
});

/**
 * **What a version is, and the one route it takes to the registry** (WP-71, plan criteria 8 and
 * the TD-019 amendment's "no second build").
 */
describe("image.yml's versioning (WP-71)", () => {
  const workflow = read(IMAGE_WORKFLOW);
  const release = jobOf(workflow, 'release');
  const version = jobOf(workflow, 'version');

  /**
   * **The gate — the property that makes landing this row safe.** An unset repository variable is
   * the empty string, so with the switch absent the job is skipped and the push that lands this row
   * creates no tag and no release. The job's `if:` must name the switch, the ref and the event; a
   * condition that lost the switch would cut `0.1.0` on the next push to `main`.
   */
  it('cuts nothing until an administrator sets RELEASE_VERSIONING=enabled', () => {
    const condition =
      /\n {4}if: >-\n((?: {6}.*\n)+)/.exec(release)?.[1]?.replace(/\s+/g, ' ') ?? '';
    // The **whole** expression, normalised — not each clause somewhere in it: round 1's version of
    // this case checked containment, and a canary turning `&& vars.…` into `|| vars.…` survived it
    // (every clause still appears; the switch no longer gates anything).
    expect(condition.trim()).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main' " +
        `&& vars.${SWITCH_VARIABLE} == '${SWITCH_VALUE}' && needs.version.outputs.version != ''`,
    );
    // The version step reads the same variable; the executable half of that is below.
    expect(version).toContain(`${SWITCH_VARIABLE}: \${{ vars.${SWITCH_VARIABLE} }}`);
  });

  /**
   * Q96 (2): "`image.yml`'s `push: tags` trigger goes" — and with it the tag arm that published
   * `X.Y.Z`/`X.Y`/`X` **and a second `latest`** from a second build. A version tag now reaches the
   * registry by one route, the retag; `latest` has one definition, the newest push to `main`.
   */
  it('has no tag trigger and no tag arm, so a version is never built and latest is defined once', () => {
    const triggers = (/\non:\n((?:[ \t]+.*\n|\n)+)/.exec(workflow)?.[1] ?? '').trim();
    expect(triggers.split('\n').map((line) => line.trimEnd())).toEqual([
      'push:',
      '    branches: [main]',
      '  pull_request:',
      '  workflow_dispatch:',
    ]);
    // Code only: the comments explain why the ref, not its name, is compared.
    const code = workflow
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toContain('GITHUB_REF_TYPE');
    expect(code).not.toContain('GITHUB_REF_NAME');
    const assignments = [...workflow.matchAll(/^\s+tags="([^"]*)"$/gm)].map((match) => match[1]);
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.filter((tags) => /\blatest\b/.test(tags ?? ''))).toHaveLength(1);
  });

  it('retags the manifest lists this run merged, and builds nothing', () => {
    expect(release).toMatch(/\n {4}needs: \[version, merge\]\n/);
    expect(release).not.toContain('build-images.mjs');
    expect(release).not.toMatch(/docker (?:build|push)\b/);
    expect(release).toContain('docker buildx imagetools create');
    // The source is the digest this run attested, never the `sha-<7>` tag as it stands.
    expect(release).toContain('"${repo}@${digest}"');
    expect(release).not.toMatch(/imagetools create[^\n]*\\\n[^\n]*\n\s+"\$\{repo\}:sha-/);
    expect(release).toContain('uses: actions/download-artifact@');
    expect(jobOf(workflow, 'merge')).toContain('name: digest-${{ matrix.image }}');
    // The read-back that makes "a retag" a statement the run verifies, not a sentence it trusts.
    expect(release).toContain('not a retag');
  });

  /**
   * The release job's image list is a second statement of the merge job's matrix (a step that
   * cuts one release after all five copies cannot be a matrix), so the two are held equal —
   * both directions, because an image missing from either publishes a release without it.
   */
  it('names the same five images as the manifest-list job', () => {
    const matrix = /\n {8}image: \[([^\]]+)\]\n/.exec(jobOf(workflow, 'merge'))?.[1] ?? '';
    const merged = matrix.split(',').map((image) => image.trim());
    const loop = /\n\s+images="([^"]+)"\n/.exec(release)?.[1] ?? '';
    const retagged = loop.split(/\s+/).filter((image) => image !== '');
    expect(merged.length).toBe(5);
    expect([...retagged].sort()).toEqual([...merged].sort());
  });

  it('holds the permissions each of its effects needs, and no more', () => {
    expect(permissionsOf(release).sort()).toEqual(['contents: write', 'packages: write']);
    expect(permissionsOf(version)).toEqual(['contents: read']);
  });

  it('reads the history and tags it computes from, in both jobs that read them', () => {
    for (const job of [version, release]) expect(job).toMatch(/fetch-depth: 0/);
    expect(version).toContain('node scripts/version.mjs --github-output');
    expect(release).toContain(
      'node scripts/changelog.mjs --release-notes --version "${VERSION}" > "${RUNNER_TEMP}/notes.md"',
    );
    // The image reports the version it was released as, from the same output the release uses.
    expect(jobOf(workflow, 'build')).toContain(
      'RELEASE_VERSION: ${{ needs.version.outputs.version }}',
    );
  });
});

/** A throwaway directory with the two stubs on `PATH` and a `sleep` that returns at once. */
const stubDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'image-yml-'));
  for (const name of ['gh', 'docker']) {
    copyFileSync(join(repositoryRoot, `scripts/fixtures/${name}-stub.sh`), join(directory, name));
    chmodSync(join(directory, name), 0o755);
  }
  writeFileSync(join(directory, 'calls.log'), '');
  writeFileSync(join(directory, 'outputs'), '');
  return directory;
};

const callsIn = (directory: string): string[] =>
  readFileSync(join(directory, 'calls.log'), 'utf8')
    .split('\n')
    .filter((line) => line !== '');

/**
 * The switch, **executed**: the step that decides whether this run computes a version at all, run
 * with a stub `node` that records whether it was asked. Only a push to `refs/heads/main` with the
 * variable set to exactly `enabled` reaches the computation; every other combination writes an
 * empty version, which is what skips the release job.
 */
describe('the step that computes a version, and the switch in front of it', () => {
  const step = runScript(jobOf(read(IMAGE_WORKFLOW), 'version'), 'compute the version');

  const drive = (env: Record<string, string>) => {
    const directory = stubDirectory();
    try {
      writeFileSync(
        join(directory, 'node'),
        '#!/bin/bash\nprintf "node %s\\n" "$*" >> "$STUB_LOG"\necho "version=0.1.0" >> "$GITHUB_OUTPUT"\n',
        { mode: 0o755 },
      );
      const result = spawnSync('bash', ['-c', step], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          GITHUB_OUTPUT: join(directory, 'outputs'),
          STUB_LOG: join(directory, 'calls.log'),
          ...env,
        },
      });
      return {
        status: result.status,
        calls: callsIn(directory),
        outputs: readFileSync(join(directory, 'outputs'), 'utf8'),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  const onMain = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' };

  it('computes only on a push to main with the switch set to exactly `enabled`', () => {
    const outcome = drive({ ...onMain, [SWITCH_VARIABLE]: SWITCH_VALUE });
    expect(outcome.status).toBe(0);
    expect(outcome.calls).toEqual(['node scripts/version.mjs --github-output']);
    expect(outcome.outputs).toBe('version=0.1.0\n');
  });

  it.each([
    ['the switch unset — this repository today', { ...onMain }],
    ['the switch set to something else', { ...onMain, [SWITCH_VARIABLE]: 'true' }],
    [
      'a pull request',
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REF: 'refs/pull/1/merge',
        [SWITCH_VARIABLE]: SWITCH_VALUE,
      },
    ],
    [
      'a dispatch on a branch',
      {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/wip',
        [SWITCH_VARIABLE]: SWITCH_VALUE,
      },
    ],
    [
      'a dispatch on main',
      {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main',
        [SWITCH_VARIABLE]: SWITCH_VALUE,
      },
    ],
  ])('computes nothing for %s', (_label, env) => {
    const outcome = drive(env);
    expect(outcome.status).toBe(0);
    expect(outcome.calls).toEqual([]);
    expect(outcome.outputs).toBe('version=\n');
  });
});

/**
 * The step that creates things on the public repository, **executed against stubs**: five copies
 * of a manifest list and one `gh release create`. The failure modes it is run through are the ones
 * that would publish something wrong — a copy with a different digest, a copy that failed, a tag
 * of that name already standing somewhere else — and in each the release is **not** cut.
 */
describe('the shell that tags the images and cuts the release', () => {
  const HEAD_SHA = '1b0c5f9a2d3e4f5061728394a5b6c7d8e9f01234';
  const step = runScript(
    jobOf(read(IMAGE_WORKFLOW), 'release'),
    'tag the images and cut the release',
  );

  const BUILT = `sha256:${'1'.repeat(64)}`;
  const IMAGES = [
    'platform-base',
    'platform-runtime',
    'platform-egress',
    'platform',
    'platform-launcher',
  ];

  const drive = (scenario: {
    readonly existingTag?: string;
    /** What `sha-<7>` points at when the step runs; the run built and attested `BUILT`. */
    readonly sourceDigest?: string;
    readonly copyDigest?: string;
    readonly createExit?: number;
    /** Images whose digest file the merge job did not leave. */
    readonly missingDigests?: readonly string[];
  }) => {
    const directory = stubDirectory();
    try {
      // The step runs in a checkout; this one has a commit, and optionally the tag at issue.
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          [
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.test',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'tag.gpgsign=false',
            '-c',
            'core.hooksPath=/dev/null',
            ...args,
          ],
          { cwd: directory, stdio: 'ignore' },
        );
      git('init', '-q', '-b', 'main');
      git('commit', '--allow-empty', '--no-verify', '-q', '-m', 'feat: a fixture');
      if (scenario.existingTag !== undefined) git('tag', scenario.existingTag);

      // `RUNNER_TEMP` is where the previous step rendered the notes; the stub `gh` copies the file it
      // is handed to `notes.md` beside itself, which is what the release would have carried.
      const runnerTemp = join(directory, 'runner');
      mkdirSync(runnerTemp);
      writeFileSync(join(runnerTemp, 'notes.md'), '### Before you upgrade\n\nsomething\n');
      // What the `merge` legs recorded: the digest each merged and attested.
      mkdirSync(join(runnerTemp, 'digests'));
      for (const image of IMAGES) {
        if (scenario.missingDigests?.includes(image)) continue;
        writeFileSync(join(runnerTemp, 'digests', image), `${BUILT}\n`);
      }
      const result = spawnSync('bash', ['-c', step], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          HOME: directory,
          GH_TOKEN: 'not-a-real-token',
          GITHUB_SHA: HEAD_SHA,
          GITHUB_REPOSITORY: 'gtfo-ai/platform',
          GITHUB_REPOSITORY_OWNER: 'GTFO-AI',
          REGISTRY: 'ghcr.io',
          RUNNER_TEMP: runnerTemp,
          VERSION: '0.1.0',
          STUB_LOG: join(directory, 'calls.log'),
          STUB_DIR: directory,
          STUB_SOURCE_DIGEST: scenario.sourceDigest ?? BUILT,
          ...(scenario.copyDigest === undefined ? {} : { STUB_COPY_DIGEST: scenario.copyDigest }),
          STUB_CREATE_EXIT: String(scenario.createExit ?? 0),
        },
      });
      const released = join(directory, 'notes.md');
      return {
        status: result.status,
        stderr: result.stderr,
        calls: callsIn(directory),
        notes: existsSync(released) ? readFileSync(released, 'utf8') : '',
        notesFile: join(runnerTemp, 'notes.md'),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  const creates = (calls: readonly string[]) =>
    calls.filter((call) => call.startsWith('docker buildx imagetools create'));
  const releases = (calls: readonly string[]) =>
    calls.filter((call) => call.startsWith('gh release create'));

  it('copies each manifest list to X.Y.Z, X.Y and X, then cuts one release at this commit', () => {
    const outcome = drive({});
    expect(`${outcome.status}: ${outcome.stderr}`).toBe('0: ');

    const copies = creates(outcome.calls);
    expect(copies).toHaveLength(5);
    expect(copies[3]).toBe(
      `docker buildx imagetools create -t ghcr.io/gtfo-ai/platform:0.1.0 -t ghcr.io/gtfo-ai/platform:0.1 -t ghcr.io/gtfo-ai/platform:0 ghcr.io/gtfo-ai/platform@${BUILT}`,
    );
    // Every source is checked before the first copy, and every one of the three tags after it.
    const firstCopy = outcome.calls.findIndex((call) =>
      call.startsWith('docker buildx imagetools create'),
    );
    const sourceChecks = outcome.calls.filter((call) => /inspect \S+:sha-1b0c5f9 /.test(call));
    expect(sourceChecks).toHaveLength(5);
    expect(outcome.calls.slice(0, firstCopy).filter((call) => call.includes(':sha-'))).toHaveLength(
      5,
    );
    for (const tag of ['0.1.0', '0.1', '0']) {
      expect(
        outcome.calls.filter((call) =>
          call.includes(`inspect ghcr.io/gtfo-ai/platform-egress:${tag} `),
        ),
      ).toHaveLength(1);
    }
    // Created once, at the commit this run built, and last — never before a copy.
    expect(releases(outcome.calls)).toEqual([
      `gh release create v0.1.0 --target ${HEAD_SHA} --title v0.1.0 --notes-file ${outcome.notesFile}`,
    ]);
    expect(outcome.calls.at(-1)).toBe(releases(outcome.calls)[0]);
    // The body is the rendered notes plus the five images and their digests.
    expect(outcome.notes).toContain('### Before you upgrade');
    expect(outcome.notes).toContain('### Images');
    expect(
      outcome.notes.match(/^- `ghcr\.io\/gtfo-ai\/[\w-]+:0\.1\.0` — `sha256:1{64}`$/gm),
    ).toHaveLength(5);
  });

  /**
   * The reviewer's case: `sha-<7>` moved after this run attested it — a dispatch at the same commit
   * on another ref runs in another concurrency group. Nothing may be copied at all, not even the
   * images whose tag did not move.
   */
  it('copies nothing when sha-<7> no longer points at the digest this run built', () => {
    const outcome = drive({ sourceDigest: `sha256:${'3'.repeat(64)}` });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain('the digest this run built and attested; nothing was copied');
    expect(creates(outcome.calls)).toEqual([]);
    expect(releases(outcome.calls)).toEqual([]);
  });

  it('copies nothing when the merge job left no digest for an image', () => {
    const outcome = drive({ missingDigests: ['platform-launcher'] });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain('no digest recorded for platform-launcher');
    expect(creates(outcome.calls)).toEqual([]);
  });

  it('refuses to cut the release when a copied tag reads back as another digest', () => {
    const outcome = drive({ copyDigest: `sha256:${'2'.repeat(64)}` });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain('not a retag');
    expect(outcome.stderr).toContain('have already moved');
    expect(releases(outcome.calls)).toEqual([]);
  });

  it('refuses to cut the release when a copy fails', () => {
    const outcome = drive({ createExit: 1 });
    expect(outcome.status).toBe(1);
    expect(creates(outcome.calls)).toHaveLength(1);
    expect(releases(outcome.calls)).toEqual([]);
  });

  it('refuses a version whose tag already exists, before touching the registry', () => {
    const outcome = drive({ existingTag: 'v0.1.0' });
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain('v0.1.0 already exists');
    expect(outcome.calls).toEqual([]);
  });
});

/**
 * **What `image.yml` publishes on a push to `main`** — TD-019's amendment of 2026-09-16.
 *
 * The amendment is the spec and this is the only executable thing that holds it: *"`image.yml`
 * publishes every push to `main` as `sha-<7>`, `edge` **and `latest`**"*. Without a case here the
 * claim lives in a comment and in a shell line nothing runs off a checkout (standing rules 3 and
 * 71 — no test in this repository has ever started a workflow).
 *
 * It reads the **main branch** of the tag computation, not the file as a whole: `latest` also
 * appears in the comments, so `workflow.includes('latest')` would have passed before the change as
 * readily as after it. Since WP-71 removed the tag arm this is the computation's only conditional
 * arm, and it is the one quoted.
 */
describe("image.yml's tags on a push to main (TD-019 amendment)", () => {
  const workflow = read(IMAGE_WORKFLOW);

  /**
   * The branch arm of the tag computation, **with the condition that guards it**.
   *
   * Read as one regex on purpose. The first version of this case matched a bare `else`, and a bare
   * `else` is exactly the defect review found: this job is gated only on
   * `github.event_name != 'pull_request'` and the workflow declares `workflow_dispatch`, so "not a
   * tag" admits a manual dispatch on a feature branch. A test that reads the arm without its
   * condition cannot tell the two apart. (It was an `elif` behind the tag arm until WP-71 removed
   * that arm; either spelling is read.)
   */
  const mainBranchArm = (): { condition: string; tags: string } => {
    const arm = /\n\s+(?:el)?if \[ (.+?) \]; then\n\s+tags="([^"]+)"\n/.exec(workflow);
    expect(
      arm,
      'the manifest step has no guarded branch arm: a bare `else` publishes from any ref',
    ).not.toBeNull();
    return { condition: arm?.[1] ?? '', tags: arm?.[2] ?? '' };
  };

  it('publishes sha-<7>, edge and latest, so the newest push to main is `latest`', () => {
    const { tags } = mainBranchArm();

    // `${tags}` is `sha-<7>`, computed one line above and asserted separately below.
    expect(tags.split(/\s+/).filter((tag) => tag !== '${tags}')).toEqual(['edge', 'latest']);
    expect(workflow).toContain('tags="sha-${short}"');
  });

  /**
   * **The guard, which is what makes "the newest push to `main`" true** (the amendment's words).
   *
   * Without it a `workflow_dispatch` on a feature branch republishes `latest` and `edge` from
   * unreviewed code — Q89's recorded hazard, enlarged from `edge` to `latest` by the amendment.
   * The condition is compared literally: `GITHUB_REF`, not `GITHUB_REF_NAME`, because a *tag*
   * called `main` matches the name, and `refs/heads/main` in full so a branch called `mainline`
   * cannot satisfy a prefix test somebody writes later.
   */
  it('publishes both moving tags only from refs/heads/main, never from a dispatch on a branch', () => {
    const { condition } = mainBranchArm();

    expect(condition).toBe('"${GITHUB_REF}" = "refs/heads/main"');
    // …and there is no unguarded fall-through beside it: an `else` here would restore the hole
    // while leaving the `elif` above it green.
    const step = workflow.slice(workflow.indexOf('tags="sha-${short}"'));
    expect(step.slice(0, step.indexOf('\n          refs='))).not.toMatch(/\n\s+else\n/);
  });
});

describe('every workflow this repository runs', () => {
  const workflows = tracked('.github/workflows/*.yml');

  /**
   * Two pinned shapes, both immutable: an action at a 40-hex commit, and — since WP-71's linters — a
   * container image at a `sha256` digest (`docker://image@sha256:<64 hex>`). A tag in either place
   * (`@v4`, `:1.7.12`) is mutable and fails here.
   */
  it('is a corpus, and every `uses:` in it is pinned to a commit SHA or an image digest (TD-019)', () => {
    expect(workflows).toContain(IMAGE_WORKFLOW);
    expect(workflows).toContain(CI_WORKFLOW);
    expect(workflows.length).toBeGreaterThanOrEqual(3);

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
      if (ref.startsWith('docker://')) {
        expect(`${path}: ${ref}`).toMatch(/^[^:]+: docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/);
        continue;
      }
      expect(`${path}: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});

/**
 * **The three workflow linters** (WP-71, backlog 117, plan criteria 3–5): one step each in CI's
 * `lint` job, each a digest-pinned image. What is held here is what the files can state — that the
 * steps exist in that job, that they are pinned, and that hadolint's explicit file list (its image
 * has no shell to expand a glob) is every Dockerfile git knows, in both directions. Whether they
 * pass is the job's to say; their first-run counts are in PROGRESS.md under WP-71.
 */
describe("the workflow linters in ci.yml's lint job", () => {
  const lint = jobOf(read(CI_WORKFLOW), 'lint');

  it.each([
    ['actionlint', 'rhysd/actionlint'],
    ['zizmor', 'ghcr.io/zizmorcore/zizmor'],
    ['hadolint', 'hadolint/hadolint'],
  ])('runs %s as a digest-pinned step of the lint job', (name, image) => {
    const step = new RegExp(
      `\\n {6}- name: ${name}\\n {8}uses: docker:\\/\\/${image.replace(/[./]/g, (c) => `\\${c}`)}@sha256:[0-9a-f]{64} # \\S+\\n`,
    );
    expect(lint).toMatch(step);
  });

  it('lints every Dockerfile git knows about, and names no other', () => {
    const args = /name: hadolint\n[\s\S]*?\n {10}args: (.+)\n/.exec(lint)?.[1] ?? '';
    const named = args.split(/\s+/).filter((arg) => arg !== '');
    const dockerfiles = tracked('docker/*.Dockerfile');
    expect(dockerfiles.length).toBeGreaterThanOrEqual(5);
    expect([...named].sort()).toEqual([...dockerfiles].sort());
  });

  /**
   * The second decision backlog 117 asked to be stated rather than defaulted: which hadolint rules
   * are waived for the whole corpus, each with its reason. A waiver without a reason is a rule
   * switched off, so every `ignored` entry must be preceded by a comment.
   */
  it('waives hadolint rules only with a stated reason, and fails on every level otherwise', () => {
    const config = read('.hadolint.yaml');
    expect(config).toMatch(/^failure-threshold: style$/m);
    const ignored = [...config.matchAll(/^ {2}- (DL\d{4}|SC\d{4})$/gm)];
    expect(ignored.length).toBeGreaterThan(0);
    for (const match of ignored) {
      const before = config.slice(0, match.index).trimEnd().split('\n').at(-1) ?? '';
      expect(before, `${match[1]} is waived without a reason`).toMatch(/^ {2}#/);
    }
  });
});

/**
 * **One product version, and it lives in the tag** (WP-42's decision, WP-71's mechanism).
 *
 * Nothing in this repository is published to a registry — every manifest is `private: true` — so a
 * per-package version would be a number with no consumer and eleven chances to disagree. Since
 * WP-71 the version is computed from the history on each push and exists as a **tag**, never as a
 * commit: moving eleven `version` fields would need a bot commit on `main`, which Q96 (3) rules
 * out. So the eleven fields stay at `0.0.0` together — the value that says "the tag is the
 * version", and the image reports the computed one at `GET /api/version` from its build argument.
 */
describe('the versioning shape (one product version, carried by the tag)', () => {
  const manifests = tracked('*package.json');

  it('knows of exactly eleven manifests, all at 0.0.0', () => {
    expect(manifests.length).toBe(11);
    const versions = manifests.map((path) => readJson<{ version: string }>(path).version);
    expect(new Set(versions)).toEqual(new Set(['0.0.0']));
  });
});

/**
 * `CHANGELOG.md` is a **pointer** (Q105 (c), PROGRESS backlog 257): every release's notes are its
 * GitHub Release, and under continuous deployment a file listing versions is stale after nearly every
 * push. So what is held here is that the file names the Releases page and the preview command and
 * carries **no version heading** — the shape that cannot go stale — while the notes themselves are
 * held where they are rendered (`changelog.test.ts`).
 */
describe('CHANGELOG.md', () => {
  const changelog = read('CHANGELOG.md');

  it('points at the GitHub Releases page and names the preview command', () => {
    expect(changelog).toMatch(/\]\(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\)/);
    expect(changelog).toContain('`pnpm changelog`');
    expect(readJson<{ scripts: Record<string, string> }>('package.json').scripts.changelog).toBe(
      'node scripts/changelog.mjs',
    );
  });

  it('carries no version heading, so there is nothing in it to go stale', () => {
    expect(changelog).not.toMatch(/^#{1,6}\s+\[?v?\d+\.\d+\.\d+/m);
    expect(changelogHeadingProblems(changelog)).toEqual([]);
  });

  it('quotes product/14’s exit criteria in the release notes only while product/14 still says them', () => {
    // Moved from the file's own text (which no longer carries them) to the table the notes are
    // rendered from: a criterion reworded upstream would otherwise be quoted in release notes for
    // years (standing rule 83).
    const product = read('docs/product/14-mvp-scope-and-roadmap.md');
    for (const criterion of MVP_EXIT_CRITERIA) {
      expect(product).toContain(criterion.quote);
    }
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

/**
 * **What an administrator applies in the repository's settings** — the class of thing a checkout
 * cannot read (WP-71, backlog 116). The branch ruleset was the first member; CodeQL's default setup
 * and the versioning switch are the other two, and `CONTRIBUTING.md` § Repository settings is where
 * all three are written down. What is held here is that each document says what the tree does.
 */
describe('the repository settings CONTRIBUTING.md asks an administrator for', () => {
  const section = (): string => {
    const after = read('CONTRIBUTING.md').split('\n## Repository settings\n')[1] ?? '';
    const text = after.split('\n## ')[0] ?? '';
    expect(text, 'CONTRIBUTING.md has no “## Repository settings” section').not.toBe('');
    return text;
  };

  /**
   * TD-017 says "CodeQL default setup", which is a **setting** — it writes no workflow and cannot be
   * applied from a checkout. So there must be no `codeql.yml` pretending otherwise (technical/11
   * listed one for two sessions that never existed), and the setting must be written down where the
   * ruleset is.
   */
  it('records CodeQL as a setting, and no workflow claims to be it', () => {
    const workflows = tracked('.github/workflows/*');
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows.filter((path) => /codeql/i.test(path))).toEqual([]);
    for (const path of workflows) expect(read(path), path).not.toContain('github/codeql-action');
    expect(section()).toContain('**CodeQL default setup**');
  });

  /**
   * The switch the release job tests and the switch the document tells an administrator to set are
   * **one** name and value, read out of both files — a document naming a variable the workflow
   * does not read would be an instruction that turns nothing on.
   */
  it('names the versioning switch exactly as the release job tests it', () => {
    const condition = /vars\.(\w+) == '(\w+)'/.exec(jobOf(read(IMAGE_WORKFLOW), 'release'));
    expect(condition?.slice(1)).toEqual([SWITCH_VARIABLE, SWITCH_VALUE]);
    expect(section()).toContain(`\`${SWITCH_VARIABLE}\` = \`${SWITCH_VALUE}\``);
  });
});

/**
 * technical/10's mutation row named `packages/core/src/domain/**`, a path that has never existed
 * (backlog 116; rule 83). A scope is only a scope if it is a directory, so the row's path is read
 * and looked for.
 */
describe("technical/10's mutation-testing scope", () => {
  it('names a directory that exists', () => {
    const row = /^\| \*\*Mutation\*\* \| `([^`]+)`/m.exec(
      read('docs/technical/10-testing-strategy.md'),
    );
    expect(row, 'technical/10 has no Mutation row').not.toBeNull();
    const directory = (row?.[1] ?? '').replace(/\/\*\*$/, '');
    expect(directory).not.toBe('');
    expect(existsSync(join(repositoryRoot, directory)), directory).toBe(true);
  });
});

/**
 * **No untrusted context is expanded inside a `run:` script** (WP-71 review round 1) — the offline
 * half of zizmor's `template-injection` audit, so the class is refused where `verify` runs and not
 * only in CI's `lint` job.
 *
 * Actions substitutes `${{ … }}` into the script text *before* the shell sees it, so a pull
 * request's title or a commit message containing `"; curl … | sh #` becomes code. The remedy is
 * the one this repository already uses: pass the value through `env:` and read `"$NAME"`. The list
 * is the contexts an outsider can write: anything under `github.event.` (titles, bodies, commit
 * messages, branch names, labels, review text), `github.head_ref`, and `inputs.` (a dispatch's
 * free text). Trusted contexts (`github.run_id`, `matrix.*` this file defines, `steps.*.outputs`)
 * are not listed — zizmor's `auditor` persona reports ten of those and gates none.
 *
 * Scanned line by line, as `verify.test.ts` scans `run:` positions, and **comment lines inside a
 * block are included**: an expression in a shell comment is substituted too.
 */
const UNTRUSTED_CONTEXT =
  /\$\{\{[^}]*\b(github\.event\.[\w.*[\]'"-]+|github\.head_ref|inputs\.[\w-]+)/g;

const runBlockLines = (workflow: string): { line: number; text: string }[] => {
  const found: { line: number; text: string }[] = [];
  let blockIndent: number | null = null;
  for (const [index, line] of workflow.split('\n').entries()) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (line.trim() === '' || indent > blockIndent) {
        found.push({ line: index + 1, text: line });
        continue;
      }
      blockIndent = null;
    }
    const run = /^\s*(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (run === null) continue;
    const rest = (run[1] ?? '').trim();
    if (rest.startsWith('|') || rest.startsWith('>')) blockIndent = indent;
    else found.push({ line: index + 1, text: rest });
  }
  return found;
};

const untrustedExpansions = (workflow: string): string[] =>
  runBlockLines(workflow).flatMap(({ line, text }) =>
    [...text.matchAll(UNTRUSTED_CONTEXT)].map((match) => `line ${line}: ${match[1]}`),
  );

describe('untrusted contexts in run: scripts', () => {
  it('finds a planted one in a script and ignores the same value passed through env:', () => {
    const planted = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      - env:',
      '          TITLE: ${{ github.event.pull_request.title }}',
      '        run: echo "$TITLE"',
      '      - run: echo "${{ github.event.head_commit.message }}"',
      '      - run: |',
      '          set -eu',
      '          # a comment is substituted too: ${{ github.head_ref }}',
      '          echo "${{ inputs.reason }} ${{ github.run_id }}"',
      '      - name: after the block',
      '        run: echo "${{ matrix.arch }}"',
      '',
    ].join('\n');
    expect(untrustedExpansions(planted)).toEqual([
      'line 7: github.event.head_commit.message',
      'line 10: github.head_ref',
      'line 11: inputs.reason',
    ]);
  });

  it('are expanded in no workflow this repository runs', () => {
    const workflows = tracked('.github/workflows/*.yml');
    expect(workflows.length).toBeGreaterThanOrEqual(3);
    // Not vacuous: the scan reads real script lines out of every workflow.
    for (const path of workflows) expect(runBlockLines(read(path)).length, path).toBeGreaterThan(0);
    const findings = workflows.flatMap((path) =>
      untrustedExpansions(read(path)).map((finding) => `${path} ${finding}`),
    );
    expect(findings, 'pass these through `env:` and read "$NAME" in the script').toEqual([]);
  });
});
