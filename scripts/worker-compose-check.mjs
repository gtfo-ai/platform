#!/usr/bin/env node
/**
 * `node scripts/worker-compose-check.mjs` — **WP-284 (4)'s Docker leg**: a core and a worker bundle
 * on one daemon, the worker logged in with the device flow scripted, and **one fake-Claude task run to
 * Ready per credential shape** through the worker (S-22.14, backlog 761, 763, 773). Run it with the four
 * images built (`node scripts/build-images.mjs`):
 *
 *     node scripts/worker-compose-check.mjs [--tag dev] [--project-suffix local]
 *
 * ## What it brings up
 *
 *  - **a local registry** (`registry:2` on a random port): the run and egress images (the run image
 *    derived below) are pushed to it and the worker bundle names them `localhost:<port>/…@sha256:<registry
 *    digest>` — so `docker compose up` **pulls them by registry digest**, as a real worker pulls the
 *    core's `sha-<7>` digests, and the core advertises exactly those digests (`APP_WORKER_IMAGE_DIGESTS`;
 *    backlog 704/763). The `platform` and `platform-launcher` digests are the local ids (nothing resolves
 *    them by digest on a worker);
 *  - **a derived run image** (`platform-runtime:<tag>-wcc`): the run image with
 *    `scripts/worker-check/fake-claude-stage.mjs` as `/usr/local/bin/claude` — a stage-aware CLI that
 *    answers each stage's artifact and, as the developer, asks `open_mr` through the SDK's MCP channel;
 *  - **the core**: `compose.yml` with the runner scaled to 0 (a `workers_only` core) and the `app`
 *    service's command replaced by `scripts/worker-check/core-entry.mjs` — the product's own
 *    `startRuntime()` with the fake git and tracker providers registered (the e2e tier's one seam),
 *    two seeded projects and a control port the check drives with `docker compose exec`;
 *  - **the worker bundle**: `compose.worker.yml` **as shipped**, under its own project name, control
 *    and cache volumes, run network (`APP_WORKER_RUN_NETWORK`) and UI port — a real worker on the same
 *    daemon (`agentic-worker`, `agentic-worker-run-egress`, 7357) is never joined, stopped or taken
 *    down — its `.env` naming the images and `APP_CORE_URL=http://app:8080`; the `remote-worker`
 *    joined to the core's network after `up`;
 *  - **two git stand-ins** on the worker's run network: `wcc-git` (`git http-backend` over HTTPS with the check's own CA, behind Basic auth,
 *    granting the static run token push) and `wcc-ssh` (`sshd` on 443, the throwaway deploy key's only
 *    `authorized_keys` line, its host key pinned in the core's SSH route).
 *
 * Every network the two compose projects declare gets an explicit `10.213.x.0/24` subnet from an
 * override file: Docker's default pools hold 31 networks, and on the machine that first ran this 23
 * bridge networks of other projects plus the core's four left none for the bundle (`all predefined
 * address pools have been fully subnetted`); the pools that remain are left for the runs' own
 * networks (backlog 790).
 *
 * ## What it asserts
 *
 *  1. the launcher token is **generated at first start** (`launcher-token`, 0600, 43 base64url
 *     characters) and **kept** across a second `up`;
 *  2. the worker refuses `DATABASE_URL` and `APP_SECRET_KEY` **by name** (a one-off `run` with each);
 *  3. the **device flow**, scripted: the code the worker logs is approved through
 *     `POST /api/workers/device/approve` as the bootstrap administrator; the worker stores its
 *     credential and its `/readyz` reads `core_handshake: ok`;
 *  4. `GET /api/worker/v1/compose.yml`, with no credential and no header, pins every image by digest
 *     and names no `latest`, and its SHA-256 is the handshake's `compose_bundle_digest` (backlog 743);
 *  5. the worker's launcher answers `deployKeyCarriage: relayed`, its `images` are the **registry
 *     digests** the bundle pulled and `heldImageDigests` names them, and the core's Workers row holds
 *     them (backlog 704/763);
 *  6. **two tasks to Ready**, every run on the worker under its first claim: `API-1` on the static
 *     HTTPS-token project (the HTTPS stand-in saw the token push `agentic/API-1`) and `DK-1` on the
 *     deploy-key project (the SSH stand-in holds `agentic/DK-1`, and the offers counted signatures);
 *  7. **canaries**: the Claude token is in no container's configured environment but the
 *     `remote-worker`'s and in no log line of the bundle; the run token, the worker credential and a
 *     fragment of the deploy key are in no log line of the bundle and the deploy key fragment in no
 *     bundle container's environment; no worker container carries a `DATABASE_URL` or an
 *     `APP_SECRET_KEY`;
 *  8. **the local page** (WP-292 (6), WP-294 (6)): under the default `APP_WORKER_UI_AUTH=none` the
 *     worker logs the plain address `http://127.0.0.1:<port>` and creates no `ui-token`; the publish
 *     is `127.0.0.1` only; the page and `/api/local/state` answer on `127.0.0.1` right after `up -d`
 *     with **no token**, and `421` for a foreign `Host`; `claude --version` runs from the
 *     `claude-cli` volume inside `remote-worker` (the run image's CLI — here the check's stand-in,
 *     which answers `--version` as the real one does — copied by the `pull-runtime-image` one-shot;
 *     a failure prints the exec's stderr in full, every secret value replaced by its name); a
 *     one-off `remote-worker` started with **no token and no URL** serves its page `200`, at the
 *     wizard's first step (`needs_platform`); the same port on the host's **other** address answers
 *     nothing; and **a run container** — each task's refinement run,
 *     through the fake CLI, against the worker's name and every address of it the check seeds into the
 *     repository (`.wcc-probe-targets`) — connects to none of them on the UI port. What a container on
 *     the run egress network (the sidecar's and the helpers' network, never a run's) reaches is
 *     printed as a `note`, not asserted (backlog 792);
 *  9. nothing is left: both projects are taken down with their volumes, and the stand-ins, the
 *     registry, the derived images and every object the worker's launcher labelled are removed.
 *
 * Not a `verify` target, for the reason none of the Docker checks are: it needs a daemon. With no
 * daemon or no image it exits 1 naming what is missing; a skip is never a pass.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  boundedFetch,
  composeEnvironment,
  createStages,
  describeInstance,
  installExitBackstop,
  publishedPort,
  refuseOldNode,
  waitForOk,
} from './compose-check-support.mjs';

refuseOldNode('worker-compose-check');

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const optionValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const TAG = optionValue('--tag', process.env.PLATFORM_TAG ?? 'dev');
const SUFFIX = optionValue('--project-suffix', process.env.GITHUB_RUN_ID ?? 'local');
const CORE = `agentic-worker-check-core-${SUFFIX}`;
const BUNDLE = `agentic-worker-check-bundle-${SUFFIX}`;
/** The run image with the stage-aware fake CLI, built here and removed at the end. */
const RUN_IMAGE = `platform-runtime:${TAG}-wcc`;
const REGISTRY = `agentic-wcc-registry-${SUFFIX}`;
const REGISTRY_IMAGE = 'registry:2';
const GIT_STANDIN = `agentic-wcc-git-${SUFFIX}`;
const SSH_STANDIN = `agentic-wcc-ssh-${SUFFIX}`;
/**
 * The bundle's run network, its own (`APP_WORKER_RUN_NETWORK`): a real worker on the same daemon owns
 * `agentic-worker-run-egress`, and this check must never join, take down or share it.
 */
