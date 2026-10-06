/**
 * WP-151 criterion (3), TD-025's M9 amendment: **the run image's protocol label cannot be a
 * hand-written number.** The launcher refuses a create whose image declares another shim protocol
 * than the requesting runner's (`packages/infrastructure/src/workspace/provider.ts`), so the label is
 * only worth reading if it is the constant the image's shim was bundled from. Three things make it
 * so, and each is read here off disk:
 *
 *  1. `docker/runtime.Dockerfile` writes the label from the build argument `RUNLET_PROTOCOL` and
 *     nothing else, declares that argument with **no default**, and its `shim` stage refuses an
 *     argument that is not the `RUNLET_PROTOCOL_VERSION` line of the source it bundles — the `sed`
 *     that check runs is taken out of the Dockerfile and run here against the real source;
 *  2. `scripts/build-images.mjs` passes the argument to the run image, from `readRunletProtocol`;
 *  3. `readRunletProtocol` answers the constant TypeScript sees.
 *
 * What it cannot see: an image built by hand with `docker build --build-arg RUNLET_PROTOCOL=3` from
 * a checkout whose constant is 3 is correct by construction, and one built with another number fails
 * at the `shim` stage's check, which only a real build exercises (`build-images.mjs` also reads the
 * label back off the built image).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNLET_PROTOCOL_IMAGE_LABEL, RUNLET_PROTOCOL_VERSION } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { RUNLET_PROTOCOL_SOURCE, readRunletProtocol } from './runlet-protocol.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = readFileSync(path.join(REPO, 'docker/runtime.Dockerfile'), 'utf8');
const BUILD_IMAGES = readFileSync(path.join(REPO, 'scripts/build-images.mjs'), 'utf8');
/** `${RUNLET_PROTOCOL}` as the two files spell it — a reference to the argument, not a value. */
const ARGUMENT = '\u0024{RUNLET_PROTOCOL}';

/** The Dockerfile's instructions, comments dropped and continuation lines joined. */
const instructions = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** Which `FROM … AS <stage>` each instruction belongs to. */
const byStage = (lines: readonly string[]): Map<string, string[]> => {
  const stages = new Map<string, string[]>();
  let current = '(none)';
  for (const line of lines) {
    const from = /^FROM\s+\S+\s+AS\s+(\S+)$/i.exec(line);
    if (from !== null) {
      current = from[1] as string;
      stages.set(current, []);
      continue;
    }
    stages.get(current)?.push(line);
  }
  return stages;
};

describe('the run image’s shim protocol label (WP-151)', () => {
  const lines = instructions(DOCKERFILE);
  const stages = byStage(lines);

  it('reads the constant TypeScript sees', () => {
    expect(readRunletProtocol(REPO)).toBe(RUNLET_PROTOCOL_VERSION);
  });

  it('writes the label from the build argument alone, never from a number written in the file', () => {
    const labelled = lines.filter((line) => line.includes(RUNLET_PROTOCOL_IMAGE_LABEL));
    expect(labelled).toEqual([`LABEL ${RUNLET_PROTOCOL_IMAGE_LABEL}="${ARGUMENT}"`]);
    // In the image's own stage, whose argument is re-declared there (an `ARG` is per stage).
    expect(stages.get('runtime')).toContain(labelled[0]);
    expect(stages.get('runtime')).toContain('ARG RUNLET_PROTOCOL');
  });

  it('declares the argument with no default, so a build that does not pass it cannot pick one', () => {
    const declarations = lines.filter((line) => /^ARG\s+RUNLET_PROTOCOL\b/.test(line));
    expect(declarations.length).toBeGreaterThan(0);
    expect(declarations.every((line) => line === 'ARG RUNLET_PROTOCOL')).toBe(true);
  });

  it('checks the argument against the source the shim stage bundles, with a sed that reads the constant', () => {
    const shim = stages.get('shim') ?? [];
    expect(shim).toContain('ARG RUNLET_PROTOCOL');
    const check = shim.find((line) => line.includes(RUNLET_PROTOCOL_SOURCE));
    expect(check).toBeDefined();
    // The check comes after the bundle is built from that source, in the same stage.
    expect(shim.indexOf(check as string)).toBeGreaterThan(
      shim.findIndex((line) => line.includes('@platform/runlet run build')),
    );
    // `:-`, so a build that passed no argument is told so by name rather than by `set -u`.
    expect(check).toContain('"$declared" != "\u0024{RUNLET_PROTOCOL:-}"');
    expect(check).toContain('exit 1');
    // The `sed` script, run here exactly as the Dockerfile spells it, against the real source.
    const script = /sed -n '([^']+)' /.exec(check as string)?.[1];
    expect(script).toBeDefined();
    const answer = execFileSync('sed', ['-n', script as string, RUNLET_PROTOCOL_SOURCE], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(answer.trim()).toBe(String(RUNLET_PROTOCOL_VERSION));
  });

  it('is passed to the run image by build-images.mjs, from the reader, and read back off the image', () => {
    expect(BUILD_IMAGES).toContain("import { readRunletProtocol } from './runlet-protocol.mjs';");
    expect(BUILD_IMAGES).toContain('const RUNLET_PROTOCOL = readRunletProtocol(REPO);');
    expect(BUILD_IMAGES).toContain(`\`RUNLET_PROTOCOL=${ARGUMENT}\``);
    expect(BUILD_IMAGES).toContain(
      `const RUNLET_PROTOCOL_LABEL = '${RUNLET_PROTOCOL_IMAGE_LABEL}';`,
    );
    const runtime = /\{\s*name: 'platform-runtime',[^}]*\}/.exec(BUILD_IMAGES)?.[0] ?? '';
    expect(runtime).toContain('runletProtocol: true');
    // No other image is handed the argument.
    expect(BUILD_IMAGES.match(/runletProtocol: true/g)).toHaveLength(1);
  });
});
