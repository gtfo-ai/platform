import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { SERVER_CONFIG_DEFAULTS } from '@platform/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composeEnvironment,
  createStages,
  parsePublishedPort,
  publishedPort,
  refuseOldNode,
  stopGracePeriodSeconds,
  Unsettled,
  waitForOk,
} from './compose-check-support.mjs';

/**
 * What the three image checks share (WP-126, PROGRESS backlogs 348 and 349). The checks themselves
 * need a daemon and are run by `image.yml`; what is asserted here is every piece of their shape that
 * can fail without one — and, in a real Node process, the two endings a pending wait can have.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the published port, read back from compose', () => {
  it('reads the port from an IPv4 or an IPv6 answer, first line only', () => {
    expect(parsePublishedPort('0.0.0.0:55912\n')).toBe(55912);
    expect(parsePublishedPort('[::]:55913\n')).toBe(55913);
    expect(parsePublishedPort('0.0.0.0:55914\n[::]:55914\n')).toBe(55914);
  });

  it('reads a CRLF answer, line by line', () => {
    expect(parsePublishedPort('0.0.0.0:55915\r\n[::]:55915\r\n')).toBe(55915);
  });

  it('refuses an answer that is not a port, naming what compose said', () => {
    expect(() => parsePublishedPort('')).toThrow('docker compose port answered "", not a port');
    expect(() => parsePublishedPort(':0\n')).toThrow('":0"');
    expect(() => parsePublishedPort('no such service: app')).toThrow('not a port');
    expect(() => parsePublishedPort('0.0.0.0:70000')).toThrow('not a port');
  });

  it('asks compose for the service and the container port', async () => {
    const calls: string[][] = [];
    const port = await publishedPort(async (args) => {
      calls.push(args);
      return { stdout: '0.0.0.0:61000\n', stderr: '' };
    });
    expect(port).toBe(61000);
    expect(calls).toEqual([['port', 'app', '8080']]);
  });
});

describe('the interpolation every check hands compose', () => {
  it('lets the daemon choose the port and names both global volumes after the project', () => {
    expect(composeEnvironment('agentic-web-check-x')).toEqual({
      APP_PORT: '0',
      APP_WORKSPACE_CONTROL_VOLUME: 'agentic-web-check-x-ctl',
      APP_WORKSPACE_CACHE_VOLUME: 'agentic-web-check-x-repo-cache',
    });
  });
});

describe('the Node guard', () => {
  it('refuses Node 22 by name and lets 24 through', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exits: number[] = [];
    refuseOldNode('a-check', '22.23.3', (code) => {
      exits.push(code);
    });
    refuseOldNode('a-check', '24.21.0', (code) => {
      exits.push(code);
    });
    expect(exits).toEqual([1]);
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
      "FAIL: a-check — Node 22.23.3 is below this repository's 24 (.nvmrc): its fetch loses a first connection the peer closes early",
    ]);
  });
});

describe('a bounded wait', () => {
  it('answers what the work answers, and records the stage', async () => {
    const stages = createStages();
    await expect(stages.within('reading a thing', 1_000, async () => 7)).resolves.toBe(7);
    expect(stages.current).toBe('reading a thing');
  });

  it('fails naming the wait when the work never settles', async () => {
    const stages = createStages();
    const pending = stages.within('GET http://x/healthz', 50, () => new Promise(() => {}));
    await expect(pending).rejects.toBeInstanceOf(Unsettled);
    await expect(pending).rejects.toThrow('GET http://x/healthz did not settle within 0.05 s');
  });
});

/** A server on loopback whose every connection is answered by `handle`. */
const serve = async (handle: (socket: net.Socket) => void) => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    handle(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/healthz`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

const answer = (status: number) => (socket: net.Socket) => {
  socket.once('data', () => {
    socket.end(`HTTP/1.1 ${status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
  });
};