const RUN_NETWORK = `${BUNDLE}-run-egress`;
const ALPINE_IMAGE = 'alpine:3.21';

/** Obviously fake (BD-002), past every floor, and in no shape a pattern rule knows. */
const SECRET_KEY = 'wp284-worker-compose-check-not-a-real-secret-0000';
const ADMIN_EMAIL = 'operator@example.test';
const ADMIN_PASSWORD = 'wp284-not-a-real-password';
const CLAUDE_TOKEN = 'FAKE-wp284-claude-oauth-token-not-a-credential-0001';
/** The static run token the HTTPS stand-in grants push with (S-22.14). */
const RUN_TOKEN = 'FAKE-wcc-static-run-token-not-a-credential-0001';
const ORIGIN = 'http://worker-compose-check.example.test';
/** The host port the bundle publishes the worker's page on (`APP_WORKER_UI_PORT`), off the default. */
const UI_PORT = 37357;
const TIMEOUT_MS = 15 * 60 * 1000;
const DOCKER_QUERY_MS = 60_000;
/** How long both tasks may take to reach Ready — eight to ten runs, one at a time. */
const READY_MS = 12 * 60 * 1000;

const stages = createStages();
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};
/** Every image reference this check created, removed at the end whatever happened. */
const madeImages = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (dockerArgs, options = {}) =>
  run('docker', dockerArgs, { timeout: DOCKER_QUERY_MS, maxBuffer: 64 * 1024 * 1024, ...options });
const quietly = (dockerArgs) => docker(dockerArgs).catch(() => undefined);

const compose =
  (project, files, directory) =>
  async (composeArgs, extraEnv = {}, options = {}) =>
    run(
      'docker',
      [
        'compose',
        '-p',
        project,
        '--project-directory',
        directory,
        ...files.flatMap((file) => ['-f', file]),
        ...composeArgs,
      ],
      {
        cwd: REPO,
        env: { ...process.env, PLATFORM_TAG: TAG, ...extraEnv },
        maxBuffer: 64 * 1024 * 1024,
        timeout: TIMEOUT_MS,
        ...options,
      },
    );

/**
 * What a failed `execFile` says, whole: how it ended, its stderr and its stdout, in full — with every
 * secret value the check holds replaced by its name, so a failure detail can never print one.
 */
const failureDetail = (error, secrets) => {
  const redact = (text) =>
    Object.entries(secrets).reduce(
      (current, [name, value]) =>
        typeof value === 'string' && value.length > 0
          ? current.split(value).join(`[${name}]`)
          : current,
      String(text ?? ''),
    );
  const ended = error?.killed
    ? `killed (${error.signal ?? 'signal'}) after its timeout`
    : `exit ${String(error?.code ?? 'unknown')}${error?.signal ? ` (${error.signal})` : ''}`;
  return redact(
    `${ended}\n--- stderr\n${error?.stderr ?? ''}\n--- stdout\n${error?.stdout ?? ''}\n--- error\n${error?.message ?? String(error)}`,
  );
};

const imageId = async (image) =>
  (await docker(['image', 'inspect', image, '--format', '{{.Id}}'])).stdout.trim();

/**
 * An override giving every network of a compose file an explicit subnet — `10.213.<first + n>.0/24`
 * — and, for the core, its run network a check-only name (the stock name is the operator's own
 * instance's network, which this check must never take down).
 */
const networkOverride = (networks, first, renamed = {}) =>
  [
    'networks:',
    ...networks.flatMap((name, index) => [
      `  ${name}:`,
      ...(renamed[name] === undefined ? [] : [`    name: ${renamed[name]}`]),
      '    ipam:',
      '      config:',
      `        - subnet: 10.213.${first + index}.0/24`,
    ]),
    '',
  ].join('\n');

/** A TCP port free on this host now, on both address families. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '::', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const preflight = async () => {
  try {
    const { stdout } = await docker(['version', '--format', '{{.Server.Version}}']);
    console.log(`docker daemon ${stdout.trim()}`);
  } catch (error) {
    console.error(`FAIL: worker-compose-check — no Docker daemon: ${String(error)}`);
    process.exit(1);
  }
  const ids = {};
  for (const image of ['platform', 'platform-launcher', 'platform-runtime', 'platform-egress']) {
    try {
      ids[image] = await imageId(`${image}:${TAG}`);
    } catch {
      console.error(
        `FAIL: worker-compose-check — ${image}:${TAG} is not on this daemon; build it with \`node scripts/build-images.mjs --tag ${TAG}\``,
      );
      process.exit(1);
    }
  }
  try {
    await run('ssh-keygen', ['-?'], { timeout: DOCKER_QUERY_MS }).catch((error) => {
      if (error.code === 'ENOENT') throw error;
    });
  } catch {
    console.error(
      'FAIL: worker-compose-check — ssh-keygen is not on PATH (the throwaway deploy key)',
    );
    process.exit(1);
  }
  return ids;
};

/** A cookie jar and the cross-site headers every mutating request needs (technical/08). */
class Client {
  #baseUrl;
  #cookies = new Map();
  constructor(baseUrl) {
    this.#baseUrl = baseUrl;
  }
  async json(route, init = {}) {
    const cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const { response, body: text } = await boundedFetch(stages, `${this.#baseUrl}${route}`, {
      ...init,
      headers: {
        origin: ORIGIN,
        'x-requested-with': 'XMLHttpRequest',
        ...(cookie === '' ? {} : { cookie }),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
      redirect: 'manual',
    });
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (pair !== undefined && separator > 0) {
        this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      // kept as text
    }
    return { status: response.status, body, text };
  }
}

/** The throwaway deploy key: generated here, never written anywhere but a scratch file removed at once. */
const deployKey = async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'wcc-key-'));
  try {
    const file = path.join(scratch, 'k');
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'wcc-check', '-f', file]);
    const privateKey = await readFile(file, 'utf8');
    const publicKey = (await readFile(`${file}.pub`, 'utf8'))
      .trim()
      .split(' ')
      .slice(0, 2)
      .join(' ');
    // 24 characters of the base64 that carries the seed, as `deploy-key-check.mjs` searches for.
    const fragment = (privateKey.trim().split('\n')[4] ?? '').slice(4, 28);
    return { privateKey, publicKey, fragment };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

