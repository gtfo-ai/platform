import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DockerEngine, demultiplex, ENGINE_API_VERSION } from './engine.js';
import { FakeDockerDaemon } from './testing.js';

let daemon: FakeDockerDaemon;
let engine: DockerEngine;

beforeEach(async () => {
  daemon = new FakeDockerDaemon({
    script: (container) => ({ exitCode: 0, logs: `ran ${container.name}\n` }),
  });
  engine = new DockerEngine({ socketPath: await daemon.start() });
});

afterEach(async () => {
  await daemon.stop();
});

describe('Docker engine client', () => {
  it('needs exactly one address', () => {
    expect(() => new DockerEngine({})).toThrow(/exactly one/);
    expect(() => new DockerEngine({ socketPath: '/x', host: 'y' })).toThrow(/exactly one/);
  });

  it('pins the API version in every path', async () => {
    await engine.ping();
    await engine.createVolume({ name: 'v', labels: {} });
    // A path without the prefix is a 400 from the double, so this assertion has teeth: delete the
    // prefix from the client and every call in this file fails, not just this one.
    expect(daemon.requests.every((recorded) => recorded.path.startsWith('/'))).toBe(true);
    expect(ENGINE_API_VERSION).toMatch(/^v1\.\d+$/);
  });

  it('creates and lists volumes by label', async () => {
    await engine.createVolume({ name: 'ws-a', labels: { 'com.agentic.role': 'workspace' } });
    await engine.createVolume({ name: 'other', labels: { 'com.agentic.role': 'shared' } });
    const volumes = await engine.listVolumes({ label: ['com.agentic.role=workspace'] });
    expect(volumes.map((volume) => volume.Name)).toEqual(['ws-a']);
  });

  it('treats a missing volume as removed rather than as a failure', async () => {
    await expect(engine.removeVolume('never-existed')).resolves.toBeUndefined();
  });

  it('creates an internal network and sends the flag that makes it internal', async () => {
    const id = await engine.createNetwork({ name: 'run-a', internal: true, labels: {} });
    expect(daemon.networks.get(id)).toEqual({ name: 'run-a', internal: true });
  });

  it('runs a container and reads its exit code and logs', async () => {
    const id = await engine.createContainer('helper', { Image: 'x', Cmd: ['echo hi'] });
    await engine.startContainer(id);
    expect(await engine.waitContainer(id)).toBe(0);
    expect(await engine.containerLogs(id)).toBe('ran helper\n');
    await engine.removeContainer(id);
    // `byName` reads the double's history, which keeps removed containers so a test can still
    // assert what a helper was sent; `created` is the daemon's own live view.
    expect(daemon.created).toEqual([]);
  });

  it('sends the create body as JSON, so the daemon sees what the hardening built', async () => {
    await engine.createContainer('c', { Image: 'x', HostConfig: { CapDrop: ['ALL'] } });
    const create = daemon.requests.find((recorded) => recorded.path === '/containers/create');
    expect(create?.body).toEqual({ Image: 'x', HostConfig: { CapDrop: ['ALL'] } });
  });

  it('reports a 404 as not_found', async () => {
    await expect(engine.inspectContainer('missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports every other refusal as workspace_failed', async () => {
    // The daemon's 400 for a volume with no name. `not_found` and `workspace_failed` are different
    // answers to the caller — `destroy` absorbs the first and never the second — so which one a
    // status maps to is asserted from both sides.
    await expect(engine.createVolume({ name: '', labels: {} })).rejects.toMatchObject({
      code: 'workspace_failed',
    });
  });

  it("carries the daemon's own message into the error detail", async () => {
    const named = new FakeDockerDaemon({
      fail: new Map([['POST /containers/create', { status: 500, message: 'no such image: nope' }]]),
    });
    const other = new DockerEngine({ socketPath: await named.start() });
    try {
      await expect(other.createContainer('c', {})).rejects.toMatchObject({
        code: 'workspace_failed',
        detail: expect.stringContaining('no such image: nope'),
      });
    } finally {
      await named.stop();
    }
  });

  it('reports an unreachable daemon as engine_unavailable', async () => {
    const gone = new DockerEngine({ socketPath: '/tmp/agentic-no-such-docker.sock' });
    await expect(gone.ping()).rejects.toMatchObject({ code: 'engine_unavailable' });
  });

  it('refuses a response body past its ceiling instead of buffering it', async () => {
    const big = new FakeDockerDaemon({
      archives: new Map([['c:/work/export.tar', Buffer.alloc(4096, 7)]]),
    });
    const bounded = new DockerEngine({ socketPath: await big.start(), maxResponseBytes: 1024 });
    try {
      const id = await bounded.createContainer('c', {});
      await expect(bounded.getArchive(id, '/work/export.tar')).rejects.toThrow(
        /exceeded the limit/,
      );
    } finally {
      await big.stop();
    }
  });

  it('refuses a success answer whose shape is not the one it expected', async () => {
    // A 201 whose body is not a volume. Every field this client reads is behind a schema (BD-022:
    // the strings in a daemon's answers were chosen by the containers), so a shape it does not
    // recognise is an error rather than an `undefined` propagating into a container name.
    const odd = new FakeDockerDaemon({
      fail: new Map([['POST /volumes/create', { status: 201, message: 'not a volume' }]]),
    });
    const client = new DockerEngine({ socketPath: await odd.start() });
    try {
      await expect(client.createVolume({ name: 'v', labels: {} })).rejects.toMatchObject({
        code: 'workspace_failed',
        detail: expect.stringContaining('Name'),
      });
    } finally {
      await odd.stop();
    }
  });

  it('refuses a success answer that is not JSON at all', async () => {
    const odd = new FakeDockerDaemon({
      fail: new Map([
        ['POST /volumes/create', { status: 201, message: '', raw: '<html>proxy error</html>' }],
      ]),
    });
    const client = new DockerEngine({ socketPath: await odd.start() });
    try {
      // The realistic producer of this is `docker-socket-proxy` itself answering with an HTML
      // error page, which TD-021 puts between the launcher and the daemon.
      await expect(client.createVolume({ name: 'v', labels: {} })).rejects.toMatchObject({
        code: 'workspace_failed',
        detail: expect.stringContaining('proxy error'),
      });
    } finally {
      await odd.stop();
    }
  });
});

describe('stream demultiplexer', () => {
  const framed = (type: number, text: string): Buffer => {
    const payload = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  it('joins stdout and stderr frames in order', () => {
    const body = Buffer.concat([framed(1, 'out\n'), framed(2, 'err\n'), framed(1, 'more\n')]);
    expect(demultiplex(body).toString('utf8')).toBe('out\nerr\nmore\n');
  });

  it('passes an unframed body through rather than mangling it', () => {
    // A `Tty: true` container's logs have no headers. Returning the raw bytes is the right trade
    // on a diagnostic path: refusing would hide the reason a helper died.
    const raw = Buffer.from('plain output with no framing at all\n');
    expect(demultiplex(raw)).toEqual(raw);
  });

  it('stops rather than reading past the buffer on a truncated frame', () => {
    const truncated = framed(1, 'hello').subarray(0, 10);
    expect(demultiplex(truncated)).toEqual(truncated);
  });
});
