import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// The on-disk specifier, because this module is a `.mjs` the CLI also runs directly.
import {
  assertPinnedArtefactsAgree,
  packageIdOf,
  parseLockfile,
  parseYamlDocuments,
  productionClosure,
  readDeclaredLicences,
  renderNotices,
  resolveLicence,
  scanPinnedArtefacts,
  splitPackageId,
} from './notices.mjs';

/**
 * `notices.mjs`, the generator behind `THIRD_PARTY_NOTICES.md`.
 *
 * The guard ships as a `scripts/*.mjs` verify step, and standing rule **33** is that such a guard
 * has no tier of its own — mutating it leaves the whole suite green — so it gets a real test. Two
 * halves: the pure functions driven on synthetic inputs, and the shipped CLI spawned against the
 * real tree, which is the artefact `pnpm run -s verify` runs.
 *
 * **What each case is here to kill**, because a notices generator has four ways to be quietly
 * wrong and only the first has a symptom:
 *
 *  1. it can be stale, which `--check` catches;
 *  2. it can **omit** a dependency — a walk that misses an edge produces a shorter file that still
 *     looks complete, so the closure is asserted against a lockfile whose expected answer is
 *     written out by hand, in both directions;
 *  3. it can publish a licence nobody read — `SEE LICENSE IN …` and a missing field are both
 *     refused rather than rendered, and the refusal is asserted by name;
 *  4. it can be **host-dependent**, which is the one that would fail only on CI: a platform-specific
 *     package's own manifest must never be read, so the fixture below plants a licence in one that
 *     the output must not contain.
 */
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'notices.mjs');
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'notices-'));
  temporaryDirectories.push(directory);
  return directory;
};

const run = (...args: readonly string[]) =>
  spawnSync(process.execPath, [GUARD, ...args], { encoding: 'utf8' });

describe('the YAML subset a pnpm lockfile is written in', () => {
  it('reads mappings, quoted keys, sequences and document separators', () => {
    const documents = parseYamlDocuments(
      [
        'lockfileVersion: 1',
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        "      '@scope/pkg':",
        '        specifier: ^1',
        '        version: 1.0.0',
        '---',
        'packages:',
        '',
        "  'a@1.0.0':",
        '    os: [linux]',
        '    transitivePeerDependencies:',
        '      - typescript',
        "      - '@types/node'",
      ].join('\n'),
    );
    expect(documents).toHaveLength(2);
    expect(documents[0]).toEqual({
      lockfileVersion: '1',
      importers: { '.': { dependencies: { '@scope/pkg': { specifier: '^1', version: '1.0.0' } } } },
    });
    expect(documents[1]).toEqual({
      packages: {
        'a@1.0.0': { os: '[linux]', transitivePeerDependencies: ['typescript', '@types/node'] },
      },
    });
  });

  it('refuses a lockfile version it was not written against', () => {
    expect(() => parseLockfile("lockfileVersion: '10.0'\n")).toThrow(/unsupported lockfileVersion/);
  });

  it('splits ids and strips the peer suffix a snapshot key carries', () => {
    expect(packageIdOf('better-auth@1.7.3(pg@8.23.0)(react@19.3.0)')).toBe('better-auth@1.7.3');
    expect(splitPackageId('@scope/name@1.2.3')).toEqual({ name: '@scope/name', version: '1.2.3' });
    expect(splitPackageId('name@1.2.3')).toEqual({ name: 'name', version: '1.2.3' });
  });
});

/**
 * A lockfile with one of everything the walk has to get right: a dev dependency that must not be
 * walked, a workspace `link:`, a transitive dependency, an optional peer that pnpm resolves anyway,
 * and a family of platform-specific builds.
 */
const FIXTURE_LOCKFILE = [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      shipped:',
  '        specifier: 1.0.0',
  '        version: 1.0.0',
  "      '@platform/own':",
  '        specifier: workspace:*',
  '        version: link:packages/own',
  '    devDependencies:',
  '      tooling:',
  '        specifier: 9.9.9',
  '        version: 9.9.9',
  '',
  'packages:',
  '',
  "  'shipped@1.0.0':",
  '    resolution: {integrity: sha512-shipped}',
  '',
  "  'nested@2.0.0':",
  '    resolution: {integrity: sha512-nested}',
  '',
  "  'native@3.0.0':",
  '    resolution: {integrity: sha512-native}',
  '',
  "  'native-linux-x64@3.0.0':",
  '    resolution: {integrity: sha512-linux}',
  '    cpu: [x64]',
  '    os: [linux]',
  '',
  "  'native-darwin-arm64@3.0.0':",
  '    resolution: {integrity: sha512-darwin}',
  '    cpu: [arm64]',
  '    os: [darwin]',
  '',
  "  'tooling@9.9.9':",
  '    resolution: {integrity: sha512-tooling}',
  '',
  'snapshots:',
  '',
  "  'shipped@1.0.0':",
  '    dependencies:',
  '      nested: 2.0.0',
  '    optionalDependencies:',
  '      native: 3.0.0',
  '',
  "  'nested@2.0.0': {}",
  '',
  "  'native@3.0.0':",
  '    optionalDependencies:',
  '      native-linux-x64: 3.0.0',
  '      native-darwin-arm64: 3.0.0',
  '',
  "  'native-linux-x64@3.0.0': {}",
  '',
  "  'native-darwin-arm64@3.0.0': {}",
  '',
  "  'tooling@9.9.9': {}",
  '',
].join('\n');