/**
 * The run image with the stage-aware CLI, then the run and egress images pushed to the loopback
 * registry: answers their **registry** digests and the references the bundle pulls them by.
 */
/** The pinned git helper image `compose.worker.yml` names (`APP_WORKSPACE_GIT_IMAGE`'s default). */
const GIT_HELPER_IMAGE =
  'alpine/git:v2.49.1@sha256:c0280cf9572316299b08544065d3bf35db65043d5e3963982ec50647d2746e26';
/** The git helper image with the check's CA, built here and removed at the end. */
const GIT_IMAGE = `agentic-wcc-git-helper:${SUFFIX}`;

/**
 * A throwaway CA and the HTTPS stand-in's certificate for `wcc-git`, made with the run image's own
 * `openssl`. The token project's remote is `https://` as a real one is: a run container reaches it
 * only through the egress sidecar's `CONNECT`, and git there reads `HTTPS_PROXY` (an `http://`
 * remote is not pushed through the proxy at all — measured, backlog 793).
 */
const makeTls = async (checkDirectory) => {
  const directory = path.join(checkDirectory, 'tls');
  await run('mkdir', ['-p', directory]);
  await chmod(directory, 0o777);
  await docker(
    [
      'run',
      '--rm',
      '--user',
      '0:0',
      '-v',
      `${directory}:/out`,
      '--entrypoint',
      'sh',
      `platform-runtime:${TAG}`,
      '-c',
      [
        'set -e',
        'cd /out',
        'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=wcc-check-ca -keyout ca.key -out ca.crt -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign 2>/dev/null',
        'openssl req -newkey rsa:2048 -nodes -subj /CN=wcc-git -keyout server.key -out server.csr 2>/dev/null',
        "printf 'subjectAltName=DNS:wcc-git\\nbasicConstraints=CA:FALSE\\nextendedKeyUsage=serverAuth\\n' > ext",
        'openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 -extfile ext -out server.crt 2>/dev/null',
        'chmod 644 ca.crt server.crt server.key',
      ].join('\n'),
    ],
    { timeout: TIMEOUT_MS },
  );
  const read = (name) => readFile(path.join(directory, name), 'utf8');
  return {
    ca: await read('ca.crt'),
    key: await read('server.key'),
    cert: await read('server.crt'),
  };
};

/** The git helper image with the check's CA appended to its bundle — what the mirror helper trusts. */
const buildGitHelperImage = async (checkDirectory, tls) => {
  const context = path.join(checkDirectory, 'git-image');
  await run('mkdir', ['-p', context]);
  await writeFile(path.join(context, 'wcc-ca.crt'), tls.ca);
  await writeFile(
    path.join(context, 'Dockerfile'),
    [
      `FROM ${GIT_HELPER_IMAGE}`,
      'COPY wcc-ca.crt /tmp/wcc-ca.crt',
      'RUN cat /tmp/wcc-ca.crt >> /etc/ssl/certs/ca-certificates.crt && rm /tmp/wcc-ca.crt',
      '',
    ].join('\n'),
  );
  stages.set('the derived git helper image');
  await docker(['build', '-q', '-t', GIT_IMAGE, context], { timeout: TIMEOUT_MS });
  madeImages.push(GIT_IMAGE);
};

const publishRunImages = async (checkDirectory, tls) => {
  const context = path.join(checkDirectory, 'run-image');
  await run('mkdir', ['-p', context]);
  await writeFile(path.join(context, 'wcc-ca.crt'), tls.ca);
  await copyFile(
    path.join(REPO, 'scripts', 'worker-check', 'fake-claude-stage.mjs'),
    path.join(context, 'claude'),
  );
  await writeFile(
    path.join(context, 'Dockerfile'),
    [
      `FROM platform-runtime:${TAG}`,
      'USER root',
      'COPY --chmod=0755 claude /usr/local/bin/claude',
      'COPY wcc-ca.crt /tmp/wcc-ca.crt',
      'RUN cat /tmp/wcc-ca.crt >> /etc/ssl/certs/ca-certificates.crt && rm /tmp/wcc-ca.crt',
      'USER 1000:1000',
      '',
    ].join('\n'),
  );
  stages.set('the derived run image');
  await docker(['build', '-q', '-t', RUN_IMAGE, context], { timeout: TIMEOUT_MS });

  stages.set('the loopback registry');
  // Published on every interface, and pushed to as `localhost`: on Docker Desktop the daemon runs in a
  // VM whose loopback is not the host's, and a `127.0.0.1`-only publish is unreachable from it
  // (measured: `localhost` → `dial tcp [::1]:<port>: i/o timeout`, `127.0.0.1` → `connection
  // refused`); an all-interface publish is reachable as `localhost`, which the daemon treats as an
  // insecure (plain HTTP) registry by default. Exposed for the check's minutes with test images only,
  // and every pull is **by digest**, so nothing pushed to it meanwhile can stand in for them.
  // One port for both address families: a bare `-p 5000` gave IPv4 and IPv6 different host ports on
  // Docker Desktop, and `localhost` dials `::1` first (measured: `i/o timeout` on the IPv4 port).
  const port = await freePort();
  await docker(['run', '-d', '--name', REGISTRY, '-p', `${port}:5000`, REGISTRY_IMAGE], {
    timeout: TIMEOUT_MS,
  });
  const host = `localhost:${port}`;
  stages.set('the registry answers /v2/');
  await waitForOk(stages, `http://127.0.0.1:${port}/v2/`);
  const published = {};
  for (const [role, local, name] of [
    ['run', RUN_IMAGE, 'platform-runtime'],
    ['egress', `platform-egress:${TAG}`, 'platform-egress'],
  ]) {
    const pushed = `${host}/${name}:wcc`;
    await docker(['tag', local, pushed]);
    madeImages.push(pushed);
    stages.set(`docker push ${pushed}`);
    await docker(['push', pushed], { timeout: TIMEOUT_MS });
    // The registry's own answer, never the push's progress text: under the containerd store a local
    // multi-platform index is pushed as its one present platform, so the registry's digest is not
    // the local id (measured: `alpine:3.21` `ee16d92f…` pushed as `70dd3b2d…`).
    const { response } = await boundedFetch(
      stages,
      `http://127.0.0.1:${port}/v2/${name}/manifests/wcc`,
      {
        method: 'HEAD',
        headers: {
          accept: [
            'application/vnd.oci.image.index.v1+json',
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.list.v2+json',
            'application/vnd.docker.distribution.manifest.v2+json',
          ].join(', '),
        },
      },
    );
    const digest = response.headers.get('docker-content-digest');
    if (digest === null || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`the registry names no digest for ${pushed}`);
    }
    // Untagged, so `docker compose up` pulls the digest reference rather than finding a tag.
    await docker(['image', 'rm', pushed]);
    published[role] = { digest, reference: `${host}/${name}@${digest}` };
    madeImages.push(published[role].reference);
  }
  return published;
};

