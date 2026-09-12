/**
 * TD-021's "only component that can reach the Docker socket", as a claim about **this repository's
 * own sources** — read off disk (WP-15g).
 *
 * ## Why this shape, and not a deny-list
 *
 * Standing rule **55** was earned in this exact area: WP-14's `assertSafeBindSource` blocked
 * `/etc`, `/var/run` and `/run`, all three of which are *symlinks* on the platform it runs on, so
 * the forbidden branch never fired at all while `$HOME` and `~/.docker/run/docker.sock` were
 * accepted — and a reviewer read `id_ed25519` out of a workspace container. *A deny-list is a claim
 * about the platform's layout, not about intent.* So this asserts the **positive** property
 * instead, over the repository rather than over a deployment: a Docker client is constructed in
 * exactly one file, `DOCKER_HOST` is read in exactly one file, and both are under
 * `apps/launcher/src/`.
 *
 * TD-021's WP-15g amendment asks for precisely this, in the shape of
 * `packages/integrations/src/providers/delivery-key-redaction.test.ts`: the **scope comes from
 * `git ls-files`**, not from a list maintained here (standing rule 7), so a new package, app or
 * script is inside it the moment it exists.
 *
 * ## What it proves, and what it cannot
 *
 * It proves that no *other* source in this repository constructs a Docker client or reads the
 * daemon's address — which is what makes "the process that composes the pipeline and serves
 * `/webhooks/*` has no Docker client" checkable rather than hoped for. It proves nothing about the
 * deployment: a compose file that binds the socket into the API container, or a `docker` CLI call
 * through `execFile`, is invisible here. The container half is WP-22's, over the compose file.
 *
 * Three further gaps, stated because a guard whose limits are not written down is trusted past
 * them:
 *
 *  - **Indirection defeats it.** `const E = workspace.DockerEngine; new E({…})`, a dynamic
 *    `await import`, or `Reflect.construct` are not matched. This is a syntactic check, like
 *    `apps/web/src/no-html.test.ts`, and it lists what it catches rather than claiming closure.
 *  - **The test tiers are excluded on purpose**, and that is a real hole rather than a tidy-up: a
 *    test *must* construct an engine to verify the adapter (`workspace/engine.test.ts`,
 *    `workspace/provider.test.ts`, `test/e2e/support/docker-workspace.ts` all do), and a test does
 *    not ship in an image. A production leak written *inside* a `*.test.ts` file would pass.
 *  - **Comments are stripped crudely** (a `*`-prefixed line, and everything after a `//`), so a
 *    string literal containing `//` loses its tail. The failure direction of that is a false
 *    *negative* only for a construction written after a `//` on the same line as code, which is not
 *    a spelling this repository's formatter produces; the common direction — prose naming
 *    `DOCKER_HOST` in a docblock — is stripped, because a guard that fires on legitimate content
 *    gets switched off.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();

/** Every tracked source git knows about — the scope, asked of git rather than carried (rule 7). */
const trackedSources = (): string[] =>
  execFileSync('git', ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.mjs', '*.js'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file.length > 0);

/**
 * A test-tier file, which is allowed to construct an engine because that is how the adapter is
 * verified. Named by path rather than by content: `test/` is a tier, `*.test.ts` is a tier, and
 * `testing.ts`/`fixtures.ts` beside a source are technical/10's first-class fakes.
 */
const isTestTier = (file: string): boolean =>
  file.startsWith('test/') ||
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) ||
  /(?:^|\/)(?:testing|fixtures)\.ts$/.test(file);

/** Crude comment stripping; the docblock above states what it trades. */
const withoutComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        return '';
      }
      const comment = line.indexOf('//');
      return comment < 0 ? line : line.slice(0, comment);
    })
    .join('\n');

/** `new DockerEngine`, `new workspace.DockerEngine`, and a subclass of either. */
const CONSTRUCTS_ENGINE = /\b(?:new|extends)\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?\w*DockerEngine\b/;
const READS_DOCKER_HOST = /\bDOCKER_HOST\b/;

