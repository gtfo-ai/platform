#!/usr/bin/env node
/**
 * `node scripts/compose-isolation-check.mjs` — two compose projects from `compose.yml` on one
 * daemon, and each `app` reaches its own `db` (WP-126, PROGRESS backlog 347).
 *
 * ## The defect it exists for
 *
 * `compose.yml` pinned the default network's name to `agentic`. Compose uses a declared `name`
 * verbatim instead of prefixing the project, so `-p agentic-web-check-…` and `-p
 * agentic-stock-check-…` changed the containers' and volumes' names and **not the network's**:
 * every project started from the file joined one network, and the `db` alias on it answered with
 * any of their databases. Measured by the WP-118 follow-up with three leaked check projects on one
 * daemon: one app logged `role "platform_app" does not exist` and restarted — it had migrated, or
 * was reading, another project's database. The image checks' "a project name of its own, so two
 * runs cannot collide" was false for networks, and so was a developer's instance beside a check.
 * WP-126 removed the `name:`, so compose scopes the network to the project (`<project>_default`).
 *
 * ## What it asserts
 *
 * Two projects, `…-a` and `…-b`, each `db`, `migrate` and `app`, started **at once**. For each:
 *
 *  1. inside its `app` container, `db` resolves to the addresses of **its own** `db` container and
 *     to nothing else — on the shared network it resolved to both projects' databases;
 *  2. a TCP connection from its `app` to `db:5432` lands on its own `db`'s address;
 *  3. the two projects' default networks are two networks.
 *
 * The addresses are read from the daemon (`docker inspect` of the project's own `db` container),
 * never from the app, so the comparison is between two independent answers. Asserted from inside
 * `app` with Node, which the image has, rather than with a tool it may not.
 *
 * ## What it does not isolate, stated
 *
 * `agentic-run-egress` is named globally in `compose.yml` on purpose (the launcher is handed it by
 * name), so two instances that both start a launcher share it. This check starts no launcher.
 *
 * Like the other image checks it is **not** a `verify` target (no daemon in those jobs) and it is
 * **not unrun**: `.github/workflows/image.yml`'s `build` job runs it against the image that job
 * built, on both architectures, and repeats its teardown in an `always` step. A skip counts as a
 * failure: with no daemon or no image it exits 1 naming what is missing.
 *
 * Usage:
 *   node scripts/compose-isolation-check.mjs                     against `platform:dev`
 *   node scripts/compose-isolation-check.mjs --tag ci            against images built as `:ci`
 *   node scripts/compose-isolation-check.mjs --project-suffix x  projects of their own
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  composeEnvironment,
  createStages,
  describeInstance,
  installExitBackstop,
  publishedPort,
  refuseOldNode,
  Unsettled,
  waitForOk,
} from './compose-check-support.mjs';

refuseOldNode('compose-isolation-check');

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const optionValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const SUFFIX = optionValue('--project-suffix', process.env.GITHUB_RUN_ID ?? 'local');
const TAG = optionValue('--tag', process.env.PLATFORM_TAG ?? 'dev');
const known = new Set(['--tag', '--project-suffix']);
const unknown = args.filter((argument) => argument.startsWith('--') && !known.has(argument));
if (unknown.length > 0) {
  console.error(
    `FAIL: compose-isolation-check — unknown option(s): ${unknown.join(', ')}\n` +
      'usage: compose-isolation-check.mjs [--tag <tag>] [--project-suffix <suffix>]',
  );
  process.exit(1);
}

/** The two projects, named so `image.yml`'s teardown can name them too. */
const PROJECTS = ['a', 'b'].map((side) => `agentic-isolation-check-${SUFFIX}-${side}`);

/** Obviously fake, and past `APP_SECRET_KEY`'s 32-character floor (BD-002). */
const SECRET_KEY = 'wp126-compose-isolation-check-not-a-real-secret';
const TIMEOUT_MS = 15 * 60 * 1000;
const DOCKER_QUERY_MS = 60_000;

/**
 * The service environment the process needs, as an override file (the web check's arrangement,
 * WP-50): the checkout has no `.env`, and `environment:` wins over a developer's own.
 */
const OVERRIDE_DIRECTORY = mkdtempSync(path.join(tmpdir(), 'compose-isolation-check-'));
const OVERRIDE = path.join(OVERRIDE_DIRECTORY, 'compose.isolation-check.yml');
writeFileSync(
  OVERRIDE,
  [
    'services:',
    '  app:',
    '    environment:',
    `      APP_SECRET_KEY: ${SECRET_KEY}`,
    '      APP_BASE_URL: http://compose-isolation-check.example.test',
    '      LOG_LEVEL: warn',
    '',
  ].join('\n'),
  'utf8',
);

const composeFor = (project) => async (composeArgs) =>
  run(
    'docker',
    [
      'compose',
      '-p',
      project,
      '--env-file',
      '/dev/null',
      '-f',
      'compose.yml',
      '-f',
      OVERRIDE,
      ...composeArgs,
    ],
    {
      cwd: REPO,
      env: { ...process.env, ...composeEnvironment(project), PLATFORM_TAG: TAG },
      maxBuffer: 64 * 1024 * 1024,
      timeout: TIMEOUT_MS,
    },
  );

const docker = async (dockerArgs) =>
  run('docker', dockerArgs, { maxBuffer: 16 * 1024 * 1024, timeout: DOCKER_QUERY_MS });