/** `git http-backend` behind Basic auth: `docker-workspace.ts`'s credentialled server, one token. */
const GIT_SERVER_PROGRAM = String.raw`
const https = require('node:https');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
https.createServer({ key: process.env.TLS_KEY, cert: process.env.TLS_CERT }, (req, res) => {
  const url = new URL(req.url, 'http://standin');
  const service = url.searchParams.get('service') ??
    (url.pathname.endsWith('/git-receive-pack') ? 'git-receive-pack'
      : url.pathname.endsWith('/git-upload-pack') ? 'git-upload-pack' : null);
  const header = req.headers.authorization ?? '';
  let password = null;
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    password = decoded.slice(decoded.indexOf(':') + 1);
  }
  const granted = password !== null && password === process.env.RUN_TOKEN;
  fs.appendFileSync('/tmp/access.log', JSON.stringify({
    method: req.method, path: url.pathname, service, granted,
  }) + '\n');
  if (!granted) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="wcc"' });
    res.end('authentication required');
    return;
  }
  const child = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: '/tmp/srv', GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
      GIT_PROTOCOL: req.headers['git-protocol'] ?? '', REMOTE_USER: 'agentic', REMOTE_ADDR: '127.0.0.1',
    },
  });
  req.pipe(child.stdin);
  let head = Buffer.alloc(0);
  let sent = false;
  child.stdout.on('data', (chunk) => {
    if (sent) { res.write(chunk); return; }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end === -1) return;
    let status = 200;
    const headers = {};
    for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
      const colon = line.indexOf(':');
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10);
      else headers[key] = value;
    }
    res.writeHead(status, headers);
    sent = true;
    res.write(head.subarray(end + 4));
  });
  child.stdout.on('end', () => res.end());
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
}).listen(443);
`;

