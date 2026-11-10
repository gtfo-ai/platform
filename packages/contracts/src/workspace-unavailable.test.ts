import { describe, expect, it } from 'vitest';
import {
  classifyWorkspaceFailure,
  firstLineOf,
  WORKSPACE_UNAVAILABLE_CAUSES,
  WORKSPACE_UNAVAILABLE_DETAIL_MAX_CHARS,
  workerRunReleaseRequestSchema,
} from './index.js';

describe('why a machine cannot provision a workspace (S-28.12)', () => {
  it.each([
    [
      'docker_networks_exhausted',
      'Docker engine answered 400: all predefined address pools have been fully subnetted',
    ],
    [
      'docker_networks_exhausted',
      'could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network',
    ],
    ['disk_full', 'write /var/lib/docker/tmp/x: no space left on device'],
    [
      'image_missing',
      'Docker engine answered 404: No such image: ghcr.io/acme/platform-runtime@sha256:aa',
    ],
    ['image_missing', 'pull access denied for platform-runtime, repository does not exist'],
    ['docker_unreachable', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'],
    ['docker_unreachable', 'Docker engine request timed out'],
    ['unknown', 'helper prep-1234 exited 1'],
    ['unknown', ''],
  ] as const)('reads %s off “%s”', (cause, text) => {
    expect(classifyWorkspaceFailure(text)).toBe(cause);
  });

  it('names a cause for every rule and a fallback, in a closed vocabulary', () => {
    expect(WORKSPACE_UNAVAILABLE_CAUSES).toEqual([
      'docker_networks_exhausted',
      'docker_unreachable',
      'image_missing',
      'disk_full',
      'unknown',
    ]);
  });

  it('keeps the first non-empty line, bounded', () => {
    expect(firstLineOf('\n  Docker engine answered 400: x\nsecond line')).toBe(
      'Docker engine answered 400: x',
    );
    expect(firstLineOf('   \n')).toBeNull();
    expect(firstLineOf('y'.repeat(900))?.length).toBe(WORKSPACE_UNAVAILABLE_DETAIL_MAX_CHARS);
  });

  it('lets only a provision_failed release carry the cause, and an older worker’s release stay valid', () => {
    const base = { epoch: 1 };
    expect(
      workerRunReleaseRequestSchema.safeParse({
        ...base,
        reason: 'provision_failed',
        workspace: { cause: 'disk_full', detail: null },
      }).success,
    ).toBe(true);
    expect(
      workerRunReleaseRequestSchema.safeParse({ ...base, reason: 'provision_failed' }).success,
    ).toBe(true);
    expect(
      workerRunReleaseRequestSchema.safeParse({
        ...base,
        reason: 'shutdown',
        workspace: { cause: 'disk_full', detail: null },
      }).success,
    ).toBe(false);
    expect(
      workerRunReleaseRequestSchema.safeParse({
        ...base,
        reason: 'provision_failed',
        workspace: { cause: 'gremlins', detail: null },
      }).success,
    ).toBe(false);
  });
});