describe('the production closure', () => {
  it('is what the artefacts ship: no dev dependency, no workspace link, variants under their declarer', () => {
    const { ids, variantOf } = productionClosure(parseLockfile(FIXTURE_LOCKFILE));
    // Both directions: an equality, not a `toContain`, so a walk that picks up `tooling@9.9.9`
    // fails as loudly as one that drops `nested@2.0.0`.
    expect(ids).toEqual(['native@3.0.0', 'nested@2.0.0', 'shipped@1.0.0']);
    expect(variantOf).toEqual({
      'native@3.0.0': ['native-darwin-arm64@3.0.0', 'native-linux-x64@3.0.0'],
    });
  });

  it('refuses a lockfile that is not self-consistent', () => {
    expect(() =>
      productionClosure(parseLockfile(FIXTURE_LOCKFILE.replace("  'nested@2.0.0': {}\n\n", ''))),
    ).toThrow(/no snapshot for nested@2.0.0/);
  });

  it('refuses a platform-specific build two packages declare, rather than guessing a family', () => {
    const ambiguous = FIXTURE_LOCKFILE.replace(
      "  'nested@2.0.0': {}",
      ["  'nested@2.0.0':", '    optionalDependencies:', '      native-linux-x64: 3.0.0'].join(
        '\n',
      ),
    );
    expect(() => productionClosure(parseLockfile(ambiguous))).toThrow(
      /native-linux-x64@3\.0\.0 is a platform-specific build declared by .* and /,
    );
  });
});