const startStandins = async (checkDirectory, key, probeTargets, tls) => {
  stages.set('the HTTPS git stand-in');
  await docker([
    'run',
    '-d',
    '--name',
    GIT_STANDIN,
    '--network',
    RUN_NETWORK,
    '--network-alias',
    'wcc-git',
    '--user',
    '0:0',
    '-e',
    `RUN_TOKEN=${RUN_TOKEN}`,
    '-e',
    `PROBE=${JSON.stringify(probeTargets)}`,
    '-e',
    `TLS_KEY=${tls.key}`,
    '-e',
    `TLS_CERT=${tls.cert}`,
    '-e',
    `SERVER=${GIT_SERVER_PROGRAM}`,
    '--entrypoint',
    'sh',
    `platform-runtime:${TAG}`,
    '-c',
    [
      'set -e',
      'export HOME=/tmp',
      'mkdir -p /tmp/srv/acme /tmp/seed',
      'git init -q --bare --initial-branch=main /tmp/srv/acme/api.git',
      'git -C /tmp/srv/acme/api.git config http.receivepack true',
      'cd /tmp/seed && git init -q --initial-branch=main',
      'git config user.email standin@example.invalid && git config user.name standin',
      'printf "# worker check\\n" > README.md && printf %s "$PROBE" > .wcc-probe-targets',
      'git add -A && git commit -q -m seed',
      'git push -q /tmp/srv/acme/api.git main',
      ': > /tmp/access.log',
      'exec node -e "$SERVER"',
    ].join('\n'),
  ]);

  stages.set('the SSH git stand-in');
  await docker([
    'run',
    '-d',
    '--name',
    SSH_STANDIN,
    '--network',
    RUN_NETWORK,
    '--network-alias',
    'wcc-ssh',
    '-e',
    `DEPLOY_PUB=${key.publicKey}`,
    '-e',
    `PROBE=${JSON.stringify(probeTargets)}`,
    ALPINE_IMAGE,
    'sh',
    '-c',
    [
      'set -e',
      'apk add --no-cache git openssh-server >/dev/null 2>&1',
      'adduser -D -h /home/git -s /usr/bin/git-shell git',
      "sed -i 's/^git:!/git:*/' /etc/shadow",
      'mkdir -p /home/git/.ssh',
      'printf "%s\\n" "$DEPLOY_PUB" > /home/git/.ssh/authorized_keys',
      'chown -R git:git /home/git/.ssh && chmod 700 /home/git/.ssh && chmod 600 /home/git/.ssh/authorized_keys',
      'mkdir -p /acme && git init --bare -q --initial-branch=main /acme/dk.git',
      'mkdir -p /seed && cd /seed && git init -q --initial-branch=main',
      'git config user.email standin@example.invalid && git config user.name standin',
      'printf "# deploy-key stand-in\\n" > README.md && printf %s "$PROBE" > .wcc-probe-targets',
      'git add -A && git commit -q -m seed',
      'git push -q /acme/dk.git main && chown -R git:git /acme',
      'ssh-keygen -A >/dev/null',
      'exec /usr/sbin/sshd -D -e -p 443',
    ].join('\n'),
  ]);
  let hostKey = null;
  for (let attempt = 0; attempt < 240 && hostKey === null; attempt += 1) {
    const logs = await docker(['logs', SSH_STANDIN]).catch(() => ({ stdout: '', stderr: '' }));
    if (`${logs.stdout}\n${logs.stderr}`.includes('Server listening')) {
      const read = await docker(['exec', SSH_STANDIN, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']);
      hostKey = read.stdout.trim().split(' ').slice(0, 2).join(' ');
    } else {
      await sleep(500);
    }
  }
  check('the SSH stand-in listens on 443 with an Ed25519 host key', hostKey !== null);
  if (hostKey === null) throw new Error('the SSH stand-in never started');
  // The core's SSH route reads this per call (`core-entry.mjs`).
  await writeFile(path.join(checkDirectory, 'known_hosts'), `wcc-ssh ${hostKey}\n`);
  await chmod(path.join(checkDirectory, 'known_hosts'), 0o644);
};

/** The labelled objects the worker's launcher made: containers, then networks, then volumes. */
const removeLauncherObjects = async () => {
  const label = `com.agentic.instance=${BUNDLE}-ctl`;
  const containers = (await quietly(['ps', '-aq', '--filter', `label=${label}`]))?.stdout ?? '';
  for (const id of containers.split('\n').filter(Boolean)) await quietly(['rm', '-f', '-v', id]);
  const networks =
    (await quietly(['network', 'ls', '-q', '--filter', `label=${label}`]))?.stdout ?? '';
  for (const id of networks.split('\n').filter(Boolean)) await quietly(['network', 'rm', id]);
  const volumes =
    (await quietly(['volume', 'ls', '-q', '--filter', `label=${label}`]))?.stdout ?? '';
  for (const name of volumes.split('\n').filter(Boolean)) await quietly(['volume', 'rm', name]);
  await quietly(['volume', 'rm', `${BUNDLE}-repo-cache`]);
};

const main = async () => {
  const ids = await preflight();
  const coreDirectory = await mkdtemp(path.join(tmpdir(), 'worker-check-core-'));
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), 'worker-check-bundle-'));
  const checkDirectory = await mkdtemp(path.join(tmpdir(), 'worker-check-shared-'));
  await chmod(checkDirectory, 0o755);
  await writeFile(path.join(checkDirectory, 'known_hosts'), '');
  await chmod(path.join(checkDirectory, 'known_hosts'), 0o644);
  const coreOverride = path.join(coreDirectory, 'compose.check.yml');
  const bundleOverride = path.join(bundleDirectory, 'compose.check.yml');
  const core = compose(CORE, [path.join(REPO, 'compose.yml'), coreOverride], coreDirectory);
  const bundle = compose(
    BUNDLE,
    [path.join(REPO, 'compose.worker.yml'), bundleOverride],
    bundleDirectory,
  );
  // The two overrides first, so a failure's `describeInstance` can read both projects.
  await writeFile(
    coreOverride,
    [
      'services:',
      '  app:',
      "    command: ['apps/server/worker-check/core-entry.mjs']",
      '    volumes:',
      `      - ${path.join(REPO, 'scripts', 'worker-check')}:/app/apps/server/worker-check:ro`,
      `      - ${checkDirectory}:/check:ro`,
      networkOverride(['default', 'run-egress', 'docker-proxy', 'launcher-api'], 1, {
        'run-egress': `${CORE}-run-egress`,
      }),
    ].join('\n'),
  );
  await writeFile(
    bundleOverride,
    networkOverride(['default', 'run-egress', 'docker-proxy', 'launcher-api'], 5),
  );
  const key = await deployKey();
  try {
    stages.set('the stand-in’s TLS');
    const tls = await makeTls(checkDirectory);
    await buildGitHelperImage(checkDirectory, tls);
    const images = await publishRunImages(checkDirectory, tls);
    console.log(
      `run image ${images.run.reference}\negress image ${images.egress.reference} (both pulled by digest)`,
    );
    const digests = [
      `platform=${ids.platform}`,
      `platform_launcher=${ids['platform-launcher']}`,
      `platform_runtime=${images.run.digest}`,
      `platform_egress=${images.egress.digest}`,
    ].join(',');

    // ── The core: workers_only, no runner, the fake providers ───────────────────────────────
    await writeFile(
      path.join(coreDirectory, '.env'),
      [
        `APP_SECRET_KEY=${SECRET_KEY}`,
        `APP_BASE_URL=${ORIGIN}`,
        `APP_BOOTSTRAP_ADMIN_EMAIL=${ADMIN_EMAIL}`,
        `APP_BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PASSWORD}`,
        `APP_WORKER_IMAGE_DIGESTS=${digests}`,
        'APP_JOBS_POLL_INTERVAL_SECONDS=0.5',
        'APP_DISPATCH_POLL_INTERVAL_MS=50',
        'APP_PORT=0',
        `WCC_RUN_TOKEN=${RUN_TOKEN}`,
        `WCC_DEPLOY_PRIVATE_KEY_B64=${Buffer.from(key.privateKey, 'utf8').toString('base64')}`,
        `WCC_DEPLOY_PUBLIC_KEY=${key.publicKey}`,
        '',
      ].join('\n'),
    );
    stages.set('core: docker compose up');
    await core(['up', '-d', '--no-build', '--scale', 'runner=0'], composeEnvironment(CORE));
    const coreUrl = `http://127.0.0.1:${await publishedPort(core)}`;
    await waitForOk(stages, `${coreUrl}/healthz`);
    const admin = new Client(coreUrl);
    const signedIn = await admin.json('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    check('the bootstrap administrator signs in', signedIn.status === 200, String(signedIn.status));
    const control = async (method, route) =>
      JSON.parse(
        (
          await core([
            'exec',
            '-T',
            'app',
            'curl',
            '-fsS',
            '-X',
            method,
            `http://127.0.0.1:9099${route}`,
          ])
        ).stdout,
      );

    // ── The bundle, as shipped ──────────────────────────────────────────────────────────────
    await writeFile(
      path.join(bundleDirectory, '.env'),
      [
        'APP_CORE_URL=http://app:8080',
        `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}`,
        `PLATFORM_IMAGE=platform:${TAG}`,
        `PLATFORM_LAUNCHER_IMAGE=platform-launcher:${TAG}`,
        `PLATFORM_RUNTIME_IMAGE=${images.run.reference}`,
        `PLATFORM_EGRESS_IMAGE=${images.egress.reference}`,
        `APP_WORKER_CONTROL_VOLUME=${BUNDLE}-ctl`,
        `APP_WORKER_RUN_NETWORK=${RUN_NETWORK}`,
        `APP_WORKSPACE_GIT_IMAGE=${GIT_IMAGE}`,
        `APP_WORKER_CACHE_VOLUME=${BUNDLE}-repo-cache`,
        `APP_WORKER_UI_PORT=${UI_PORT}`,
        '',
      ].join('\n'),
    );
    stages.set('bundle: docker compose up');
    await bundle(['up', '-d', '--no-build']);
    const workerContainer = (await bundle(['ps', '-q', 'remote-worker'])).stdout.trim();
    await docker(['network', 'connect', `${CORE}_default`, workerContainer]);

    // 1. The launcher token: generated once, kept.
    const readToken = async () =>
      (
        await bundle([
          'exec',
          '-T',
          'remote-worker',
          'sh',
          '-c',
          'stat -c %a /var/lib/platform/launcher-token/token && cat /var/lib/platform/launcher-token/token',
        ])
      ).stdout
        .trim()
        .split('\n');
    const [mode, token] = await readToken();
    check(
      'the launcher token is generated at first start, 0600',
      mode === '600' && /^[A-Za-z0-9_-]{43}$/.test(token ?? ''),
      mode,
    );
    await bundle(['up', '-d', '--no-build']);
    const [, again] = await readToken();
    check('the launcher token is kept across a second up', again === token);

    // 2. The worker refuses a database URL and a secret key by name.
    for (const name of ['DATABASE_URL', 'APP_SECRET_KEY']) {
      let refused = '';
      try {
        await bundle([
          'run',
          '--rm',
          '--no-deps',
          '-e',
          `${name}=postgres://not-for-a-worker`,
          'remote-worker',
        ]);
      } catch (error) {
        refused = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      }
      check(
        `the worker refuses ${name} by name`,
        refused.includes(`${name} is set`),
        refused.slice(0, 200),
      );
    }

    // 3. The device flow, scripted.
    stages.set('the worker’s device code in its log');
    let userCode = null;
    for (let tries = 0; tries < 60 && userCode === null; tries += 1) {
      const { stdout } = await bundle(['logs', 'remote-worker']);
      userCode = /"user_code":"([A-Z]{4}-[A-Z]{4})"/.exec(stdout)?.[1] ?? null;
      if (userCode === null) await sleep(2_000);
    }
    check('the worker logs a device code', userCode !== null);
    const approved = await admin.json('/api/workers/device/approve', {
      method: 'POST',
      body: JSON.stringify({
        decision: 'approve',
        user_code: userCode,
        name: 'check-laptop',
        confirm_stale: false,
      }),
    });
    check(
      'the code is approved',
      approved.status === 200,
      JSON.stringify(approved.body).slice(0, 200),
    );
    stages.set('the worker’s /readyz');
    let ready = '';
    for (let tries = 0; tries < 60; tries += 1) {
      try {
        ready = (
          await bundle([
            'exec',
            '-T',
            'remote-worker',
            'curl',
            '-fsS',
            'http://127.0.0.1:8080/readyz',
          ])
        ).stdout;
        if (ready.includes('"core_handshake":"ok"')) break;
      } catch {
        // not yet
      }
      await sleep(2_000);
    }
    check(
      'the worker’s /readyz reads core_handshake: ok',
      ready.includes('"core_handshake":"ok"'),
      ready.trim(),
    );
    // The first line: since WP-294 the file names its core on a second (`readStoredCredential`).
    const [credentialLine = ''] = (
      await bundle([
        'exec',
        '-T',
        'remote-worker',
        'cat',
        '/var/lib/platform/worker-state/credential',
      ])
    ).stdout.split('\n');
    const credential = credentialLine.trim();
    check(
      'the credential is stored in worker-state',
      /^wkr_[a-z2-7]{26}_[A-Za-z0-9_-]{43}$/.test(credential),
    );

    // 4. compose.yml, pinned by digest, its SHA-256 the handshake's bundle digest.
    const worker = new Client(coreUrl);
    // The protocol this build's worker speaks (`WORKER_PROTOCOL_VERSION`, 4 since S-26.4): a
    // literal, as this script reads no TypeScript; a stale one is a `426` here, by name.
    const headers = { 'x-worker-protocol': '4', authorization: `Bearer ${credential}` };
    // Public, with no header at all (TD-031's 2026-11-05 amendment): a person's first-install download.
    const file = await worker.json('/api/worker/v1/compose.yml');
    const pinned = [...String(file.text).matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map(
      (match) => match[1],
    );
    check(
      'compose.yml pins every image by digest and names no latest',
      file.status === 200 &&
        pinned.length > 0 &&
        pinned.every(
          (image) => /@sha256:[0-9a-f]{64}\}?$/.test(image) && !image.includes('latest'),
        ),
      pinned.join(' '),
    );
    const handshake = await worker.json('/api/worker/v1/handshake', {
      method: 'POST',
      headers,
      body: JSON.stringify({ image_digests: [], commit: null }),
    });
    check(
      'the handshake’s compose_bundle_digest is the served file’s SHA-256 (backlog 743)',
      handshake.body?.compose_bundle_digest ===
        createHash('sha256').update(String(file.text), 'utf8').digest('hex'),
      `${handshake.status} ${JSON.stringify(handshake.body).slice(0, 160)}`,
    );

    // 5. The launcher relays, and speaks the registry digests the bundle pulled (backlog 704/763).
    const health = JSON.parse(
      (
        await bundle([
          'exec',
          '-T',
          'remote-worker',
          'sh',
          '-c',
          'curl -fsS -H "authorization: Bearer $(cat /var/lib/platform/launcher-token/token)" http://launcher:7780/v1/health',
        ])
      ).stdout,
    );
    check(
      'the worker’s launcher applies the relayed carriage',
      health.deployKeyCarriage === 'relayed',
    );
    check(
      'the launcher’s health answers the registry digests the bundle pulled (backlog 704)',
      health.images?.run === images.run.digest && health.images?.egress === images.egress.digest,
      JSON.stringify(health.images),
    );
    check(
      'the launcher holds both registry digests (heldImageDigests)',
      [images.run.digest, images.egress.digest].every((digest) =>
        (health.heldImageDigests ?? []).includes(digest),
      ),
      JSON.stringify(health.heldImageDigests),
    );
    stages.set('the core’s Workers row');
    let held = [];
    for (let tries = 0; tries < 30; tries += 1) {
      const listed = await admin.json('/api/workers');
      const row = (listed.body?.items ?? []).find((candidate) => candidate.name === 'check-laptop');
      held = row?.image_digests ?? [];
      if ([images.run.digest, images.egress.digest].every((digest) => held.includes(digest))) break;
      await sleep(2_000);
    }
    check(
      'the core’s Workers row holds the registry digests it advertises (backlog 763)',
      [images.run.digest, images.egress.digest].every((digest) => held.includes(digest)),
      JSON.stringify(held),
    );

    // 6. One task to Ready per credential shape.
    const workerAddress = (
      await docker([
        'inspect',
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
        workerContainer,
      ])
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    await startStandins(checkDirectory, key, ['remote-worker', ...workerAddress], tls);
    stages.set('two tasks to Ready');
    await control('POST', '/start/API-1');
    await control('POST', '/start/DK-1');
    const deadline = Date.now() + READY_MS;
    let state = await control('GET', '/state');
    const done = (task) =>
      task.state === 'ready_for_merge' ||
      ['needs_human', 'cancelled', 'paused'].includes(task.state);
    while (Date.now() < deadline && !(state.tasks.length === 2 && state.tasks.every(done))) {
      await sleep(3_000);
      state = await control('GET', '/state');
    }
    for (const [ticket, shape] of [
      ['API-1', 'a static HTTPS token (remote_run_credential: allow)'],
      ['DK-1', 'a deploy key through the helper socket'],
    ]) {
      const task = state.tasks.find((candidate) => candidate.ticket_key === ticket);
      const runs = state.runs.filter((candidate) => candidate.task_id === task?.id);
      check(
        `${ticket} reaches Ready on the worker with ${shape}`,
        task?.state === 'ready_for_merge',
        `${task?.state ?? 'no task'} at ${task?.current_stage ?? '—'}; runs ${runs
          .map((r) => `${r.stage}:${r.status}${r.reason === null ? '' : `/${r.reason}`}`)
          .join(' ')}`,
      );
      check(
        `${ticket}: every run completed on the worker under its first claim`,
        runs.length > 0 &&
          runs.every(
            (r) => r.status === 'completed' && r.claimant_kind === 'worker' && r.lease_epoch === 1,
          ),
        `${runs.length} runs`,
      );
      if (ticket === 'DK-1') {
        check(
          'DK-1: the core signed for the worker’s mirror fetches (ssh_signatures)',
          runs.some((r) => (r.ssh_signatures ?? 0) > 0),
          runs.map((r) => r.ssh_signatures ?? 0).join(','),
        );
      }
    }
    // WP-292 (6), asked from inside each task's refinement run container (`fake-claude-stage.mjs`).
    for (const ticket of ['API-1', 'DK-1']) {
      const task = state.tasks.find((candidate) => candidate.ticket_key === ticket);
      const lines = state.said
        .filter((row) => row.task_id === task?.id)
        .flatMap((row) => String(row.text).split('\n'))
        .filter((line) => line.includes('wcc-probe'));
      check(
        `${ticket}: a run container connects to no UI port of the worker (WP-292 (6))`,
        lines.length > 0 && lines.every((line) => line.includes(' unreachable')),
        lines.join('; ') || 'no probe reported',
      );
    }
    if (failures.length > 0) {
      console.error(`--- state\n${JSON.stringify(state, null, 1).slice(0, 6000)}`);
      const { stdout } = await bundle(['logs', '--no-color', 'remote-worker', 'launcher']);
      console.error(
        `--- the bundle's warnings and errors\n${stdout
          .split('\n')
          .filter((line) => /"level":(40|50|60)/.test(line))
          .slice(-60)
          .join('\n')}`,
      );
    }
    const access = (await docker(['exec', GIT_STANDIN, 'cat', '/tmp/access.log'])).stdout;
    check(
      'API-1: the HTTPS stand-in took a push authenticated by the static run token',
      access
        .split('\n')
        .filter(Boolean)
        .some((line) => {
          const entry = JSON.parse(line);
          return entry.service === 'git-receive-pack' && entry.granted;
        }),
    );
    const apiRefs = (
      await docker(['exec', GIT_STANDIN, 'git', '--git-dir=/tmp/srv/acme/api.git', 'branch'])
    ).stdout;
    check(
      'API-1: agentic/API-1 is on the HTTPS stand-in',
      apiRefs.includes('agentic/API-1'),
      apiRefs.trim(),
    );
    const dkRefs = (await docker(['exec', SSH_STANDIN, 'git', '--git-dir=/acme/dk.git', 'branch']))
      .stdout;
    check(
      'DK-1: agentic/DK-1 is on the SSH stand-in',
      dkRefs.includes('agentic/DK-1'),
      dkRefs.trim(),
    );

    // 7. Canaries.
    const containers = [
      ...(await bundle(['ps', '-q', '--all'])).stdout.trim().split('\n'),
      ...((
        await quietly(['ps', '-aq', '--filter', `label=com.agentic.instance=${BUNDLE}-ctl`])
      )?.stdout
        .trim()
        .split('\n') ?? []),
    ].filter(Boolean);
    for (const id of containers) {
      const { stdout } = await docker([
        'inspect',
        '--format',
        '{{.Name}} {{json .Config.Env}}',
        id,
      ]);
      const name = stdout.split(' ')[0];
      const isWorker = stdout.includes('remote-worker');
      check(
        `${name}: the Claude token only where it belongs`,
        isWorker || !stdout.includes(CLAUDE_TOKEN),
      );
      check(
        `${name}: no DATABASE_URL, no APP_SECRET_KEY`,
        !/DATABASE_URL=|APP_SECRET_KEY=/.test(stdout),
      );
      check(`${name}: no fragment of the deploy key`, !stdout.includes(key.fragment));
    }
    const logs = (await bundle(['logs'])).stdout;
    check('the Claude token is in no log line of the bundle', !logs.includes(CLAUDE_TOKEN));
    check('the worker credential is in no log line of the bundle', !logs.includes(credential));
    check('the static run token is in no log line of the bundle', !logs.includes(RUN_TOKEN));
    check(
      'no fragment of the deploy key is in a log line of the bundle',
      !logs.includes(key.fragment),
    );

    // 8. The local page (WP-292 (6)), with no token by default (WP-294 (6)).
    stages.set('the worker’s local page');
    check(
      'the worker logs its page’s plain address (APP_WORKER_UI_AUTH=none)',
      logs.includes(`this worker's page: http://127.0.0.1:${UI_PORT}`) && !logs.includes('#token='),
    );
    const tokenFile = await bundle([
      'exec',
      '-T',
      'remote-worker',
      'sh',
      '-c',
      'test -e /var/lib/platform/worker-state/ui-token && echo present || echo absent',
    ]);
    check('no ui-token is created under none', tokenFile.stdout.trim() === 'absent');
    // The volume holds the check's run image's `claude` — `fake-claude-stage.mjs`, which answers
    // `--version` as the real CLI does. Bounded like a query, not like a compose `up`: a CLI that
    // waits on its stdin (`exec -T` keeps it open) is a failure in a minute, not in fifteen.
    const cli = await bundle(
      ['exec', '-T', 'remote-worker', '/opt/claude-cli/claude', '--version'],
      {},
      { timeout: DOCKER_QUERY_MS },
    ).then(
      ({ stdout }) => ({ ok: /\(Claude Code\)/.test(stdout), detail: stdout.trim().slice(0, 120) }),
      (error) => ({
        ok: false,
        detail: failureDetail(error, {
          CLAUDE_TOKEN,
          RUN_TOKEN,
          SECRET_KEY,
          ADMIN_PASSWORD,
          WORKER_CREDENTIAL: credential,
          DEPLOY_KEY: key.privateKey.trim(),
          DEPLOY_KEY_FRAGMENT: key.fragment,
        }),
      }),
    );
    check(
      'claude --version runs from the claude-cli volume inside remote-worker',
      cli.ok,
      cli.detail,
    );
    const published = (await bundle(['port', 'remote-worker', '7357'])).stdout.trim();
    check(
      'the page is published on 127.0.0.1 only',
      published === `127.0.0.1:${UI_PORT}`,
      published,
    );
    const page = `http://127.0.0.1:${UI_PORT}`;
    const asked = async (route, requestHeaders = {}) => {
      const { response, body } = await boundedFetch(stages, `${page}${route}`, {
        headers: requestHeaders,
      });
      return { status: response.status, body, headers: response.headers };
    };
    const html = await asked('/');
    check(
      'the page is served on 127.0.0.1',
      html.status === 200 && html.body.includes('id="root"'),
    );
    const local = await asked('/api/local/state');
    check(
      'the page’s state answers with no token, naming the worker',
      local.status === 200 && local.body.includes('"worker_name":"check-laptop"'),
      `${local.status} ${local.body.slice(0, 120)}`,
    );
    check(
      'the page’s state carries no secret',
      !local.body.includes(CLAUDE_TOKEN) &&
        !local.body.includes(credential) &&
        !local.body.includes(RUN_TOKEN),
    );
    check(
      'the page answers no CORS header and sets no cookie',
      [...local.headers.keys()].every(
        (name) => !name.startsWith('access-control-') && name !== 'set-cookie',
      ),
    );
    // A worker started with nothing — no core URL, no Claude token — still serves its page, at the
    // wizard's first step (WP-294 (1)): a one-off on another loopback port, removed at once.
    const emptyPort = await freePort();
    const empty = (
      await bundle([
        'run',
        '-d',
        '--rm',
        '--no-deps',
        '-e',
        'APP_CORE_URL=',
        '-e',
        'CLAUDE_CODE_OAUTH_TOKEN=',
        '-e',
        `APP_WORKER_UI_PORT=${emptyPort}`,
        '-p',
        `127.0.0.1:${emptyPort}:7357`,
        'remote-worker',
      ])
    ).stdout.trim();
    try {
      let emptyState = { status: 0, body: '' };
      for (let tries = 0; tries < 60 && emptyState.status !== 200; tries += 1) {
        await sleep(1_000);
        emptyState = await boundedFetch(stages, `http://127.0.0.1:${emptyPort}/api/local/state`, {})
          .then(({ response, body }) => ({ status: response.status, body }))
          .catch(() => ({ status: 0, body: '' }));
      }
      check(
        'a worker with no token and no URL serves its page 200, at the platform step',
        emptyState.status === 200 && emptyState.body.includes('"connection":"needs_platform"'),
        `${emptyState.status} ${emptyState.body.slice(0, 120)}`,
      );
    } finally {
      await quietly(['rm', '-f', empty]);
    }
    check(
      'a foreign Host is 421',
      (
        await run('curl', [
          '-s',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          '-H',
          'host: rebinding.example.test',
          `${page}/api/local/state`,
        ])
      ).stdout.trim() === '421',
    );
    const other = Object.values(networkInterfaces())
      .flat()
      .find((address) => address?.family === 'IPv4' && !address.internal)?.address;
    if (other === undefined) {
      check('the host has another address to try the page on', false, 'none found');
    } else {
      let reached = 'no answer';
      try {
        const response = await fetch(`http://${other}:${UI_PORT}/`, {
          signal: AbortSignal.timeout(5_000),
        });
        reached = `answered ${response.status}`;
      } catch {
        // refused or timed out: the page is not on this address
      }
      check(
        `the page is not reachable on the host’s other address (${other})`,
        reached === 'no answer',
        reached,
      );
    }
    const probe = (
      await docker([
        'run',
        '--rm',
        '--network',
        RUN_NETWORK,
        '--entrypoint',
        'node',
        `platform:${TAG}`,
        '-e',
        `const targets = ${JSON.stringify(['remote-worker', ...workerAddress])};
         Promise.all(targets.map((host) => fetch('http://' + host + ':7357/', { signal: AbortSignal.timeout(5000) })
           .then((r) => host + ' reached ' + r.status, () => host + ' unreachable')))
           .then((lines) => console.log(lines.join('\\n')));`,
      ])
    ).stdout;
    // Measured, not asserted: the run egress network carries the sidecar and the helpers, never a
    // run container (TD-025) — the assertion is the run container's own probe above. What a
    // container here reaches is reported so a change in it is seen (backlog 792).
    console.log(
      `note  a container on the run egress network: ${probe.trim().replaceAll('\n', '; ')}`,
    );
  } catch (error) {
    failures.push(`${stages.current}: ${String(error)}`);
    await describeInstance(core, 'core').catch(() => undefined);
    await describeInstance(bundle, 'bundle').catch(() => undefined);
    try {
      const { stdout } = await bundle([
        'logs',
        '--no-color',
        '--tail',
        '120',
        'remote-worker',
        'launcher',
      ]);
      console.error(`--- bundle logs remote-worker launcher\n${stdout}`);
    } catch {
      // best effort
    }
  } finally {
    // 9. Nothing is left.
    await quietly(['rm', '-f', '-v', GIT_STANDIN]);
    await quietly(['rm', '-f', '-v', SSH_STANDIN]);
    await bundle(['down', '-v', '--remove-orphans']).catch(() => undefined);
    await removeLauncherObjects();
    await core(['down', '-v', '--remove-orphans'], composeEnvironment(CORE)).catch(() => undefined);
    await quietly(['rm', '-f', '-v', REGISTRY]);
    for (const reference of madeImages) await quietly(['image', 'rm', reference]);
    await quietly(['image', 'rm', RUN_IMAGE]);
    await rm(coreDirectory, { recursive: true, force: true });
    await rm(bundleDirectory, { recursive: true, force: true });
    await rm(checkDirectory, { recursive: true, force: true });
  }
};

const settled = installExitBackstop('worker-compose-check', stages);
await main();
settled();
if (failures.length > 0) {
  console.log(`FAIL: worker-compose-check — ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('PASS: worker-compose-check');
}
