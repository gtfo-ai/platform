import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The repository's own gitleaks rules, run by the pinned binary over text on stdin (WP-280).
 *
 * `platform-worker-credential` recognises a worker credential, `wkr_<26 base32>_<43 base64url>`
 * (TD-031 decision 7). Every value here is **assembled at run time**, so this file is not itself a
 * finding for the repository's scan, and none is a credential anybody issued. A value carrying the
 * `FAKE` marker is exempt by the global allowlist (technical/10's convention), which is asserted too
 * so the exemption is a known property rather than a surprise.
 *
 * No `git` is spawned: `gitleaks stdin` reads nothing but its input and the config.
 */
const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = join(REPOSITORY, 'node_modules', '.bin', 'gitleaks');
const CONFIG = join(REPOSITORY, '.gitleaks.toml');

interface Finding {
  readonly RuleID: string;
  readonly Secret: string;
}

const scan = (text: string): Finding[] => {
  const result = spawnSync(
    BINARY,
    ['stdin', '-c', CONFIG, '--no-banner', '--report-format', 'json', '--report-path', '-'],
    {
      input: text,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    },
  );
  if (result.error !== undefined) {
    throw new Error(`could not run gitleaks: ${result.error.message}`);
  }
  const start = result.stdout.indexOf('[');
  return start < 0 ? [] : (JSON.parse(result.stdout.slice(start)) as Finding[]);
};

const credential = (id: string, secret: string): string => ['wkr', id, secret].join('_');
const ID = 'a'.repeat(13) + '7'.repeat(13);
const SECRET = `Zq3${'x'.repeat(20)}${'Q9'.repeat(10)}`;

describe('the gitleaks rule for a worker credential', () => {
  it('finds the pinned binary', () => {
    expect(existsSync(BINARY)).toBe(true);
  });

  it('reports a worker credential in source, in JSON and at the end of a line', () => {
    for (const text of [
      `const credential = '${credential(ID, SECRET)}';\n`,
      `{"credential":"${credential(ID, SECRET)}"}\n`,
      `AGENTIC_WORKER_CREDENTIAL=${credential(ID, SECRET)}\n`,
    ]) {
      const findings = scan(text).filter(
        (finding) => finding.RuleID === 'platform-worker-credential',
      );
      expect(
        findings.map((finding) => finding.Secret),
        text,
      ).toEqual([credential(ID, SECRET)]);
    }
  }, 30_000);

  it('does not fire on the prefix alone, a short id or a short secret', () => {
    for (const text of [
      'the credential starts with wkr_ and is stored hashed\n',
      `${credential('a'.repeat(25), SECRET)}\n`,
      `${credential(ID, SECRET.slice(1))}\n`,
    ]) {
      expect(
        scan(text).filter((finding) => finding.RuleID === 'platform-worker-credential'),
        text,
      ).toEqual([]);
    }
  }, 30_000);

  it('exempts a value that carries the FAKE marker, as every fixture credential does', () => {
    const fake = credential(ID, `FAKE${'x'.repeat(39)}`);
    expect(scan(`const fixture = '${fake}';\n`)).toEqual([]);
  }, 30_000);
});
