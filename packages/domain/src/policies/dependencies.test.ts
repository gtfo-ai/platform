/**
 * The detector and the policy, both ways round (WP-38, acceptance criteria 1 and 2).
 *
 * The cases that matter are the **negative** ones: a detector that fired on every diff would pass
 * every "it found the package" assertion and would ask a human about every change (standing rule
 * 42). So each ecosystem has a diff that adds a package *and* a diff that touches the same file
 * without adding one, and a version bump — the shape a patch expresses as a removal and an addition
 * of the same name — is asserted to be neither.
 */
import type { DependencyPolicyValue } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  boundReportedDependencies,
  classifyDependencyFile,
  classifyUnreadManifest,
  DEFAULT_DEPENDENCY_POLICY,
  DEPENDENCY_ECOSYSTEM_FILES,
  type DependencyPolicyConfig,
  dependencyPolicyFor,
  detectDependencyChanges,
  gateDecisionFor,
  MAX_DETECTED_DEPENDENCIES,
} from './dependencies.js';

/** A patch as a provider sends it: a header, a hunk marker, then the lines. */
const patch = (path: string, ...lines: readonly string[]): { path: string; patch: string } => ({
  path,
  patch: [`--- a/${path}`, `+++ b/${path}`, '@@ -1,4 +1,5 @@', ...lines].join('\n'),
});

const names = (files: readonly { path: string; patch: string }[]): readonly string[] =>
  detectDependencyChanges(files).added.map((entry) => `${entry.ecosystem}:${entry.name}`);

