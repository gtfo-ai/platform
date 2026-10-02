/**
 * The runner's half of TD-028's control plane: the wire format and the HTTP client.
 *
 * What is worth asserting here is not "a request was made" — the round trip against a real listener
 * is `control-plane.test.ts`'s, and against real images it is `scripts/launcher-control-plane-check.mjs`'s.
 * It is the three decisions this client makes that nothing else would notice if they regressed: a
 * redirect is refused rather than followed (the request carries `APP_LAUNCHER_TOKEN`), every failure
 * arrives as a `WorkspaceError` whose **code** the stage executor already knows how to act on, and a
 * base URL that is not an `http(s)` address without credentials is refused before a byte is sent.
 */
import { WorkspaceError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { createLauncherControlClient, type LauncherFetch, parseLauncherBaseUrl } from './client.js';
import {
  CONTROL_PLANE_ERROR_CODES,
  CONTROL_PLANE_STATUS_BY_CODE,
  controlPlaneCodeOfStatus,
  workspaceCodeOfControlPlaneCode,
} from './protocol.js';

const TOKEN = 'FAKE-launcher-token-000000000000000';

interface Recorded {
  readonly url: string;
  readonly init: Parameters<LauncherFetch>[1];
}

const clientWith = (
  answer: (recorded: Recorded) => { status: number; body: string } | Promise<never>,
): { client: ReturnType<typeof createLauncherControlClient>; calls: Recorded[] } => {
  const calls: Recorded[] = [];
  const fetch: LauncherFetch = async (url, init) => {
    const recorded = { url, init };
    calls.push(recorded);
    const result = await answer(recorded);
    return { status: result.status, text: async () => result.body };
  };
  return {
    client: createLauncherControlClient({
      baseUrl: 'http://launcher:7780',
      token: TOKEN,
      fetch,
    }),
    calls,
  };
};

const errorBody = (code: string, message: string): string =>
  JSON.stringify({ error: { code, message, runId: null, detail: null } });

describe('the control plane’s error vocabulary', () => {
  /**
   * Both directions (standing rule 42), written out rather than derived.
   *
   * A code with no status would hand `undefined` to `writeHead`; a status the client cannot read
   * back becomes `internal`, and an `internal` is **retryable**, which would make a wrong
   * `APP_LAUNCHER_TOKEN` spin instead of telling somebody. The two collisions — 400 for both
   * `invalid_spec` and `bad_request`, 500 for both `workspace_failed` and `internal` — are
   * deliberate and harmless, and the table below is where that is visible rather than argued.
   */
  it('maps every code to a status, and every status back to a code', () => {
    expect(CONTROL_PLANE_STATUS_BY_CODE).toEqual({
      invalid_spec: 400,
      bad_request: 400,
      unauthorized: 401,
      not_found: 404,
      internal: 500,
      workspace_failed: 500,
      engine_unavailable: 503,
    });
    expect(Object.keys(CONTROL_PLANE_STATUS_BY_CODE).sort()).toEqual(
      [...CONTROL_PLANE_ERROR_CODES].sort(),
    );
    expect(
      Object.values(CONTROL_PLANE_STATUS_BY_CODE).map((status) => controlPlaneCodeOfStatus(status)),
    ).toEqual([
      'bad_request',
      'bad_request',
      'unauthorized',
      'not_found',
      'internal',
      'internal',
      'engine_unavailable',
    ]);
  });

  it('makes a wrong token terminal and an unreachable launcher retryable', () => {
    // The direction that matters: a 401 is a statement about configuration and retrying it hides
    // the mistake, while a 502 from a proxy in front of a restarting launcher passes.
    expect(workspaceCodeOfControlPlaneCode('unauthorized')).toBe('invalid_spec');
    expect(workspaceCodeOfControlPlaneCode('bad_request')).toBe('invalid_spec');
    expect(controlPlaneCodeOfStatus(502)).toBe('engine_unavailable');
    expect(controlPlaneCodeOfStatus(503)).toBe('engine_unavailable');
    expect(controlPlaneCodeOfStatus(500)).toBe('internal');
  });
});

describe('the base URL', () => {
  it('accepts an http(s) origin and strips a trailing slash', () => {
    expect(parseLauncherBaseUrl('http://launcher:7780/')).toBe('http://launcher:7780');
    expect(parseLauncherBaseUrl('https://launcher.internal')).toBe('https://launcher.internal');
  });

  it.each([
    ['a scheme that is not http', 'file:///etc/passwd'],
    ['a javascript URL', 'javascript:fetch(1)'],
    ['not a URL at all', 'launcher:7780'],
    ['a URL carrying credentials', 'http://user:pass@launcher:7780'],
  ])('refuses %s', (_label, raw) => {
    // Q49's lesson, applied before the first request rather than after one: `z.url()` accepts
    // `javascript:`, `data:` and `file:`, and a credential in the URL would be a second secret in a
    // variable whose documented content is an address.
    expect(() => parseLauncherBaseUrl(raw)).toThrow(WorkspaceError);
  });

  it('refuses an empty token, because an empty shared secret is not one', () => {
    expect(() =>
      createLauncherControlClient({ baseUrl: 'http://launcher:7780', token: '   ' }),
    ).toThrow(/APP_LAUNCHER_TOKEN is empty/);
  });
});

describe('the client', () => {
  it('sends the token as a bearer and refuses to follow a redirect', async () => {
    const { client, calls } = clientWith(() => ({
      status: 200,
      body: JSON.stringify({
        status: 'ok',
        controlRoot: '/run/agentic/ctl',
        runtimeImage: 'platform-runtime:dev',
        claudeCodePath: '/usr/local/bin/claude',
        runs: 0,
      }),
    }));
    await client.health();
    expect(calls[0]?.url).toBe('http://launcher:7780/v1/health');
    expect(calls[0]?.init.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    // PROGRESS backlog 129's answer, written in rather than filed: a 302 is how an allow-listed
    // host hands a credential-bearing request to one that is not.
    expect(calls[0]?.init.redirect).toBe('error');
  });

  it('turns a typed refusal into the WorkspaceError code the stage executor acts on', async () => {
    const { client } = clientWith(() => ({
      status: 400,
      body: errorBody('invalid_spec', 'workspace spec did not validate'),
    }));
    await expect(client.health()).rejects.toMatchObject({
      name: 'WorkspaceError',
      code: 'invalid_spec',
      message: 'workspace spec did not validate',
    });
  });

  it('carries the launcher’s reason code and commit across, and drops a commit that is not a sha', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const answering = (commit: string) =>
      clientWith(() => ({
        status: 400,
        body: JSON.stringify({
          error: {
            code: 'invalid_spec',
            message: 'refused',
            runId: null,
            detail: null,
            reason: 'checkout_commit_missing',
            commit,
          },
        }),
      })).client;
    await expect(answering(sha).health()).rejects.toMatchObject({
      code: 'invalid_spec',
      reason: 'checkout_commit_missing',
      commit: sha,
    });
    // A body whose `commit` is not a sha is not a refusal this client can read: the status is.
    await expect(answering('FAKE-not-a-sha').health()).rejects.toMatchObject({
      code: 'invalid_spec',
      reason: 'launcher_request_refused',
      commit: null,
    });
  });

  it('names the transport’s own reason when the launcher sent none (WP-127)', async () => {
    const reasonOf = async (status: number, body: string) =>
      clientWith(() => ({ status, body }))
        .client.health()
        .catch((error: unknown) => (error as { reason: unknown }).reason);
    expect(await reasonOf(401, errorBody('unauthorized', 'no'))).toBe('launcher_unauthorized');
    expect(await reasonOf(400, errorBody('bad_request', 'no'))).toBe('launcher_request_refused');
    expect(await reasonOf(500, errorBody('internal', 'no'))).toBe('launcher_internal_error');
    expect(await reasonOf(400, errorBody('invalid_spec', 'no'))).toBeNull();
    const unreachable = await clientWith(() => Promise.reject(new Error('ECONNREFUSED')))
      .client.health()
      .catch((error: unknown) => (error as { reason: unknown }).reason);
    expect(unreachable).toBe('launcher_unreachable');
  });

  it('falls back to the status when the body is not a refusal it can read', async () => {
    // A proxy's own 502 page, a connection reset mid-body, a launcher that died between the header
    // and the payload. "The body did not parse" must not become `internal`, which is terminal-ish
    // noise, when the status already said the launcher was unreachable.
    const { client } = clientWith(() => ({ status: 502, body: '<html>bad gateway</html>' }));
    await expect(client.health()).rejects.toMatchObject({ code: 'engine_unavailable' });
  });

  it('refuses a success body it cannot read, rather than inventing the missing fields', async () => {
    const { client } = clientWith(() => ({ status: 200, body: JSON.stringify({ status: 'ok' }) }));
    await expect(client.health()).rejects.toMatchObject({ code: 'workspace_failed' });
  });

  it('reports a transport failure as retryable, naming the address', async () => {
    const { client } = clientWith(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(client.health()).rejects.toMatchObject({ code: 'engine_unavailable' });
    await expect(client.health()).rejects.toThrow(/http:\/\/launcher:7780/);
  });

  it('puts the run id in the end path, encoded', async () => {
    const { client, calls } = clientWith(() => ({
      status: 200,
      body: JSON.stringify({ exported: null, keepUntil: null, failures: [] }),
    }));
    await client.endRun('11111111-1111-4111-8111-111111111111', {
      handle: {
        runId: '11111111-1111-4111-8111-111111111111',
        projectId: '33333333-3333-4333-8333-333333333333',
        containerId: 'c1',
        sidecarContainerId: null,
        networkId: 'n1',
        volumeName: 'ws-1',
        cacheKey: 'p1',
        controlSubPath: '11111111-1111-4111-8111-111111111111',
        keepUntil: '2026-01-04T00:00:00.000Z',
      },
      export: null,
    });
    expect(calls[0]?.url).toBe(
      'http://launcher:7780/v1/runs/11111111-1111-4111-8111-111111111111/end',
    );
  });
});

describe('the reaper’s two verbs (WP-103, TD-028 decision 12)', () => {
  const RUN = '22222222-2222-4222-8222-222222222222';

  it('lists with an authenticated GET on the runs path, and reads the daemon’s answer', async () => {
    const { client, calls } = clientWith(() => ({
      status: 200,
      body: JSON.stringify({
        runs: [{ runId: RUN, createdAt: '2026-09-30T10:00:00.000Z', running: true }],
      }),
    }));
    await expect(client.listRuns()).resolves.toEqual({
      runs: [{ runId: RUN, createdAt: '2026-09-30T10:00:00.000Z', running: true }],
    });
    expect(calls[0]?.url).toBe('http://launcher:7780/v1/runs');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[0]?.init.redirect).toBe('error');
  });

  it('destroys with an authenticated POST of an empty object to the run’s destroy path', async () => {
    const { client, calls } = clientWith(() => ({
      status: 200,
      body: JSON.stringify({ found: false }),
    }));
    // `found: false` is a repeat and still a success (decision 4): the client answers it, never throws.
    await expect(client.destroyRun(RUN)).resolves.toEqual({ found: false });
    expect(calls[0]?.url).toBe(`http://launcher:7780/v1/runs/${RUN}/destroy`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.init.body).toBe('{}');
  });

  it('refuses a listing that answers more than the bound, or a field it does not know', async () => {
    const tooMany = clientWith(() => ({
      status: 200,
      body: JSON.stringify({
        runs: Array.from({ length: 1_001 }, () => ({
          runId: RUN,
          createdAt: '2026-09-30T10:00:00.000Z',
          running: false,
        })),
      }),
    }));
    await expect(tooMany.client.listRuns()).rejects.toMatchObject({ code: 'workspace_failed' });
    const unknownKey = clientWith(() => ({
      status: 200,
      body: JSON.stringify({ runs: [], instance: 'ctl' }),
    }));
    await expect(unknownKey.client.listRuns()).rejects.toMatchObject({ code: 'workspace_failed' });
  });

  it('turns a wrong token on either verb into the terminal code, like every other verb', async () => {
    const { client } = clientWith(() => ({
      status: 401,
      body: errorBody('unauthorized', 'the launcher token is missing or wrong'),
    }));
    await expect(client.listRuns()).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(client.destroyRun(RUN)).rejects.toMatchObject({ code: 'invalid_spec' });
  });
});
