/**
 * Who may make a run's egress sidecar log the hosts it **allowed** — WP-140, counted off disk.
 *
 * `renderEgressConfig`'s `logAllowedConnects` renders `LogLevel Connect`, under which tinyproxy logs
 * every request line. It exists for one reader, the real-model pre-flight of
 * `scripts/launcher-control-plane-check.mjs`, which asks which hosts a logged-in CLI contacts
 * (PROGRESS backlog 137). A production sidecar stays at `Notice`: a request line is a URL, and a URL
 * is a place a run can write a value of its choosing into the platform's logs. The ruling is that
 * **no server configuration can set it**, which is a statement about every *other* file — so it is
 * held here, as a census, rather than in the file that makes the option (standing rule 44).
 *
 * Scope: every file git knows about, tracked or untracked (rule 85), in the languages and
 * configuration formats a setting could arrive through — TypeScript, the plain scripts, compose and
 * workflow YAML, the Dockerfiles and `.env.example`. Test tiers are excluded (a test drives the
 * option directly), and comments are stripped from code, so a docblock that *names* the option is
 * not a site. It is syntactic: it sees the option's spellings and the rendered directive, and does
 * not see one assembled from pieces or reached through a computed key.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/** The option's spellings, and the directive itself. */
const SPELLINGS = /logAllowedConnects|LogAllowedConnects|LOG_ALLOWED_CONNECTS|LogLevel Connect/;

/**
 * The files allowed to spell it, and what each is. The renderer and the provider **declare and
 * apply** it; the launcher's `buildLauncher` **forwards** it from a parameter that is not
 * configuration (`BuildLauncherOptions`, which `index.ts` fills with `env` and `uid` alone); the two
 * check scripts are the **one caller** — the check asks its launcher container for it with a
 * `CHECK_*` variable the product never reads.
 */
const EXPECTED_SITES: readonly string[] = [
  'apps/launcher/src/runtime.ts',
  'packages/infrastructure/src/workspace/egress.ts',
  'packages/infrastructure/src/workspace/provider.ts',
  'scripts/launcher-control-plane-check.mjs',
  'scripts/launcher-control-plane-launcher.mjs',
];

const CODE = /\.(?:[cm]?[jt]sx?)$/;

const isTestTier = (file: string): boolean =>
  file.startsWith('test/') ||
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) ||
  /(?:^|\/)(?:testing|fixtures)\.ts$/.test(file);

const candidates = (): string[] =>
  censusPaths(REPO_ROOT, {
    pathspecs: [
      '*.ts',
      '*.tsx',
      '*.mjs',
      '*.js',
      '*.yml',
      '*.yaml',
      '*.Dockerfile',
      '.env.example',
    ],
  }).filter((file) => !isTestTier(file));

const sitesOf = (files: readonly string[]): string[] =>
  files
    .filter((file) => {
      const text = censusText(REPO_ROOT, file);
      return SPELLINGS.test(CODE.test(file) ? withoutComments(text) : text);
    })
    .sort();

describe('the check-only egress log level (WP-140)', () => {
  it('is spelled only by the renderer, the provider, the launcher’s forwarder and the check', () => {
    expect(sitesOf(candidates())).toEqual(EXPECTED_SITES);
  });

  it('is read from no environment variable of the product: the launcher’s config, its entrypoint and every compose file are silent', () => {
    const product = candidates().filter(
      (file) =>
        file === 'apps/launcher/src/config.ts' ||
        file === 'apps/launcher/src/index.ts' ||
        file.startsWith('apps/server/') ||
        /^compose[^/]*\.ya?ml$/.test(file) ||
        file === '.env.example',
    );
    // The census must have found the files it speaks for, or it is a census of nothing.
    expect(product).toEqual(
      expect.arrayContaining([
        'apps/launcher/src/config.ts',
        'apps/launcher/src/index.ts',
        'compose.yml',
        'compose.local.yml',
        '.env.example',
      ]),
    );
    expect(sitesOf(product)).toEqual([]);
  });

  it('would see a new site: a planted spelling is found by the same scan', () => {
    expect(SPELLINGS.test(withoutComments('const x = { logAllowedConnects: true };'))).toBe(true);
    expect(SPELLINGS.test(withoutComments('// logAllowedConnects in a comment'))).toBe(false);
    expect(SPELLINGS.test('APP_EGRESS_LOG_ALLOWED_CONNECTS=1')).toBe(true);
  });
});