describe('detecting a dependency addition in a diff', () => {
  it('reads a package.json addition, and reads nothing from a package.json that added none', () => {
    const added = patch(
      'package.json',
      '   "dependencies": {',
      '     "react": "^19.0.0",',
      '+    "lodash": "^4.17.21"',
      '   },',
    );
    expect(names([added])).toEqual(['npm:lodash']);

    const scripts = patch(
      'package.json',
      '   "scripts": {',
      '     "build": "tsc",',
      '+    "check": "tsc --noEmit"',
      '   },',
    );
    expect(names([scripts])).toEqual([]);
  });

  it('never reads the file’s own version, its engines or its package manager as a package', () => {
    const noise = patch(
      'package.json',
      '   "name": "acme",',
      '+  "version": "1.4.0",',
      '+  "packageManager": "pnpm@12.3.4",',
      '   "engines": {',
      '+    "node": ">=24"',
      '   },',
    );
    expect(names([noise])).toEqual([]);
  });

  it('reads a version bump as neither an addition nor a removal', () => {
    const bump = patch(
      'package.json',
      '   "dependencies": {',
      '-    "lodash": "^4.17.20",',
      '+    "lodash": "^4.17.21",',
      '   },',
    );
    expect(names([bump])).toEqual([]);
  });

  it('reads the three npm lockfile spellings', () => {
    expect(
      names([
        patch(
          'package-lock.json',
          '+    "node_modules/@scope/pkg": {',
          '+      "version": "1.0.0"',
        ),
      ]),
    ).toEqual(['npm:@scope/pkg']);
    expect(
      names([
        patch('pnpm-lock.yaml', '+  lodash@4.17.21:', '+    resolution: {integrity: sha512-x}'),
      ]),
    ).toEqual(['npm:lodash']);
    expect(names([patch('yarn.lock', '+"@scope/pkg@^1.0.0":', '+  version "1.0.0"')])).toEqual([
      'npm:@scope/pkg',
    ]);
  });

  it('prefers the manifest over the lockfile for the same package, and says which it read', () => {
    const scan = detectDependencyChanges([
      patch('pnpm-lock.yaml', '+  lodash@4.17.21:'),
      patch('package.json', '   "dependencies": {', '+    "lodash": "^4.17.21"'),
    ]);
    expect(scan.added).toEqual([
      { ecosystem: 'npm', name: 'lodash', from: 'manifest', path: 'package.json' },
    ]);
  });

  it('reads a lockfile-only addition as a lockfile one', () => {
    const scan = detectDependencyChanges([patch('pnpm-lock.yaml', '+  tslib@2.6.2:')]);
    expect(scan.added).toEqual([
      { ecosystem: 'npm', name: 'tslib', from: 'lockfile', path: 'pnpm-lock.yaml' },
    ]);
  });

  it('reads the PyPI spellings: requirements, pyproject and the lock', () => {
    expect(
      names([patch('requirements.txt', '+httpx==0.27.0', '+# a comment', '+-r other.txt')]),
    ).toEqual(['pypi:httpx']);
    expect(
      names([patch('pyproject.toml', '   dependencies = [', '+  "flask[async]>=3.0",', '   ]')]),
    ).toEqual(['pypi:flask']);
    expect(
      names([patch('pyproject.toml', '   [tool.poetry.dependencies]', '+  requests = "^2.31"')]),
    ).toEqual(['pypi:requests']);
    expect(
      names([patch('poetry.lock', '   [[package]]', '+name = "anyio"', '+version = "4.4.0"')]),
    ).toEqual(['pypi:anyio']);
    // A `pyproject.toml` whose `[project]` table changed adds nothing.
    expect(names([patch('pyproject.toml', '   [project]', '+version = "1.2.0"')])).toEqual([]);
  });

  it('reads go.mod and go.sum, and neither the module line nor the go directive', () => {
    expect(
      names([
        patch(
          'go.mod',
          '   module example.com/acme',
          '   go 1.23',
          '   require (',
          '+  golang.org/x/text v0.14.0',
          '   )',
        ),
      ]),
    ).toEqual(['go:golang.org/x/text']);
    expect(
      names([
        patch(
          'go.sum',
          '+golang.org/x/text v0.14.0 h1:abc=',
          '+golang.org/x/text v0.14.0/go.mod h1:def=',
        ),
      ]),
    ).toEqual(['go:golang.org/x/text']);
    expect(names([patch('go.mod', '   module example.com/acme', '+go 1.24')])).toEqual([]);
  });

  it('reads Cargo.toml and Cargo.lock, and not the crate’s own version', () => {
    expect(
      names([patch('Cargo.toml', '   [dependencies]', '+serde = { version = "1.0" }')]),
    ).toEqual(['cargo:serde']);
    expect(
      names([patch('Cargo.lock', '   [[package]]', '+name = "serde"', '+version = "1.0.203"')]),
    ).toEqual(['cargo:serde']);
    expect(names([patch('Cargo.toml', '   [package]', '+version = "0.2.0"')])).toEqual([]);
  });

  it('names a manifest it cannot read rather than reporting nothing about it', () => {
    const scan = detectDependencyChanges([
      patch('pom.xml', '+    <artifactId>guava</artifactId>'),
      patch('services/api/Gemfile', '+gem "rails"'),
      patch('src/main.ts', '+import lodash from "lodash";'),
    ]);
    expect(scan.added).toEqual([]);
    expect(scan.unread).toEqual([
      { ecosystem: 'maven', path: 'pom.xml' },
      { ecosystem: 'rubygems', path: 'services/api/Gemfile' },
    ]);
  });

  it('reads nothing at all from a diff that touches no manifest or lockfile', () => {
    const scan = detectDependencyChanges([
      patch('src/app.ts', '+const x = 1;'),
      patch('README.md', '+# Title'),
      patch('docs/package.json.md', '+"lodash": "^4"'),
    ]);
    expect(scan).toEqual({ added: [], unread: [], truncated: false });
  });

  it('reads nothing from a file the provider sent no patch for, and says the diff was cut', () => {
    const scan = detectDependencyChanges([{ path: 'package.json', patch: null }], {
      diffTruncated: true,
    });
    expect(scan.added).toEqual([]);
    expect(scan.truncated).toBe(true);
  });

  it('reports every package it found, uncut, and leaves the bound to the caller', () => {
    const lines = Array.from(
      { length: MAX_DETECTED_DEPENDENCIES + 5 },
      (_, index) => `+  pkg-${index}@1.0.0:`,
    );
    const scan = detectDependencyChanges([patch('pnpm-lock.yaml', ...lines)]);
    // The policy is resolved over **this** list; `boundReportedDependencies` cuts what is reported
    // afterwards (review round 2). `truncated` here is the provider's cut and nothing else.
    expect(scan.added).toHaveLength(MAX_DETECTED_DEPENDENCIES + 5);
    expect(scan.truncated).toBe(false);
  });

  it('classifies a path by ecosystem and by kind, and refuses one it does not know', () => {
    expect(classifyDependencyFile('apps/web/package.json')).toEqual({
      ecosystem: 'npm',
      from: 'manifest',
    });
    expect(classifyDependencyFile('Cargo.lock')).toEqual({ ecosystem: 'cargo', from: 'lockfile' });
    expect(classifyDependencyFile('src/index.ts')).toBeNull();
    expect(classifyUnreadManifest('app/build.gradle.kts')).toBe('gradle');
    expect(classifyUnreadManifest('package.json')).toBeNull();
  });

  it('never invents a name the ecosystem’s own pattern would refuse, whatever the patch says', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (body) => {
        const scan = detectDependencyChanges([
          { path: 'package.json', patch: body },
          { path: 'pyproject.toml', patch: body },
          { path: 'go.mod', patch: body },
          { path: 'Cargo.lock', patch: body },
        ]);
        for (const entry of scan.added) {
          expect(DEPENDENCY_ECOSYSTEM_FILES[entry.ecosystem].name.test(entry.name)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('the policy a package resolves to', () => {
  it('is “ask” for a project that configured nothing (product/18:43)', () => {
    expect(dependencyPolicyFor(undefined, 'npm', 'lodash')).toEqual({
      policy: DEFAULT_DEPENDENCY_POLICY,
      allowlisted: false,
    });
    expect(DEFAULT_DEPENDENCY_POLICY).toBe('ask');
  });

  it('takes the scalar shorthand as the answer for every ecosystem', () => {
    expect(dependencyPolicyFor('block', 'npm', 'lodash').policy).toBe('block');
    expect(dependencyPolicyFor('block', 'go', 'golang.org/x/text').policy).toBe('block');
  });

  it('takes the per-ecosystem value over the default, and the default where none is named', () => {
    const config: DependencyPolicyConfig = {
      default: 'allow',
      ecosystems: { npm: 'block' },
    };
    expect(dependencyPolicyFor(config, 'npm', 'lodash').policy).toBe('block');
    expect(dependencyPolicyFor(config, 'cargo', 'serde').policy).toBe('allow');
  });

  it('lets an allow-listed package through whatever the policy says, and says why', () => {
    const config: DependencyPolicyConfig = {
      default: 'block',
      allowlist: ['npm:@scope/pkg', 'pypi:Flask_SQLAlchemy'],
    };
    expect(dependencyPolicyFor(config, 'npm', '@scope/pkg')).toEqual({
      policy: 'allow',
      allowlisted: true,
    });
    // PEP 503: the two spellings are one project, so the entry covers both.
    expect(dependencyPolicyFor(config, 'pypi', 'flask-sqlalchemy')).toEqual({
      policy: 'allow',
      allowlisted: true,
    });
    // …and the allow-list is per ecosystem: the same name elsewhere is not covered.
    expect(dependencyPolicyFor(config, 'npm', 'flask-sqlalchemy')).toEqual({
      policy: 'block',
      allowlisted: false,
    });
  });

  it('cuts the report at the cap and keeps the package that decided the outcome', () => {
    /**
     * `MAX_DETECTED_DEPENDENCIES` bounds what is **reported**, never what is **decided**, and the
     * two halves of that sentence are both asserted here: the twenty-sixth package is the blocked
     * one, so it is the one the return reason has to be able to name, and it displaces an allowed
     * package rather than being dropped for arriving last (review round 2).
     */
    const resolved = Array.from({ length: MAX_DETECTED_DEPENDENCIES + 1 }, (_, index) => ({
      name: `pkg-${index}`,
      policy: (index === MAX_DETECTED_DEPENDENCIES ? 'block' : 'allow') as DependencyPolicyValue,
    }));

    const bounded = boundReportedDependencies(resolved);

    expect(bounded.reported).toHaveLength(MAX_DETECTED_DEPENDENCIES);
    expect(bounded.truncated).toBe(true);
    const names = bounded.reported.map((entry) => entry.name);
    expect(names).toContain(`pkg-${MAX_DETECTED_DEPENDENCIES}`);
    expect(names).not.toContain(`pkg-${MAX_DETECTED_DEPENDENCIES - 1}`);
    // …and the survivors keep the order they were found in: the list describes the diff, not the
    // cut. `pkg-0` first, the blocked one last, because that is where the detector saw it.
    expect(names[0]).toBe('pkg-0');
    expect(names.at(-1)).toBe(`pkg-${MAX_DETECTED_DEPENDENCIES}`);
  });

  it('does not cut, or claim it did, when the list fits', () => {
    const resolved = Array.from({ length: MAX_DETECTED_DEPENDENCIES }, () => ({
      policy: 'ask' as DependencyPolicyValue,
    }));
    expect(boundReportedDependencies(resolved)).toEqual({ reported: resolved, truncated: false });
  });

  it('takes the strictest answer for the whole scan, and “none” when nothing was added', () => {
    expect(gateDecisionFor([])).toBe('none');
    expect(gateDecisionFor(['allow', 'allow'])).toBe('allow');
    expect(gateDecisionFor(['allow', 'ask'])).toBe('ask');
    expect(gateDecisionFor(['ask', 'block', 'allow'])).toBe('block');
  });
});
