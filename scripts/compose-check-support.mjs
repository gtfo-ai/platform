/**
 * What the three image checks share (WP-126): `web-compose-check.mjs`, `compose-stock-check.mjs`
 * and `compose-isolation-check.mjs` each start compose projects from `compose.yml` against images
 * already built, and each must end — by name — however the instance under it behaves.
 *
 * The shape is the one the WP-118 follow-up gave the web check after it failed on CI with exit 13
 * and no `FAIL:` line (PROGRESS backlog 349 found the stock check without it):
 *
 *  - **a refusal below Node 24**, because Node 22's undici loses a first connection the peer closes
 *    early and leaves the `fetch` pending with nothing behind it ({@link refuseOldNode});
 *  - **every wait on a ref'd deadline**, so a request that never settles fails naming itself
 *    instead of the event loop emptying under it ({@link createStages});
 *  - **a `beforeExit` backstop** naming the stage, for a wait nothing bounded
 *    ({@link installExitBackstop});
 *  - **the port the daemon chose, read back** ({@link publishedPort}, backlog 348): compose
 *    publishes `${APP_PORT}:8080` with no host address, i.e. on every interface, so a port probed
 *    free on `127.0.0.1` and handed over could be taken in between or held on another interface.
 *    `APP_PORT=0` lets the daemon choose — measured on Compose 2.38.2 (CI's) and v5.5.1, both of
 *    which accept `0:8080` and publish an ephemeral port that `docker compose port` reports.
 *
 * Plain Node, no dependency: `image.yml` runs these scripts with nothing installed.
 */
import process from 'node:process';

/** The repository's Node (`.nvmrc`, `engines`). */
export const MINIMUM_NODE_MAJOR = 24;

/**
 * Exits 1 naming `.nvmrc` when this Node is below {@link MINIMUM_NODE_MAJOR}.
 *
 * Node 22's bundled undici (6.28.1 in 22.23.3) compiles its HTTP parser asynchronously on the
 * process's **first** connection and attaches that socket's listeners only afterwards, so a peer
 * that closes the connection inside the window is never observed: the `fetch` stays pending with
 * no handle behind it and the process exits 13. `docker-proxy` — and Docker Desktop's port
 * forwarder, measured at WP-126 — accept and close exactly that connection: the first health
 * probe, sent before the app listens. Measured by the WP-118 follow-up with a server that closes on
 * accept: 11 of 20 fresh Node 22.23.3 processes exited 13, 0 of 20 on Node 24.21.0.
 */
export const refuseOldNode = (check, version = process.versions.node, exit = process.exit) => {
  if (Number(version.split('.')[0]) < MINIMUM_NODE_MAJOR) {
    console.error(
      `FAIL: ${check} — Node ${version} is below this repository's ${MINIMUM_NODE_MAJOR} ` +
        '(.nvmrc): its fetch loses a first connection the peer closes early',
    );
    exit(1);
  }
};

/** A wait that outlived its deadline: never "not ready yet", always a failure. */
export class Unsettled extends Error {}

/**
 * The stage a check is in, and `within`, which bounds a wait and names it as the stage.
 *
 * The timer is deliberately **ref'd**: it is what keeps the event loop alive under a promise that
 * nothing else is behind, so a wedged request is reported by name instead of the process ending
 * on an unsettled top-level await.
 */
