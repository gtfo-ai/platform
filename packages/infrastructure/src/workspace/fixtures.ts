/**
 * Workspace fixtures shared by the unit, contract and e2e tiers.
 *
 * One builder, so the shared contract suite drives both implementations with the same spec and a
 * divergence cannot hide in a test's own literal. The defaults are TD-021's project defaults
 * shrunk to what a test machine can afford; the shape is the production one.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkspaceSpec } from '@platform/application';

/**
 * A temporary directory short enough to hold a Unix socket path.
 *
 * `os.tmpdir()` on macOS is `/var/folders/<2>/<28>/T`, which leaves 40 characters for the 45 that
 * `<uuid>/ctl.sock` needs — and the failure is `EINVAL` from `connect`, which reads like a
 * protocol fault rather than a path that is four characters too long
 * (`names.ts` § `MAX_UNIX_SOCKET_PATH`). Tests that build a control root therefore use this.
 */
export const shortTempDir = async (prefix: string): Promise<string> => {
  const root = process.platform === 'win32' ? tmpdir() : '/tmp';
  return mkdtemp(path.join(root, prefix));
};

export const FIXTURE_RUN_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
export const FIXTURE_PROJECT_ID = '9f8a1c22-6f3f-4c07-8f61-3a2f6b19bb01';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export const workspaceSpecFixture = (
  overrides: DeepPartial<WorkspaceSpec> = {},
): WorkspaceSpec => ({
  runId: FIXTURE_RUN_ID,
  projectId: FIXTURE_PROJECT_ID,
  ...overrides,
  repo: {
    url: 'git://fixture-repo/acme.git',
    defaultBranch: 'main',
    checkoutBranch: null,
    cacheKey: 'acme',
    ...overrides.repo,
  },
  limits: {
    cpus: 1,
    memoryMb: 512,
    pidsLimit: 256,
    tmpfsMb: 64,
    stopGraceSeconds: 20,
    ...overrides.limits,
  },
  egress: {
    hosts: ['registry.npmjs.org', 'api.anthropic.com'],
    connectPorts: [443],
    ...overrides.egress,
  },
  runtime: overrides.runtime ?? 'runc',
  readOnly: overrides.readOnly ?? false,
  env: (overrides.env as Record<string, string> | undefined) ?? { CI: 'true' },
  keepUntil: overrides.keepUntil ?? '2026-09-13T00:00:00.000Z',
});