/**
 * Run inside `app`: every address `db` resolves to, and the address a TCP connection to `db:5432`
 * lands on. One JSON line; a failure to connect is reported as `remote: null` with the error.
 */
const PROBE = [
  "const dns = require('node:dns').promises;",
  "const net = require('node:net');",
  '(async () => {',
  "  const resolved = (await dns.lookup('db', { all: true })).map((entry) => entry.address);",
  '  const remote = await new Promise((resolve) => {',
  "    const socket = net.connect(5432, 'db');",
  '    const done = (value) => { socket.destroy(); resolve(value); };',
  "    socket.setTimeout(10000, () => done({ error: 'timeout' }));",
  "    socket.once('connect', () => done({ address: socket.remoteAddress }));",
  "    socket.once('error', (error) => done({ error: error.code ?? String(error) }));",
  '  });',
  '  console.log(JSON.stringify({ resolved, remote }));',
  '})();',
].join('\n');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) {
    failures.push(name);
  }
};

const stages = createStages();

/** The addresses the daemon gave a project's `db` container, by network name. */
const dbAddresses = async (compose) => {
  const { stdout: id } = await compose(['ps', '-q', 'db']);
  const { stdout } = await docker([
    'inspect',
    id.trim(),
    '--format',
    '{{json .NetworkSettings.Networks}}',
  ]);
  const networks = JSON.parse(stdout);
  return new Map(Object.entries(networks).map(([name, value]) => [name, value.IPAddress]));
};

const main = async () => {
  try {
    const { stdout } = await docker(['version', '--format', '{{.Server.Version}}']);
    console.log(`docker daemon ${stdout.trim()}`);
  } catch (error) {
    console.error(`FAIL: compose-isolation-check — no Docker daemon: ${String(error)}`);
    process.exit(1);
  }
  try {
    await docker(['image', 'inspect', `platform:${TAG}`, '--format', '{{.Id}}']);
  } catch {
    console.error(
      `FAIL: compose-isolation-check — platform:${TAG} is not on this daemon; ` +
        `build it with \`node scripts/build-images.mjs --tag ${TAG}\``,
    );
    process.exit(1);
  }

  const composes = PROJECTS.map((project) => ({ project, compose: composeFor(project) }));
  try {
    stages.set('docker compose up (both projects at once)');
    console.log(`starting ${PROJECTS.join(' and ')} from platform:${TAG} …`);
    // `allSettled`, not `all`: a rejected `up` must not hand the teardown below a sibling `up`
    // that is still creating, which `down -v` would race (review round 1).
    const started = await Promise.allSettled(
      composes.map(({ compose }) => compose(['up', '-d', '--no-build', 'app'])),
    );
    const refused = started.find((outcome) => outcome.status === 'rejected');
    if (refused !== undefined) throw refused.reason;
    for (const { project, compose } of composes) {
      stages.set(`${project}: docker compose port app 8080`);
      const baseUrl = `http://127.0.0.1:${await publishedPort(compose)}`;
      console.log(`${project} publishes app on ${baseUrl}`);
      await waitForOk(stages, `${baseUrl}/healthz`);
    }

    const own = [];
    for (const { project, compose } of composes) {
      stages.set(`${project}: reading its db container's addresses`);
      own.push(await dbAddresses(compose));
    }
    const networkOf = (addresses) => [...addresses.keys()].sort().join(',');
    check(
      'the two projects’ databases are on two different networks',
      own[0] !== undefined &&
        own[1] !== undefined &&
        [...own[0].keys()].every((network) => !own[1]?.has(network)),
      `${networkOf(own[0] ?? new Map())} | ${networkOf(own[1] ?? new Map())}`,
    );

    for (const [index, { project, compose }] of composes.entries()) {
      stages.set(`${project}: resolving and connecting to db from inside app`);
      const { stdout } = await compose(['exec', '-T', 'app', 'node', '-e', PROBE]);
      const answer = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
      const mine = new Set(own[index]?.values() ?? []);
      const theirs = new Set(own[1 - index]?.values() ?? []);
      const resolved = answer.resolved ?? [];
      check(
        `${project}: \`db\` resolves to its own database and to no other`,
        resolved.length > 0 &&
          resolved.every((address) => mine.has(address)) &&
          !resolved.some((address) => theirs.has(address)),
        `resolved ${JSON.stringify(resolved)}; own ${JSON.stringify([...mine])}; other ${JSON.stringify([...theirs])}`,
      );
      check(
        `${project}: its app's connection to db:5432 lands on its own database`,
        typeof answer.remote?.address === 'string' && mine.has(answer.remote.address),
        JSON.stringify(answer.remote ?? null),
      );
    }
  } catch (error) {
    const where = error instanceof Unsettled ? '' : ` (while: ${stages.current})`;
    check('both instances came up and answered', false, `${String(error)}${where}`);
  } finally {
    for (const { project, compose } of composes) {
      if (failures.length > 0) {
        await describeInstance(compose, `${project}: `);
      }
      stages.set(`${project}: docker compose down`);
      await compose(['down', '-v', '--remove-orphans']).catch((error) => {
        console.error(`cleanup of ${project} failed: ${String(error)}`);
      });
    }
    rmSync(OVERRIDE_DIRECTORY, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`FAIL: compose-isolation-check (${failures.length}): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('PASS: compose-isolation-check');
};

// The backstop for a wait nothing bounded (`compose-check-support.mjs`).
const finished = installExitBackstop('compose-isolation-check', stages);
await main();
finished();