const filesMatching = (pattern: RegExp): string[] =>
  trackedSources()
    .filter((file) => !isTestTier(file))
    .filter((file) => {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      // Read the whole file, then strip: a pattern applied per line would miss a construction the
      // formatter wrapped, which is standing rule 58's recall hole.
      return pattern.test(withoutComments(source));
    })
    .sort();

/** Does this path ship in an image? `apps/` and `packages/` do; `scripts/` is run by hand. */
const isShippedRing = (file: string): boolean =>
  file.startsWith('apps/') || file.startsWith('packages/');

describe('TD-021: exactly one component reaches the Docker daemon', () => {
  it('constructs a Docker client in one file, and it is the launcher’s composition root', () => {
    // The strong claim, and it has no exceptions: `scripts/` is **in** scope here, and the two
    // launcher verification scripts pass it because they compose `buildLauncher` rather than
    // assembling a provider of their own.
    expect(filesMatching(CONSTRUCTS_ENGINE)).toEqual(['apps/launcher/src/runtime.ts']);
  });

  /**
   * **In the rings that ship, `DOCKER_HOST` is read in exactly one file.**
   *
   * The scope is narrower than the claim above and the difference is stated rather than convenient: a
   * `scripts/*.mjs` is a verification tool a human runs, not a process a compose file starts, and two
   * of them legitimately name the variable (`runlet-launcher-check.mjs` bind-mounts the socket it
   * names into the container it starts; `runlet-launcher-inner.mjs` hands it to `buildLauncher`).
   * Neither *constructs* a client, which is the property that survives an RCE and is asserted above
   * with no exceptions at all.
   *
   * The second expectation is a **census, not an allow-list**: it fails when the set changes in either
   * direction, so a new script that reads the daemon's address is a visible diff rather than a
   * suppressed one (standing rule 7's corollary — an allow-list drifts silently).
   */
  it('reads DOCKER_HOST in one shipped file, and names every script that reads it', () => {
    const readers = filesMatching(READS_DOCKER_HOST);
    expect(readers.filter(isShippedRing)).toEqual(['apps/launcher/src/config.ts']);
    expect(readers.filter((file) => !isShippedRing(file))).toEqual([
      'scripts/runlet-launcher-check.mjs',
      'scripts/runlet-launcher-inner.mjs',
    ]);
  });

  /**
   * The instrument, before the claims (standing rule 21): a check that reads the repository must be
   * shown to be *able* to see a construction at all, or "exactly one file" is a statement about a
   * regex that matches nothing. Four spellings, including the two `apps/launcher/src/runtime.ts` and
   * `test/e2e/support/docker-workspace.ts` actually use.
   */
  it.each([
    ['a bare construction', 'const engine = new DockerEngine({});'],
    ['a namespaced construction', 'const engine = new workspace.DockerEngine({ logger });'],
    ['a subclass', 'export class Recording extends workspace.DockerEngine {}'],
    ['a construction the formatter wrapped', 'const e = new\n  workspace.DockerEngine({});'],
  ])('sees %s', (_label, source) => {
    expect(CONSTRUCTS_ENGINE.test(withoutComments(source))).toBe(true);
  });

  it('does not see a docblock that merely names the variable or the class', () => {
    expect(
      READS_DOCKER_HOST.test(withoutComments(' * `DOCKER_HOST` is tool-native on purpose.')),
    ).toBe(false);
    expect(
      CONSTRUCTS_ENGINE.test(withoutComments('// `new DockerEngine` stores an address.')),
    ).toBe(false);
  });

  it('has a non-empty scope, so neither claim above can pass over nothing', () => {
    // The two `expect(...).toEqual([one file])` cases above would also pass if `git ls-files`
    // returned nothing and every file were filtered out — they would just be empty-versus-one and
    // fail, but only by accident of the expectation. This is the positive statement.
    const sources = trackedSources();
    expect(sources.length).toBeGreaterThan(400);
    expect(sources.filter((file) => !isTestTier(file)).length).toBeGreaterThan(300);
  });
});
