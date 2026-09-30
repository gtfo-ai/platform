/**
 * The two schemas TD-028 decision 12 added to the control plane's wire format (WP-103).
 *
 * Both are **strict**, and that is the decision worth pinning: the destroy request is empty because
 * the run id is the path and a handle is exactly what its caller does not have, so anything in the
 * body is a caller that thinks it is sending something; and the listing carries exactly the three
 * fields the reaper decides on, bounded, so a launcher cannot hand the runner an unbounded array.
 * The round trip over a real listener is `apps/launcher/src/control-plane.test.ts`'s.
 */
import { MAX_LABELLED_RUNS } from '@platform/application';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_PATHS,
  createRunResponseSchema,
  destroyRunRequestSchema,
  destroyRunResponseSchema,
  listRunsResponseSchema,
  workspaceCliEnvironmentSchema,
} from './protocol.js';

const RUN = '44444444-4444-4444-8444-444444444444';
const entry = { runId: RUN, createdAt: '2026-09-30T10:00:00.000Z', running: false };

describe('the reaper’s verbs on the wire (WP-103)', () => {
  it('names the destroy verb beside end, under the runs path', () => {
    expect(CONTROL_PLANE_PATHS.runs).toBe('/v1/runs');
    expect(CONTROL_PLANE_PATHS.destroy).toBe('destroy');
    expect(CONTROL_PLANE_PATHS.destroy).not.toBe(CONTROL_PLANE_PATHS.end);
  });

  it('accepts only an empty destroy request, so a handle cannot ride along', () => {
    expect(destroyRunRequestSchema.safeParse({}).success).toBe(true);
    expect(destroyRunRequestSchema.safeParse({ handle: { runId: RUN } }).success).toBe(false);
    expect(destroyRunRequestSchema.safeParse(null).success).toBe(false);
  });

  it('answers found as a boolean and nothing else', () => {
    expect(destroyRunResponseSchema.parse({ found: true })).toEqual({ found: true });
    expect(destroyRunResponseSchema.safeParse({ found: true, removed: 3 }).success).toBe(false);
  });

  it('bounds the listing and refuses an entry with a field the reaper does not decide on', () => {
    expect(listRunsResponseSchema.parse({ runs: [entry] })).toEqual({ runs: [entry] });
    expect(
      listRunsResponseSchema.safeParse({
        runs: Array.from({ length: MAX_LABELLED_RUNS }, () => entry),
      }).success,
    ).toBe(true);
    expect(
      listRunsResponseSchema.safeParse({
        runs: Array.from({ length: MAX_LABELLED_RUNS + 1 }, () => entry),
      }).success,
    ).toBe(false);
    expect(listRunsResponseSchema.safeParse({ runs: [{ ...entry, project: 'p' }] }).success).toBe(
      false,
    );
    expect(
      listRunsResponseSchema.safeParse({ runs: [{ ...entry, createdAt: 'yesterday' }] }).success,
    ).toBe(false);
  });
});

/**
 * WP-118 (TD-025's amendment, PROGRESS backlog 342): the container facts the CLI's own environment
 * needs, answered beside `claudeCodePath`. Strict and structured, so nothing but the named facts can
 * cross — in particular no `RUNLET_*` name, which is what the launcher's own environment holds.
 */
describe('the CLI environment on the wire (WP-118)', () => {
  const answer = {
    proxy: { url: `http://egress-${RUN}:8888`, noProxy: 'localhost,127.0.0.1' },
    home: '/tmp',
    claudeConfigDir: '/tmp/claude',
    path: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    gitConfig: [
      { key: 'credential.helper', value: '!agentic-runlet credential --socket /ctl/cred.sock' },
    ],
  };

  it('accepts the launcher’s answer, with and without a sidecar', () => {
    expect(workspaceCliEnvironmentSchema.parse(answer)).toEqual(answer);
    expect(workspaceCliEnvironmentSchema.safeParse({ ...answer, proxy: null }).success).toBe(true);
  });

  it('refuses an unknown key', () => {
    expect(workspaceCliEnvironmentSchema.safeParse({ ...answer, shell: '/bin/sh' }).success).toBe(
      false,
    );
    expect(
      workspaceCliEnvironmentSchema.safeParse({
        ...answer,
        proxy: { ...answer.proxy, ftp: 'http://x:1' },
      }).success,
    ).toBe(false);
  });

  it('refuses a free-form entry: no record of names to values rides in it', () => {
    expect(
      workspaceCliEnvironmentSchema.safeParse({ ...answer, env: { EXTRA: 'value' } }).success,
    ).toBe(false);
    expect(
      workspaceCliEnvironmentSchema.safeParse({
        ...answer,
        gitConfig: [{ key: 'credential.helper', value: 'x', name: 'EXTRA' }],
      }).success,
    ).toBe(false);
    // A value that is not the shape its field names — a path that is not absolute, a URL that is
    // not an internal proxy, a git key that is an environment name.
    expect(workspaceCliEnvironmentSchema.safeParse({ ...answer, home: 'tmp' }).success).toBe(false);
    expect(
      workspaceCliEnvironmentSchema.safeParse({
        ...answer,
        proxy: { ...answer.proxy, url: 'https://proxy.example.com' },
      }).success,
    ).toBe(false);
    expect(
      workspaceCliEnvironmentSchema.safeParse({ ...answer, path: '/usr/bin:relative' }).success,
    ).toBe(false);
  });

  it('refuses a RUNLET_-named variable, wherever it is put', () => {
    for (const smuggled of [
      { ...answer, RUNLET_TOKEN_FILE: '/ctl/token' },
      { ...answer, gitConfig: [{ key: 'RUNLET_TOKEN_FILE', value: '/ctl/token' }] },
      { ...answer, gitConfig: [{ key: 'core.pager', value: 'x\nRUNLET_TOKEN_FILE=/ctl/token' }] },
    ]) {
      expect(workspaceCliEnvironmentSchema.safeParse(smuggled).success).toBe(false);
    }
  });

  it('is a required field of the create answer, beside claudeCodePath', () => {
    const shape = createRunResponseSchema.shape;
    expect(Object.keys(shape)).toContain('cliEnvironment');
    expect(Object.keys(shape)).toContain('claudeCodePath');
    expect(shape.cliEnvironment.safeParse(undefined).success).toBe(false);
  });
});