describe('waiting for the app', () => {
  it('tries a closed connection and a 503 again, and returns on the first 200', async () => {
    let seen = 0;
    const server = await serve((socket) => {
      seen += 1;
      if (seen === 1) socket.destroy();
      else answer(seen === 2 ? 503 : 200)(socket);
    });
    try {
      await waitForOk(createStages(), server.url, { probeMs: 2_000, intervalMs: 10 });
      expect(seen).toBe(3);
    } finally {
      await server.close();
    }
  });

  it('fails by name on a probe that is accepted and never answered, without retrying it', async () => {
    let seen = 0;
    const server = await serve(() => {
      seen += 1;
    });
    try {
      await expect(
        waitForOk(createStages(), server.url, { probeMs: 200, intervalMs: 10 }),
      ).rejects.toThrow(`GET ${server.url} (waiting for the app) did not settle within 0.2 s`);
      expect(seen).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('gives up at the overall deadline when nothing ever answers 2xx', async () => {
    const server = await serve(answer(503));
    try {
      await expect(
        waitForOk(createStages(), server.url, { probeMs: 1_000, totalMs: 100, intervalMs: 10 }),
      ).rejects.toThrow(`${server.url} never answered 2xx within 0.1 s`);
    } finally {
      await server.close();
    }
  });
});

/**
 * The two endings of a wait in a real process, which is where an unsettled top-level await ends
 * Node with 13 and nothing said. Calibrated first: the same await without the support module.
 */
const node = (source: string) =>
  spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    timeout: 30_000,
  });
const support = pathToFileURL(join(import.meta.dirname, 'compose-check-support.mjs')).href;

describe('a pending wait in a real process', () => {
  it('calibration: a bare await on a promise nothing is behind ends Node with 13', () => {
    expect(node('await new Promise(() => {});').status).toBe(13);
  });

  it('a bounded wait fails by name instead, because its timer keeps the loop alive', () => {
    const run = node(
      [
        `import { createStages } from '${support}';`,
        'const stages = createStages();',
        'try {',
        "  await stages.within('GET http://x/healthz', 100, () => new Promise(() => {}));",
        '} catch (error) {',
        '  console.error(`FAIL: ${error.message}`);',
        '  process.exit(1);',
        '}',
      ].join('\n'),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('FAIL: GET http://x/healthz did not settle within 0.1 s');
  });

  it('an unbounded one meets the backstop, which names the stage and exits 1', () => {
    const run = node(
      [
        `import { createStages, installExitBackstop } from '${support}';`,
        'const stages = createStages();',
        'const finished = installExitBackstop("a-check", stages);',
        "stages.set('docker compose up');",
        'await new Promise(() => {});',
        'finished();',
      ].join('\n'),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'FAIL: a-check — the event loop emptied while waiting on: docker compose up',
    );
  });
});

/**
 * The stop graces `compose.yml` declares (WP-133, folding WP-132's discovered work).
 *
 * On Docker Desktop 29.8.1 / Compose 5.5.1 a service with no `stop_grace_period` was killed about
 * three seconds after the stop signal (WP-132, measured), so every long-lived service either
 * declares a grace derived from a reading — stated beside the line in `compose.yml` — or is named
 * below with the reason it needs none. A new service is therefore a decision somebody writes down.
 * The daemon half (each stops cleanly, exit 0, inside its grace) is `compose-stock-check.mjs`'s
 * `local` leg; this is the half that runs without one.
 */
describe('the stop graces compose.yml declares (WP-133)', () => {
  const composeText = readFileSync(join(import.meta.dirname, '..', 'compose.yml'), 'utf8');
  /** The longest readings each grace was set from, in seconds (PROGRESS, WP-132 and WP-133). */
  const LONGEST_READING_S = {
    // A `postgres` of the pinned digest, 128 MB of dirty `shared_buffers`: 0.63 s and 0.76 s.
    db: 0.76,
    // A create drained under a stop: 11.7 s, 12.6 s (WP-132), 12.1 s (WP-127).
    launcher: 12.6,
  } as const;
  /** Long-lived services that need no grace, each with its reason. */
  const NO_GRACE_NEEDED: Record<string, string> = {
    'docker-socket-proxy':
      'a filtering proxy with no state of its own; the launcher, which stops first, is what drains',
    'db-backup':
      'an opt-in profile whose dump runs on a schedule; a dump cut short is not a backup and the next schedule writes one (not measured — PROGRESS, WP-133 discovered work)',
  };

  it('reads a service’s grace, answers null for none, and refuses a spelling it cannot read', () => {
    const text = [
      'name: x',
      'services:',
      '  a:',
      '    image: a',
      '    stop_grace_period: 45s',
      '  b:',
      '    image: b',
      '  c:',
      '    stop_grace_period: 1m30s',
      'volumes:',
      '  a:',
      '    stop_grace_period: 9s',
      '',
    ].join('\n');
    expect(stopGracePeriodSeconds(text, 'a')).toBe(45);
    expect(stopGracePeriodSeconds(text, 'b')).toBeNull();
    expect(() => stopGracePeriodSeconds(text, 'c')).toThrow(/only `<n>s` is read/);
    expect(() => stopGracePeriodSeconds(text, 'nope')).toThrow(/declares no service `nope`/);
  });

  it('gives app and runner more than the server’s own shutdown deadline, with a margin', () => {
    // `close-with-grace` exits the process at `APP_SHUTDOWN_TIMEOUT_MS` (exit 1) if the drain has
    // not finished, so the default deadline is the longest either process can need.
    const deadlineS = SERVER_CONFIG_DEFAULTS.shutdownTimeoutMs / 1000;
    for (const service of ['app', 'runner']) {
      const grace = stopGracePeriodSeconds(composeText, service);
      expect(grace, service).not.toBeNull();
      expect(grace as number, service).toBeGreaterThanOrEqual(deadlineS + 10);
    }
  });

  it('gives db and the launcher several times the longest stop they were measured at', () => {
    for (const [service, reading] of Object.entries(LONGEST_READING_S)) {
      const grace = stopGracePeriodSeconds(composeText, service);
      expect(grace, service).not.toBeNull();
      expect(grace as number, service).toBeGreaterThanOrEqual(4 * reading);
    }
    // The database's margin is the wide one on purpose: its reading is one disk's.
    expect(stopGracePeriodSeconds(composeText, 'db') as number).toBeGreaterThanOrEqual(
      20 * LONGEST_READING_S.db,
    );
  });

  it('leaves no long-lived service on the daemon’s three seconds unless it is named with a reason', () => {
    const fromServices = composeText.slice(composeText.indexOf('\nservices:\n') + 1);
    // Up to the next top-level key (`volumes:`), whose own two-space keys are not services.
    const servicesBlock = fromServices.slice(
      0,
      fromServices.slice(1).search(/\n[^\s#][^\n]*:/) + 1,
    );
    const services = servicesBlock
      .split('\n')
      .filter((line) => /^ {2}[a-z][a-z0-9-]*:$/.test(line))
      .map((line) => line.trim().slice(0, -1));
    const longLived = services.filter(
      (service) => service !== 'migrate' && !(service in NO_GRACE_NEEDED),
    );
    // Calibration: the parse found the services, not an empty list that passes.
    expect(services).toEqual(
      expect.arrayContaining(['db', 'app', 'runner', 'launcher', 'migrate', 'docker-socket-proxy']),
    );
    expect(
      longLived.filter((service) => stopGracePeriodSeconds(composeText, service) === null),
    ).toEqual([]);
    for (const service of Object.keys(NO_GRACE_NEEDED)) {
      expect(services, service).toContain(service);
    }
  });
});
