/**
 * The e2e fixture's refusal of a stale run image (WP-169, PROGRESS backlog 504), against a `docker`
 * double — pure, so it runs in the unit tier. The real daemon's answer is the provider's
 * `#assertRunletProtocol`, which this check runs ahead of so a stale image fails a file once.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUNLET_PROTOCOL_IMAGE_LABEL, RUNLET_PROTOCOL_VERSION } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  assertRuntimeImageProtocol,
  BUILD_IMAGES_COMMAND,
} from '../test/e2e/support/runtime-image-protocol.js';

const IMAGE = 'platform-runtime:example';

/** A daemon whose image inspection answers `labels` as `--format '{{json .Config.Labels}}'` does. */
const daemon = (labels: Record<string, string> | null) => {
  const calls: string[][] = [];
  const docker = async (args: readonly string[]) => {
    calls.push([...args]);
    return { ok: true, stdout: JSON.stringify(labels), stderr: '' };
  };
  return { calls, docker };
};

const OTHER_LABELS = { 'org.opencontainers.image.title': 'platform-runtime' };

describe('the fixture refuses a run image that does not declare this checkout’s shim protocol', () => {
  it.each([
    ['no labels at all', null, 'none'],
    ['labels, but not the protocol one', OTHER_LABELS, 'none'],
    ['a protocol label that is not a number', { [RUNLET_PROTOCOL_IMAGE_LABEL]: 'three' }, 'none'],
    [
      'another protocol',
      { ...OTHER_LABELS, [RUNLET_PROTOCOL_IMAGE_LABEL]: String(RUNLET_PROTOCOL_VERSION - 1) },
      String(RUNLET_PROTOCOL_VERSION - 1),
    ],
    // Two spellings that begin like the right one (WP-169 review round 1): a prefix compare or a
    // pattern that admits a leading zero would accept them.
    [
      'a protocol that starts with this one',
      { [RUNLET_PROTOCOL_IMAGE_LABEL]: `${RUNLET_PROTOCOL_VERSION}0` },
      `${RUNLET_PROTOCOL_VERSION}0`,
    ],
    [
      'this protocol with a leading zero',
      { [RUNLET_PROTOCOL_IMAGE_LABEL]: `0${RUNLET_PROTOCOL_VERSION}` },
      'none',
    ],
  ])(
    '%s: one inspection, one error naming the image, both numbers and the command',
    async (_, labels, declared) => {
      const { calls, docker } = daemon(labels);
      const failure = await assertRuntimeImageProtocol(docker, IMAGE).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain(IMAGE);
      expect(message).toContain(`declares shim protocol ${declared} `);
      expect(message).toContain(`speaks protocol ${RUNLET_PROTOCOL_VERSION}`);
      expect(message).toContain(BUILD_IMAGES_COMMAND);
      expect(calls).toEqual([['image', 'inspect', '--format', '{{json .Config.Labels}}', IMAGE]]);
    },
  );

  it('accepts an image that declares exactly this checkout’s protocol', async () => {
    const { calls, docker } = daemon({
      ...OTHER_LABELS,
      [RUNLET_PROTOCOL_IMAGE_LABEL]: String(RUNLET_PROTOCOL_VERSION),
    });
    await expect(assertRuntimeImageProtocol(docker, IMAGE)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('is asked by the fixture after the images are ensured and before anything is created', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../test/e2e/support/docker-workspace.ts', import.meta.url)),
      'utf8',
    );
    const ensured = source.indexOf('await ensureImages(images);');
    const asked = source.indexOf(
      'await assertRuntimeImageProtocol(docker, providerImages.runtime);',
    );
    // The first thing after the check that touches the daemon's objects (it removes stale ones).
    const swept = source.indexOf('await sweepStaleHarnessResources(docker);');
    expect([ensured, asked, swept].every((at) => at >= 0)).toBe(true);
    expect(ensured).toBeLessThan(asked);
    expect(asked).toBeLessThan(swept);
  });
});