describe('the licence of a package', () => {
  it('is published when the package declares an SPDX expression', () => {
    expect(resolveLicence('pkg@1.0.0', 'MIT')).toEqual({ licence: 'MIT', note: null });
    expect(resolveLicence('pkg@1.0.0', '(MIT OR CC0-1.0)').licence).toBe('(MIT OR CC0-1.0)');
  });

  it('is refused, by name, when the package points at a file or declares nothing', () => {
    expect(() => resolveLicence('mystery@1.0.0', null)).toThrow(
      /mystery@1\.0\.0 declares null, which is not an SPDX expression/,
    );
    expect(() => resolveLicence('mystery@1.0.0', 'SEE LICENSE IN LICENSE.md')).toThrow(
      /not an SPDX expression/,
    );
  });

  it('is the decided one for a package somebody has read the terms of', () => {
    // The two in this tree, asserted through the shipped table rather than a copy of it.
    const sdk = resolveLicence(
      '@anthropic-ai/claude-agent-sdk@0.3.267',
      'SEE LICENSE IN README.md',
    );
    expect(sdk.licence).toMatch(/\[unverified\] proprietary/);
    expect(sdk.note).toMatch(/Anthropic PBC/);
    expect(resolveLicence('awilix-manager@7.0.1', null).licence).toBe('MIT');
  });

  it('refuses an entry that has outlived the declaration it was written for', () => {
    expect(() => resolveLicence('awilix-manager@7.0.1', 'MIT')).toThrow(
      /still has a NON_SPDX_DECLARATIONS entry; remove the entry/,
    );
  });

  it('refuses to report on an install that is not the lockfile’s', () => {
    expect(() =>
      readDeclaredLicences(['not-installed@1.0.0'], join(repositoryRoot, 'node_modules')),
    ).toThrow(/not-installed@1\.0\.0 is in the lockfile's production closure and not in/);
  });
});

describe('the pinned artefacts of the build files', () => {
  const fixtureRoot = (): string => {
    const root = scratch();
    mkdirSync(join(root, 'docker'));
    writeFileSync(
      join(root, 'docker', 'a.Dockerfile'),
      [
        'ARG NODE_IMAGE=node:24-trixie-slim@sha256:deadbeef',
        'ARG TOOL_VERSION=1.2.3',
        'ARG TOOL_URL=https://example.invalid/tool',
        'ARG APP_COMMIT=',
        'ARG NOT_PINNED=something',
        'RUN echo ARG DECOY_VERSION=9',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'compose.yml'),
      [
        'services:',
        '  db:',
        '    image: postgres:18@sha256:abc',
        '  app:',
        '    image: platform:${PLATFORM_TAG:-dev}',
        '    environment:',
        '      APP_WORKSPACE_GIT_IMAGE: ${APP_WORKSPACE_GIT_IMAGE:-alpine/git:v2.49.1}',
        '      APP_WORKSPACE_RUNTIME_IMAGE: platform-runtime:${PLATFORM_TAG:-dev}',
      ].join('\n'),
    );
    return root;
  };

  it('are read off the Dockerfiles and the compose file, with the digest stripped from the key', () => {
    const pinned = scanPinnedArtefacts(fixtureRoot());
    expect([...pinned.keys()].sort()).toEqual([
      'NODE_IMAGE',
      'TOOL_URL',
      'TOOL_VERSION',
      'alpine/git:v2.49.1',
      'platform-runtime:${PLATFORM_TAG:-dev}',
      'platform:${PLATFORM_TAG:-dev}',
      'postgres:18',
    ]);
    // The digest is part of the artefact and not of its identity, so it survives into the value a
    // reader sees while a Renovate bump does not fail the generator.
    expect([...(pinned.get('postgres:18')?.pins ?? [])]).toEqual(['postgres:18@sha256:abc']);
    expect([...(pinned.get('NODE_IMAGE')?.files ?? [])]).toEqual(['docker/a.Dockerfile']);
  });

  it('are compared with the declared table in both directions', () => {
    const pinned = scanPinnedArtefacts(fixtureRoot());
    expect(() => assertPinnedArtefactsAgree(pinned, {})).toThrow(
      /the build files pin artefacts scripts\/notices\.mjs has no entry for: NODE_IMAGE/,
    );
    const everything = Object.fromEntries(
      [...pinned.keys()].map((key) => [key, { ours: 'fixture' }]),
    );
    expect(() =>
      assertPinnedArtefactsAgree(pinned, { ...everything, GONE_VERSION: { ours: 'fixture' } }),
    ).toThrow(/names artefacts no build file mentions any more: GONE_VERSION/);
    expect(() => assertPinnedArtefactsAgree(pinned, everything)).not.toThrow();
  });
});

describe('the rendered document', () => {
  it('never reads a platform-specific package’s own manifest', () => {
    // The case that would only fail on CI: `native-linux-x64` is not installed on a mac and
    // `native-darwin-arm64` is not installed on Linux, so a generator that read either would emit a
    // different file on each. The planted string is what such a generator would print.
    const { ids, variantOf } = productionClosure(parseLockfile(FIXTURE_LOCKFILE));
    const rendered = renderNotices({
      ids,
      variantOf,
      declared: {
        'shipped@1.0.0': 'MIT',
        'nested@2.0.0': 'ISC',
        'native@3.0.0': 'Apache-2.0',
        // Planted on the variants themselves: a generator that read a variant's manifest would print it.
        'native-linux-x64@3.0.0': 'WOULD-BE-READ-FROM-THE-VARIANT',
        'native-darwin-arm64@3.0.0': 'WOULD-BE-READ-FROM-THE-VARIANT',
      },
      pinned: new Map(),
    });
    expect(rendered).toContain('| `native-linux-x64` | 3.0.0 | `native` |');
    expect(rendered).toContain('| `native-darwin-arm64` | 3.0.0 | `native` |');
    expect(rendered).not.toContain('WOULD-BE-READ-FROM-THE-VARIANT');
    // …and the family's own licence is stated once, in the package table.
    expect(rendered).toContain('| `native` | 3.0.0 | Apache-2.0 |');
    expect(rendered).toContain('| ISC | 1 |');
  });
});

describe('the shipped CLI', () => {
  it('passes on this tree and says what it accounted for', () => {
    const result = run('--check');
    expect(`${result.status} ${result.stdout.trim()}`).toMatch(
      /^0 PASS: notices:check \(\d+ npm packages, \d+ pinned artefacts, up to date\)$/,
    );
  });

  it('is deterministic: two renders of one tree are byte-identical, and equal what is committed', () => {
    const first = join(scratch(), 'one.md');
    const second = join(scratch(), 'two.md');
    expect(run('--out', first).status).toBe(0);
    expect(run('--out', second).status).toBe(0);
    const committed = readFileSync(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    expect(readFileSync(first, 'utf8')).toBe(readFileSync(second, 'utf8'));
    expect(readFileSync(first, 'utf8')).toBe(committed);
  });

  it('fails, with a verdict line and a non-zero status, when the committed file is stale', () => {
    const directory = scratch();
    const output = join(directory, 'THIRD_PARTY_NOTICES.md');
    cpSync(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), output);
    writeFileSync(output, `${readFileSync(output, 'utf8')}\nan edit nobody generated\n`);
    const stale = run('--check', '--out', output);
    expect(`${stale.status} ${stale.stdout.trim()}`).toBe('1 FAIL: notices:check');
    expect(stale.stderr).toMatch(/is stale — run `pnpm run -s notices`/);

    rmSync(output);
    const absent = run('--check', '--out', output);
    expect(`${absent.status} ${absent.stdout.trim()}`).toBe('1 FAIL: notices:check');
    expect(absent.stderr).toMatch(/does not exist/);
  });
});