export const createStages = (initial = 'starting') => {
  let current = initial;
  const within = async (what, ms, work) => {
    current = what;
    let timer;
    try {
      return await Promise.race([
        work(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Unsettled(`${what} did not settle within ${ms / 1000} s`)),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    get current() {
      return current;
    },
    set: (stage) => {
      current = stage;
    },
    within,
  };
};

/** One request and its whole body, bounded — the default for every HTTP call a check makes. */
export const REQUEST_MS = 30_000;

/**
 * `GET`/`POST` through `within`: the response and its body text, or an {@link Unsettled} naming
 * the method and URL.
 */
export const boundedFetch = (stages, url, init = {}, ms = REQUEST_MS) =>
  stages.within(`${init.method ?? 'GET'} ${url}`, ms, async () => {
    const response = await fetch(url, init);
    return { response, body: await response.text() };
  });

/**
 * Polls `url` until it answers 2xx, within an overall deadline.
 *
 * A probe that is *refused or closed* is the app not listening yet, and is tried again; a probe
 * that does not settle is not that, and fails the check by name rather than being retried. The
 * overall deadline is checked after every probe, and every probe is itself bounded, so the
 * deadline is reached even when no probe ever answers.
 */
export const waitForOk = async (
  stages,
  url,
  { probeMs = 10_000, totalMs = 180_000, intervalMs = 2_000 } = {},
) => {
  const deadline = Date.now() + totalMs;
  for (;;) {
    let answered;
    try {
      answered = await stages.within(`GET ${url} (waiting for the app)`, probeMs, () => fetch(url));
    } catch (error) {
      if (error instanceof Unsettled) {
        throw error;
      }
      // refused or closed: not listening yet
    }
    await answered?.body?.cancel();
    if (answered?.ok) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${url} never answered 2xx within ${totalMs / 1000} s`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

/**
 * The host port from `docker compose port <service> <port>`'s answer.
 *
 * Compose prints one `address:port` line — `0.0.0.0:55912` on a daemon that also publishes on
 * `[::]` (measured, Compose 2.38.2 and v5.5.1) — and an empty line or `:0` when the container
 * publishes nothing. Anything but a port in 1–65535 is refused, naming what compose said.
 */
export const parsePublishedPort = (stdout) => {
  const line = (stdout.trim().split('\n')[0] ?? '').trim();
  const port = Number(/:(\d+)$/.exec(line)?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`docker compose port answered ${JSON.stringify(stdout.trim())}, not a port`);
  }
  return port;
};

/**
 * The interpolation every check gives `compose.yml`: `APP_PORT=0` (the daemon chooses the host
 * port), and the two volumes `compose.yml` names **globally** — `ctl` and the launcher's
 * `repo-cache` default to `agentic-ctl`/`agentic-repo-cache` — named after the project, so a
 * check's `down -v` can never remove a developer's instance's volumes. `image.yml`'s teardown
 * passes the same two names.
 */
export const composeEnvironment = (project) => ({
  APP_PORT: '0',
  APP_WORKSPACE_CONTROL_VOLUME: `${project}-ctl`,
  APP_WORKSPACE_CACHE_VOLUME: `${project}-repo-cache`,
});

/** Asks compose which host port the daemon gave `service`'s `containerPort`. */
export const publishedPort = async (compose, service = 'app', containerPort = 8080) => {
  const { stdout } = await compose(['port', service, String(containerPort)]);
  return parsePublishedPort(stdout);
};

/**
 * The backstop for a wait nothing bounded: the loop emptied while `main()` was still pending. It
 * names the stage and exits 1 instead of Node's bare "unsettled top-level await" (exit 13). The
 * teardown cannot run from here, which `image.yml`'s `always` step covers. Call the returned
 * function once `main()` has settled.
 */
export const installExitBackstop = (check, stages) => {
  let finished = false;
  process.on('beforeExit', () => {
    if (!finished) {
      console.error(
        `FAIL: ${check} — the event loop emptied while waiting on: ${stages.current} ` +
          '(an awaited promise had nothing behind it)',
      );
      process.exit(1);
    }
  });
  return () => {
    finished = true;
  };
};

/**
 * What an instance looked like when a check failed: every service's state (a dead app shows its
 * exit code there) and the app's last log lines. Best effort: it reports, it never decides.
 */
export const describeInstance = async (compose, label = '') => {
  for (const args of [
    ['ps', '--all'],
    ['logs', '--no-color', '--tail', '80', 'app'],
  ]) {
    try {
      const { stdout, stderr } = await compose(args);
      console.error(`--- ${label}docker compose ${args.join(' ')}\n${stdout}${stderr}`);
    } catch (error) {
      console.error(`--- ${label}docker compose ${args.join(' ')} failed: ${String(error)}`);
    }
  }
};
