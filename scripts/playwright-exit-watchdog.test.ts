import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { FullResult } from '@playwright/test/reporter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExitWatchdog, {
  describeHandle,
  EXIT_GRACE_MS,
  processOpenHandles,
  type WatchdogHost,
} from './playwright-exit-watchdog.js';

/**
 * The reporter that ends a Playwright run which reported and did not exit (WP-126, backlog 401).
 * The in-process cases drive it through a recorded host; the process cases run it in a real Node
 * and read the exit status, because "the process ends, and says why" is a property of a process.
 */
const result = (status: FullResult['status']): FullResult => ({
  status,
  startTime: new Date(0),
  duration: 1,
});

const recordingHost = () => {
  const timers: { callback: () => void; ms: number }[] = [];
  const written: string[] = [];
  const exits: number[] = [];
  const host: WatchdogHost = {
    setTimer: (callback, ms) => {
      timers.push({ callback, ms });
    },
    write: (text) => {
      written.push(text);
    },
    exit: (code) => {
      exits.push(code);
    },
    openHandles: () => ['resources: TCPWRAP ×1', 'Server listening on {"port":4318}'],
  };
  return { host, timers, written, exits };
};

describe('the exit watchdog, in process', () => {
  it('arms one timer at the grace on the run’s end, and does nothing before it fires', () => {
    const { host, timers, written, exits } = recordingHost();
    new ExitWatchdog({ host }).onEnd(result('passed'));
    expect(timers.map((timer) => timer.ms)).toEqual([EXIT_GRACE_MS]);
    expect(written).toEqual([]);
    expect(exits).toEqual([]);
  });

  it('fails a passed run that is still alive, naming the status and every open handle', () => {
    const { host, timers, written, exits } = recordingHost();
    new ExitWatchdog({ graceMs: 5_000, host }).onEnd(result('passed'));
    timers[0]?.callback();
    expect(exits).toEqual([1]);
    expect(written.join('')).toMatch(
      /^FAIL: playwright-exit-watchdog — the run ended \(passed\) at \S+ and the process was still alive 5 s later\. Open handles:\n {2}resources: TCPWRAP ×1\n {2}Server listening on \{"port":4318\}\n$/,
    );
  });

  it('does not print to stdio, so Playwright keeps the list reporter’s output as it was', () => {
    expect(new ExitWatchdog().printsToStdio()).toBe(false);
  });
});

describe('a handle as a line', () => {
  it('names a socket by its endpoints, a child by its pid and command, a server by its address', () => {
    class Socket {
      remoteAddress = '127.0.0.1';
      remotePort = 4318;
      localPort = 51000;
    }
    class ChildProcess {
      pid = 4242;
      spawnargs = ['/bin/sh', '-c', 'node serve.ts'];
    }
    class Server {
      address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 4318 });
    }
    // A stdio pipe: a socket with an fd and an empty address, as Node 25 reports one.
    class WriteStream {
      fd = 2;
      address = () => ({});
    }
    class Unknown {}
    expect(describeHandle(new Socket())).toBe('Socket 51000 -> 127.0.0.1:4318');
    expect(describeHandle(new ChildProcess())).toBe(
      'ChildProcess pid 4242: /bin/sh -c node serve.ts',
    );
    expect(describeHandle(new Server())).toBe(
      'Server listening on {"address":"127.0.0.1","family":"IPv4","port":4318}',
    );
    expect(describeHandle(new WriteStream())).toBe('WriteStream fd 2');
    expect(describeHandle(new Unknown())).toBe('Unknown');
  });

  it('reads a real listening server out of this process', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as net.AddressInfo;
      const lines = processOpenHandles();
      expect(lines[0]).toMatch(/^resources: .*TCPServerWrap ×\d+/);
      expect(lines.some((line) => line.includes(`"port":${port}`))).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/**
 * The reporter in a real Node, three ways: held by an open server (the shape of the CI hang), held
 * by nothing but an awaited promise that never settles (where Node alone would exit **0**), and a
 * run that ends on its own (which must not be touched).
 */
const runReporter = (body: string) => {
  const module = pathToFileURL(join(import.meta.dirname, 'playwright-exit-watchdog.ts')).href;
  const source = [
    `import ExitWatchdog from '${module}';`,
    "import net from 'node:net';",
    'const watchdog = new ExitWatchdog({ graceMs: 300 });',
    body,
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    timeout: 30_000,
  });
};

describe('the exit watchdog, in a real process', () => {
  it('ends a run held by an open server with status 1 and names the server', () => {
    const run = runReporter(
      [
        "watchdog.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });",
        "net.createServer().listen(0, '127.0.0.1');",
      ].join('\n'),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^FAIL: playwright-exit-watchdog — the run ended \(passed\)/m);
    expect(run.stderr).toMatch(/Server listening on \{"address":"127\.0\.0\.1"/);
  });

  it('ends a failed run stuck on a promise with nothing behind it, which Node alone exits 0', () => {
    // Playwright's CLI is `program.parse(process.argv)`, not awaited (`playwright/cli.js`), so a
    // run whose action never settles and whose loop empties ends with **0**. The same shape here:
    // an async action nothing awaits, stuck after the reporter has seen a failed run.
    const stuck = 'void (async () => { await new Promise(() => {}); })();';
    const calibration = spawnSync(process.execPath, ['--input-type=module', '--eval', stuck], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(calibration.status).toBe(0);
    const run = runReporter(
      ["watchdog.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });", stuck].join(
        '\n',
      ),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/the run ended \(failed\)/);
  });

  it('leaves a run that exits on its own alone', () => {
    const run = runReporter(
      [
        "watchdog.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });",
        'process.exit(0);',
      ].join('\n'),
    );
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });
});

describe('playwright.config.ts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const reportersWith = async (ci: string | undefined) => {
    vi.stubEnv('CI', ci);
    vi.resetModules();
    const { default: config } = await import('../playwright.config.js');
    return (config.reporter as unknown as [string, unknown?][]).map(([name]) => name);
  };

  it('lists the watchdog on CI, after `list` and before `html`', async () => {
    expect(await reportersWith('true')).toEqual([
      'list',
      './scripts/playwright-exit-watchdog.ts',
      'html',
    ]);
  });

  it('does not list it off CI, where `--ui`, watch mode and the editor reuse the process', async () => {
    expect(await reportersWith(undefined)).toEqual(['list']);
  });
});
