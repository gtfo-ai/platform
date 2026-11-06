#!/usr/bin/env node
/**
 * `node scripts/worker-update-check.mjs` — **WP-287 (5)'s Docker leg**: a worker that follows its
 * core by itself, on one daemon.
 *
 *     node scripts/build-images.mjs --tag <tag>
 *     node scripts/worker-update-check.mjs --tag <tag> [--project-suffix <s>] [--host-address <a>]
 *
 * `--host-address` is how a container reaches this host. It is detected for Docker Desktop and for a
 * Linux engine; any other engine (OrbStack, colima) gets the Linux answer, the default bridge's
 * gateway, which is the engine VM's address and not measured here — if the check cannot reach its
 * core or registry, pass `--host-address host.docker.internal` (or the name the engine gives the host).
 *
 * ## What it brings up
 *
 *  - **a local registry** (`registry:2`, `127.0.0.1:<port>`) holding the check's images under
 *    `localhost:<port>/acme/…`, each an **attested** build: the check signs an in-toto SLSA
 *    provenance statement per digest as a Sigstore bundle with a key it generates, and pushes it as
 *    the digest's referrer through the OCI 1.1 tag fallback (`sha256-<hex>`) — GHCR's own shape.
 *    **The shipped updater verifies keylessly only** (the orchestrator's ruling on PR #38) and no
 *    test can mint a Fulcio certificate for this repository's workflow, so **this check's own
 *    `platform` builds replace one module**, `apps/server/src/updater/signature.ts`, with a stand-in
 *    that checks the DSSE signature against the check's key (baked into those images, never in a
 *    compose file) and reads the provenance's `startedOn` as the log time. Everything else — the
 *    registry reads, the referrer fallback, the statement's subject, workflow and commit, the
 *    one-commit rule, the downgrade bound, the apply — is the shipped code. The keyless signature
 *    itself is the unit tier's (the recorded GHCR bundle, `attestation.test.ts`). Four builds of all
 *    four images, each `FROM <image>:<tag>` and attested at its own commit and time: **old**
 *    (installed first), **new** (a good update), **bad** (its worker never answers `/readyz`; its
 *    apply runs normally) and **unattested** (pushed with no attestation);
 *  - **the core**: `compose.yml`, `workers_only` (no runner), on a fixed port, advertising the
 *    digests `APP_WORKER_IMAGE_DIGESTS` names — re-written and the `app` recreated to move them;
 *  - **the worker**, installed the way a person does: the compose file **downloaded from the core**
 *    (pinned to the old digests), the Claude token **on the shell** (never in a file), and an `.env`
 *    holding only this check's isolation (its own volumes, run network and page port — the owner's
 *    worker on the same daemon shares none of them) and the updater's trust settings.
 *
 * ## What it asserts
 *
 *  1. **V-WM2**: Compose works through the updater's own socket proxy (`CONTAINERS NETWORKS VOLUMES
 *     IMAGES INFO POST`) — `docker compose ps` from inside the updater, and every update below;
 *  2. **unattested**: the core advertises a digest with no attestation → the updater refuses it and
 *     reports `failed` naming it; **nothing is pulled** (the digest is absent from the daemon), the
 *     worker runs the old image and no apply container ran;
 *  3. **a good update**: drained, applied from the new image, the new build written back into the
 *     install folder — its compose file and the managed block of its `.env` (the previous file kept,
 *     S-22.21) — the worker and the updater recreated on the new digest, `core_handshake: ok`,
 *     reported `succeeded` — the Workers screen's `last_update`; the token in no file;
 *  4. **a bad update** (an image whose worker never handshakes): rolled back to the previous digest,
 *     reported `rolled_back`, the worker serving again;
 *  5. **a downgrade** to the old build: refused, reported `failed`, nothing changed;
 *  6. **the owner's worker** (compose project `agentic-worker`, if present) carries nothing of this
 *     check's — no image from its registry, no project brought up from an image's template (the owner
 *     may re-`up` their own worker meanwhile, so "the same containers" is not the assertion);
 *  7. nothing is left: both projects down with their volumes, the registry and the check's images gone.
 *
 * Not a `verify` target, for the reason none of the Docker checks are: it needs a daemon. With no
 * daemon or no image it exits 1 naming what is missing; a skip is never a pass.
 */
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  boundedFetch,
  createStages,
  describeInstance,
  installExitBackstop,
  refuseOldNode,
  waitForOk,
} from './compose-check-support.mjs';

refuseOldNode('worker-update-check');

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const optionValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const TAG = optionValue('--tag', process.env.PLATFORM_TAG ?? 'dev');
const SUFFIX = optionValue('--project-suffix', process.env.GITHUB_RUN_ID ?? 'local');
const CORE = `agentic-update-check-core-${SUFFIX}`;
const BUNDLE = `agentic-update-check-bundle-${SUFFIX}`;
const REGISTRY_CONTAINER = `agentic-update-check-registry-${SUFFIX}`;
/** The owner's own worker, which this check must never touch. */
const OWNER_PROJECT = 'agentic-worker';

const REGISTRY_PORT = Number(optionValue('--registry-port', '55787'));
const CORE_PORT = Number(optionValue('--core-port', '38787'));
const UI_PORT = 37358;
const REGISTRY = `localhost:${REGISTRY_PORT}`;
const NAMESPACE = `${REGISTRY}/acme`;
/**
 * How a container reaches this host: the core's published port and the registry. Docker Desktop
 * answers `host.docker.internal`; a Linux engine (a CI runner, `.github/workflows/docker-checks.yml`)
 * resolves no such name unless a container declares `host-gateway`, which the shipped bundle does not
 * and which an update's own `compose up` would not carry — so there it is the default bridge's
 * gateway, an address of the host that every bridge network routes to. `--host-address` overrides
 * (OrbStack and colima are neither and get the bridge answer, unmeasured — the usage above).
 * Set by {@link resolveHostAddress} before anything uses it.
 */
let HOST_ADDRESS = optionValue('--host-address', '');
let CORE_URL = '';

const resolveHostAddress = async () => {
  if (HOST_ADDRESS === '') {
    const { stdout: system } = await docker(['info', '--format', '{{.OperatingSystem}}']);
    HOST_ADDRESS = /docker desktop/i.test(system)
      ? 'host.docker.internal'
      : (
          await docker([
            'network',
            'inspect',
            'bridge',
            '--format',
            '{{(index .IPAM.Config 0).Gateway}}',
          ])
        ).stdout.trim();
  }
  if (!/^[\w.-]+$/.test(HOST_ADDRESS)) {
    throw new Error(
      `the host address for containers is not a host name or address: '${HOST_ADDRESS}'`,
    );
  }
  CORE_URL = `http://${HOST_ADDRESS}:${CORE_PORT}`;
  console.log(`containers reach this host as ${HOST_ADDRESS}`);
};

/** Obviously fake (BD-002), past every floor, and in no shape a pattern rule knows. */
const SECRET_KEY = 'wp287-worker-update-check-not-a-real-secret-0000';
const ADMIN_EMAIL = 'operator@example.test';
const ADMIN_PASSWORD = 'wp287-not-a-real-password';
const CLAUDE_TOKEN = 'FAKE-wp287-claude-oauth-token-not-a-credential-0001';
const BUILDER = {
  repository: 'check/platform',
  path: '.github/workflows/image.yml',
  ref: 'refs/heads/main',
};
const TIMEOUT_MS = 15 * 60 * 1000;
const DOCKER_QUERY_MS = 60_000;
/** How long one phase may take: verification, pull, drain, apply, check — and a rollback's second up. */
const PHASE_MS = 8 * 60_000;

const stages = createStages();
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const docker = async (dockerArgs, options = {}) =>
  run('docker', dockerArgs, {
    timeout: options.timeoutMs ?? DOCKER_QUERY_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...options.env },
    cwd: options.cwd ?? REPO,
  });

const compose =
  (project, file, directory, baseEnv = {}) =>
  async (composeArgs, extraEnv = {}) =>
    run(
      'docker',
      ['compose', '-p', project, '--project-directory', directory, '-f', file, ...composeArgs],
      {
        cwd: REPO,
        env: { ...process.env, PLATFORM_TAG: TAG, ...baseEnv, ...extraEnv },
        maxBuffer: 64 * 1024 * 1024,
        timeout: TIMEOUT_MS,
      },
    );

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * The check's networks, made **before** compose with explicit `/24` subnets under `--subnet-base`
 * (default `10.231`) and the labels compose gives its own, which compose then adopts (measured:
 * `up` reuses them, `down` removes them). A busy developer daemon runs out of its default address
 * pools — measured at S-22.10, three `/20`s left of 31 — and these six networks would not fit; the
 * template the worker runs is unchanged by this.
 */
const SUBNET_BASE = optionValue('--subnet-base', '10.231');
const NETWORKS = [
  { project: CORE, key: 'default', name: `${CORE}_default`, internal: false, octet: 10 },
  { project: BUNDLE, key: 'default', name: `${BUNDLE}_default`, internal: false, octet: 11 },
  {
    project: BUNDLE,
    key: 'launcher-api',
    name: `${BUNDLE}_launcher-api`,
    internal: true,
    octet: 12,
  },
  {
    project: BUNDLE,
    key: 'docker-proxy',
    name: `${BUNDLE}_docker-proxy`,
    internal: true,
    octet: 13,
  },
  {
    project: BUNDLE,
    key: 'updater-docker',
    name: `${BUNDLE}_updater-docker`,
    internal: true,
    octet: 14,
  },
  { project: BUNDLE, key: 'run-egress', name: `${BUNDLE}-run-egress`, internal: false, octet: 15 },
];
const createNetworks = async (project) => {
  for (const network of NETWORKS.filter((entry) => entry.project === project)) {
    await docker([
      'network',
      'create',
      ...(network.internal ? ['--internal'] : []),
      '--subnet',
      `${SUBNET_BASE}.${network.octet}.0/24`,
      '--label',
      `com.docker.compose.project=${network.project}`,
      '--label',
      `com.docker.compose.network=${network.key}`,
      network.name,
    ]);
  }
};

// ── The registry ───────────────────────────────────────────────────────────────────────────────

const registryUrl = (name, rest) => `http://127.0.0.1:${REGISTRY_PORT}/v2/acme/${name}/${rest}`;

/** The digest a tag names in the local registry (what `docker push` published). */
const digestOf = async (name, tag) => {
  const response = await fetch(registryUrl(name, `manifests/${tag}`), {
    method: 'HEAD',
    headers: {
      accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(', '),
    },
  });
  const digest = response.headers.get('docker-content-digest');
  if (!response.ok || digest === null)
    throw new Error(`${name}:${tag} answered ${response.status}`);
  return digest;
};

const pushBlob = async (name, bytes) => {
  const digest = sha256(bytes);
  const start = await fetch(registryUrl(name, 'blobs/uploads/'), { method: 'POST' });
  const location = start.headers.get('location');
  if (start.status !== 202 || location === null) throw new Error(`blob upload: ${start.status}`);
  const target = new URL(location, `http://127.0.0.1:${REGISTRY_PORT}`);
  target.searchParams.set('digest', digest);
  const put = await fetch(target, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  if (put.status !== 201) throw new Error(`blob put: ${put.status}`);
  return digest;
};

const pushManifest = async (name, reference, mediaType, bytes) => {
  const put = await fetch(registryUrl(name, `manifests/${reference}`), {
    method: 'PUT',
    headers: { 'content-type': mediaType },
    body: bytes,
  });
  if (put.status !== 201)
    throw new Error(`manifest put ${reference}: ${put.status} ${await put.text()}`);
};

const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const TRUSTED_KEY = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

/** A Sigstore bundle v0.3: a DSSE envelope over an SLSA provenance statement, signed by the check's key. */
const attestation = (repository, digest, commit, at) => {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: repository, digest: { sha256: digest.slice('sha256:'.length) } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://example.test/worker-update-check',
        externalParameters: {
          workflow: {
            ref: BUILDER.ref,
            repository: `https://github.com/${BUILDER.repository}`,
            path: BUILDER.path,
          },
        },
        resolvedDependencies: [{ digest: { gitCommit: commit } }],
      },
      runDetails: {
        builder: { id: 'https://example.test/worker-update-check' },
        // Read as the log time by the check's signature stand-in (a real bundle's is Rekor's).
        metadata: { startedOn: at },
      },
    },
  };
  const payload = Buffer.from(JSON.stringify(statement));
  const type = 'application/vnd.in-toto+json';
  const pae = Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `),
    payload,
  ]);
  return Buffer.from(
    JSON.stringify({
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {
        publicKey: { hint: 'worker-update-check' },
        tlogEntries: [],
        timestampVerificationData: { rfc3161Timestamps: [] },
      },
      dsseEnvelope: {
        payload: payload.toString('base64'),
        payloadType: type,
        signatures: [{ sig: sign('sha256', pae, keys.privateKey).toString('base64'), keyid: '' }],
      },
    }),
  );
};

/** Pushes the attestation of `name@digest` as its referrer, under the OCI 1.1 tag fallback. */
const attest = async (name, digest, commit, at) => {
  const bundle = attestation(`${NAMESPACE}/${name}`, digest, commit, at);
  const empty = Buffer.from('{}');
  const emptyDigest = await pushBlob(name, empty);
  const bundleDigest = await pushBlob(name, bundle);
  const subject = await fetch(registryUrl(name, `manifests/${digest}`), {
    method: 'HEAD',
    headers: {
      accept:
        'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json',
    },
  });
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      artifactType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: emptyDigest, size: 2 },
      layers: [
        {
          mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
          digest: bundleDigest,
          size: bundle.length,
        },
      ],
      subject: {
        mediaType: subject.headers.get('content-type') ?? 'application/vnd.oci.image.index.v1+json',
        digest,
        size: Number(subject.headers.get('content-length') ?? '0'),
      },
      annotations: {
        'dev.sigstore.bundle.content': 'dsse-envelope',
        'dev.sigstore.bundle.predicateType': 'https://slsa.dev/provenance/v1',
      },
    }),
  );
  const manifestDigest = sha256(manifest);
  await pushManifest(name, manifestDigest, 'application/vnd.oci.image.manifest.v1+json', manifest);
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: manifestDigest,
          size: manifest.length,
          artifactType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
          annotations: {
            'dev.sigstore.bundle.predicateType': 'https://slsa.dev/provenance/v1',
          },
        },
      ],
    }),
  );
  await pushManifest(
    name,
    `sha256-${digest.slice('sha256:'.length)}`,
    'application/vnd.oci.image.index.v1+json',
    index,
  );
};

/** `docker tag` + `docker push`; answers the registry digest. */
const publish = async (source, name, tag) => {
  const target = `${NAMESPACE}/${name}:${tag}`;
  await docker(['image', 'tag', source, target]);
  await docker(['image', 'push', '--quiet', target], { timeoutMs: 10 * 60_000 });
  return digestOf(name, tag);
};

/**
 * The check's stand-in for `apps/server/src/updater/signature.ts` (see the header): the same exports,
 * a DSSE signature checked against the check's key instead of Fulcio and Rekor. Only the check's
 * own images carry it.
 */
const SIGNATURE_STAND_IN = `import { createPublicKey, verify } from 'node:crypto';
export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
export const builderIdentity = (builder) =>
  'https://github.com/' + builder.repository + '/' + builder.workflowPath + '@' + builder.ref;
export class SignatureRefusedError extends Error {}
SignatureRefusedError.prototype.name = 'SignatureRefusedError';
export class SignatureUnavailableError extends Error {}
export const derUtf8 = () => null;
const key = createPublicKey({
  key: Buffer.from(process.env.CHECK_ATTESTATION_KEY ?? '', 'base64'),
  format: 'der',
  type: 'spki',
});
export const createKeylessSignatureCheck = () => ({
  async verify(bundle) {
    const envelope = bundle.content.dsseEnvelope;
    const payload = Buffer.from(envelope.payload);
    const type = envelope.payloadType;
    const pae = Buffer.concat([
      Buffer.from('DSSEv1 ' + Buffer.byteLength(type) + ' ' + type + ' ' + payload.length + ' '),
      payload,
    ]);
    const signature = envelope.signatures[0]?.sig;
    if (signature === undefined || !verify('sha256', pae, key, Buffer.from(signature))) {
      throw new SignatureRefusedError('worker-update-check: not signed by the check key');
    }
    const at = JSON.parse(payload.toString('utf8')).predicate?.runDetails?.metadata?.startedOn;
    return { loggedAt: new Date(at), commit: null };
  },
});
`;

/** One check build of an image: `FROM <image>:<tag>`, relabelled so its digest is its own. */
const derive = async (directory, image, label, options = {}) => {
  const context = path.join(directory, `image-${image}-${label}`);
  await run('mkdir', ['-p', context]);
  const lines = [`FROM ${image}:${TAG}`, `LABEL org.platform.update-check="${label}"`];
  if (image === 'platform') {
    await writeFile(path.join(context, 'signature.ts'), SIGNATURE_STAND_IN);
    lines.push(
      `ENV CHECK_ATTESTATION_KEY=${TRUSTED_KEY}`,
      'COPY signature.ts /app/apps/server/src/updater/signature.ts',
    );
  }
  if (options.broken === true) {
    // The worker never listens (so it never handshakes); every other role runs as shipped.
    await writeFile(
      path.join(context, 'bad-main.mjs'),
      "if (process.env.ROLE === 'remote-worker') { console.log('this build’s worker never answers'); setInterval(() => undefined, 1 << 30); } else { await import('/app/apps/server/src/main.ts'); }\n",
    );
    lines.push('COPY bad-main.mjs /opt/check/bad-main.mjs', 'CMD ["/opt/check/bad-main.mjs"]');
  }
  await writeFile(path.join(context, 'Dockerfile'), `${lines.join('\n')}\n`);
  const tag = `agentic-update-check-${image}-${label}:${SUFFIX}`;
  await docker(['build', '--quiet', '-t', tag, context], { timeoutMs: 10 * 60_000 });
  return tag;
};

// ── The core's API ─────────────────────────────────────────────────────────────────────────────

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
        origin: CORE_URL,
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

/**
 * The owner's worker's containers as the check could have touched them: each one's image and the
 * compose file it was brought up from. The owner may re-`up` their own worker while this check runs
 * (it did, at S-22.10's first run), so the assertion is not "nothing changed" but "nothing of this
 * check's": no image from the check's registry and no project brought up from an image's template —
 * the two marks an apply of this check's would leave.
 */
const ownerContainers = async () => {
  const ids = (
    await docker([
      'container',
      'ls',
      '--all',
      '--quiet',
      '--filter',
      `label=com.docker.compose.project=${OWNER_PROJECT}`,
    ])
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  if (ids.length === 0) return [];
  const { stdout } = await docker([
    'container',
    'inspect',
    '--format',
    '{{.Name}} {{.Config.Image}} {{index .Config.Labels "com.docker.compose.project.config_files"}}',
    ...ids,
  ]);
  return stdout.trim().split('\n').filter(Boolean).sort();
};

const main = async () => {
  try {
    const { stdout } = await docker(['version', '--format', '{{.Server.Version}}']);
    console.log(`docker daemon ${stdout.trim()}`);
  } catch (error) {
    console.error(`FAIL: worker-update-check — no Docker daemon: ${String(error)}`);
    process.exit(1);
  }
  await resolveHostAddress();
  for (const image of ['platform', 'platform-launcher', 'platform-runtime', 'platform-egress']) {
    try {
      await docker(['image', 'inspect', `${image}:${TAG}`, '--format', '{{.Id}}']);
    } catch {
      console.error(
        `FAIL: worker-update-check — ${image}:${TAG} is not on this daemon; build it with \`node scripts/build-images.mjs --tag ${TAG}\``,
      );
      process.exit(1);
    }
  }
  const ownerBefore = await ownerContainers();
  const directory = await mkdtemp(path.join(tmpdir(), 'worker-update-check-'));
  const coreDirectory = path.join(directory, 'core');
  const bundleDirectory = path.join(directory, 'bundle');
  await run('mkdir', ['-p', coreDirectory, bundleDirectory]);
  const coreEnv = {
    APP_PORT: String(CORE_PORT),
    APP_WORKSPACE_CONTROL_VOLUME: `${CORE}-ctl`,
    APP_WORKSPACE_CACHE_VOLUME: `${CORE}-repo-cache`,
  };
  const core = compose(CORE, path.join(REPO, 'compose.yml'), coreDirectory, coreEnv);
  const bundleFile = path.join(bundleDirectory, 'compose.worker.yml');
  // The token on this shell for every compose call, as a person's would be (`${CLAUDE_CODE_OAUTH_TOKEN:?…}`
  // is interpolated by `logs` and `exec` too) — never in a file. The apply has no shell: it carries it.
  const bundle = compose(BUNDLE, bundleFile, bundleDirectory, {
    CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
  });
  const derived = [];
  try {
    // ── The registry and the attested builds ──────────────────────────────────────────────
    stages.set('the local registry');
    await docker([
      'run',
      '-d',
      '--name',
      REGISTRY_CONTAINER,
      '-p',
      `127.0.0.1:${REGISTRY_PORT}:5000`,
      // The updater reads the registry from inside a container, at the host address above; on
      // Docker Desktop `host.docker.internal` reaches the loopback publish, on Linux it does not.
      ...(HOST_ADDRESS === 'host.docker.internal'
        ? []
        : ['-p', `${HOST_ADDRESS}:${REGISTRY_PORT}:5000`]),
      'registry:2',
    ]);
    await waitForOk(stages, `http://127.0.0.1:${REGISTRY_PORT}/v2/`);
    stages.set('building and publishing the check’s images');
    const t = (hours) => new Date(Date.UTC(2026, 10, 5, hours)).toISOString();
    /** Each build: its commit, its log time, whether it is attested, whether its worker is broken. */
    const BUILDS = {
      old: { commit: '1'.repeat(40), at: t(1), attested: true },
      new: { commit: '2'.repeat(40), at: t(2), attested: true },
      bad: { commit: '3'.repeat(40), at: t(3), attested: true, broken: true },
      unattested: { commit: '4'.repeat(40), at: t(4), attested: false },
    };
    const IMAGES = {
      platform: 'platform',
      platform_launcher: 'platform-launcher',
      platform_runtime: 'platform-runtime',
      platform_egress: 'platform-egress',
    };
    /** label → key → registry digest. */
    const published = {};
    for (const [label, build] of Object.entries(BUILDS)) {
      published[label] = {};
      for (const [key, image] of Object.entries(IMAGES)) {
        const source = await derive(directory, image, label, { broken: build.broken === true });
        derived.push(source);
        published[label][key] = await publish(source, image, label);
        if (build.attested) await attest(image, published[label][key], build.commit, build.at);
      }
    }
    const platform = Object.fromEntries(
      Object.keys(BUILDS).map((label) => [label, published[label].platform]),
    );
    // Nothing of the unattested build may be on the daemon, so a pull would be visible.
    for (const image of Object.values(IMAGES)) {
      await docker(['image', 'rm', `${NAMESPACE}/${image}:unattested`]).catch(() => undefined);
      await docker(['image', 'rm', `agentic-update-check-${image}-unattested:${SUFFIX}`]).catch(
        () => undefined,
      );
    }
    const ref = (label) => `${NAMESPACE}/platform@${platform[label]}`;
    const digestsFor = (label) =>
      Object.keys(IMAGES)
        .map((key) => `${key}=${published[label][key]}`)
        .join(',');

    // ── The core, advertising the old build ───────────────────────────────────────────────
    const advertise = async (label) => {
      await writeFile(
        path.join(coreDirectory, '.env'),
        [
          `APP_SECRET_KEY=${SECRET_KEY}`,
          `APP_BASE_URL=${CORE_URL}`,
          `APP_BOOTSTRAP_ADMIN_EMAIL=${ADMIN_EMAIL}`,
          `APP_BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PASSWORD}`,
          `APP_IMAGE_REPOSITORY=${NAMESPACE}`,
          `APP_WORKER_IMAGE_DIGESTS=${digestsFor(label)}`,
          '',
        ].join('\n'),
      );
      // `app` and what it depends on: no runner (a `workers_only` core), no launcher.
      await core(['up', '-d', '--no-build', '--wait', 'app']);
      await waitForOk(stages, `http://127.0.0.1:${CORE_PORT}/healthz`);
    };
    stages.set('core: docker compose up');
    await createNetworks(CORE);
    await advertise('old');
    const admin = new Client(`http://127.0.0.1:${CORE_PORT}`);
    const signedIn = await admin.json('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    check('the bootstrap administrator signs in', signedIn.status === 200, String(signedIn.status));

    // ── The worker, installed as a person does ─────────────────────────────────────────────
    stages.set('the first-install download');
    const file = await admin.json('/api/worker/v1/compose.yml');
    check(
      'the core serves the compose file pinned to the old build',
      file.status === 200 && String(file.text).includes(ref('old')),
    );
    await writeFile(bundleFile, String(file.text));
    await writeFile(
      path.join(bundleDirectory, '.env'),
      [
        `APP_WORKER_CONTROL_VOLUME=${BUNDLE}-ctl`,
        `APP_WORKER_CACHE_VOLUME=${BUNDLE}-repo-cache`,
        `APP_WORKER_RUN_NETWORK=${BUNDLE}-run-egress`,
        `APP_WORKER_UI_PORT=${UI_PORT}`,
        `APP_TRUSTED_IMAGE_REPOSITORY=${NAMESPACE}/platform`,
        `APP_TRUSTED_BUILDER=${BUILDER.repository}/${BUILDER.path}@${BUILDER.ref}`,
        `APP_UPDATE_REGISTRY_ENDPOINTS=${REGISTRY}=http://${HOST_ADDRESS}:${REGISTRY_PORT}`,
        'APP_UPDATE_POLL_SECONDS=10',
        'APP_UPDATE_CHECK_SECONDS=60',
        '',
      ].join('\n'),
    );
    stages.set('bundle: docker compose up');
    await createNetworks(BUNDLE);
    // The token on the shell, as the install line has it: never in a file.
    await bundle(['up', '-d', '--no-build'], { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN });

    stages.set('the worker’s device code in its log');
    let userCode = null;
    for (let tries = 0; tries < 60 && userCode === null; tries += 1) {
      const { stdout: logs } = await bundle(['logs', 'remote-worker']);
      userCode = /"user_code":"([A-Z]{4}-[A-Z]{4})"/.exec(logs)?.[1] ?? null;
      if (userCode === null) await sleep(2_000);
    }
    check('the worker logs a device code', userCode !== null);
    const approved = await admin.json('/api/workers/device/approve', {
      method: 'POST',
      body: JSON.stringify({
        decision: 'approve',
        user_code: userCode,
        name: 'update-check-laptop',
        confirm_stale: false,
      }),
    });
    check('the code is approved', approved.status === 200, String(approved.status));
    const readyz = async () => {
      try {
        return (
          await bundle([
            'exec',
            '-T',
            'remote-worker',
            'curl',
            '-fsS',
            'http://127.0.0.1:8080/readyz',
          ])
        ).stdout;
      } catch (error) {
        return String(error.stdout ?? error.message);
      }
    };
    const waitReady = async (what) => {
      stages.set(what);
      let ready = '';
      for (let tries = 0; tries < 90; tries += 1) {
        ready = await readyz();
        if (ready.includes('"core_handshake":"ok"')) return ready;
        await sleep(2_000);
      }
      return ready;
    };
    check(
      'the worker’s /readyz reads core_handshake: ok',
      (await waitReady('the worker’s first handshake')).includes('"core_handshake":"ok"'),
    );

    const imageOf = async (service) => {
      const id = (await bundle(['ps', '-q', service])).stdout.trim();
      if (id === '') return null;
      return (
        await docker(['container', 'inspect', '--format', '{{.Config.Image}}', id])
      ).stdout.trim();
    };
    const lastUpdate = async () => {
      const listed = await admin.json('/api/workers');
      const worker = listed.body?.items?.find((item) => item.name === 'update-check-laptop');
      return worker?.last_update ?? null;
    };
    /** Waits for a reported update whose `to.platform` is `label`'s digest. */
    const waitForReport = async (label, what) => {
      stages.set(what);
      const deadline = Date.now() + PHASE_MS;
      while (Date.now() < deadline) {
        const update = await lastUpdate().catch(() => null);
        if (update !== null && update.to.platform === platform[label]) return update;
        await sleep(5_000);
      }
      return null;
    };
    const applyStarts = async () => {
      const { stdout: logs } = await bundle(['logs', 'updater']);
      return (logs.match(/the apply container started/g) ?? []).length;
    };

    // 1. V-WM2: Compose through the updater's own proxy.
    stages.set('V-WM2');
    const ps = await bundle([
      'exec',
      '-T',
      'updater',
      'docker',
      'compose',
      '--project-name',
      BUNDLE,
      'ps',
      '--format',
      '{{.Service}}',
    ]).catch((error) => ({ stdout: '', stderr: String(error.stderr ?? error.message) }));
    check(
      'V-WM2: docker compose works through the updater’s socket proxy',
      ps.stdout.includes('remote-worker') && ps.stdout.includes('launcher'),
      (ps.stdout || ps.stderr).trim().replaceAll('\n', ' '),
    );
    check('the worker starts on the old build', (await imageOf('remote-worker')) === ref('old'));

    // 2. Unattested: refused, nothing pulled.
    await advertise('unattested');
    const unattested = await waitForReport('unattested', 'the unattested digest’s refusal');
    check(
      'an unattested digest is refused and reported, naming it',
      unattested?.result === 'failed' &&
        String(unattested.detail).includes('carries no build attestation'),
      JSON.stringify(unattested?.detail ?? null),
    );
    let pulled = true;
    try {
      await docker(['image', 'inspect', ref('unattested')]);
    } catch {
      pulled = false;
    }
    check('nothing of the unattested build was pulled', !pulled);
    check('the worker still runs the old build', (await imageOf('remote-worker')) === ref('old'));
    check('no apply container ran for it', (await applyStarts()) === 0);

    // 3. A good update.
    await advertise('new');
    const good = await waitForReport('new', 'the good update');
    check(
      'the good update is reported succeeded',
      good?.result === 'succeeded',
      JSON.stringify(good),
    );
    check('the worker runs the new build', (await imageOf('remote-worker')) === ref('new'));
    check(
      'core_handshake: ok on the new build',
      (await waitReady('the new build’s handshake')).includes('"core_handshake":"ok"'),
    );
    stages.set('the updater recreated last');
    let updaterImage = null;
    for (let tries = 0; tries < 30 && updaterImage !== ref('new'); tries += 1) {
      updaterImage = await imageOf('updater');
      if (updaterImage !== ref('new')) await sleep(2_000);
    }
    check('the updater is recreated on the new build', updaterImage === ref('new'), updaterImage);
    // S-22.21 (TD-032's decision-4 amendment): the updater writes the new build back into the
    // install folder it has mounted, so the folder holds what runs.
    const envText = await readFile(path.join(bundleDirectory, '.env'), 'utf8');
    const previousText = await readFile(path.join(bundleDirectory, '.env.previous'), 'utf8');
    check(
      'the managed block in the folder’s .env pins the new build; the person’s lines and the previous file are kept',
      envText.includes(`PLATFORM_IMAGE=${ref('new')}`) &&
        envText.includes('APP_TRUSTED_BUILDER=') &&
        !previousText.includes('PLATFORM_IMAGE=') &&
        previousText.includes('APP_TRUSTED_BUILDER='),
    );
    const folderFile = await readFile(bundleFile, 'utf8');
    check(
      'the folder’s compose file is the new build’s, so a docker compose up there cannot go back',
      folderFile.includes(ref('new')) && !folderFile.includes(ref('old')),
    );
    const labelOf = async (label) =>
      (
        await docker([
          'container',
          'inspect',
          '--format',
          `{{index .Config.Labels "${label}"}}`,
          (await bundle(['ps', '-q', 'remote-worker'])).stdout.trim(),
        ])
      ).stdout.trim();
    const workingDir = await labelOf('com.docker.compose.project.working_dir');
    check(
      'the worker was brought up from the folder at the updater’s fixed mount path',
      workingDir === '/var/lib/platform/host-bundle',
      workingDir,
    );
    const configFiles = await labelOf('com.docker.compose.project.config_files');
    check(
      'the worker was brought up from the folder’s file, rendered from the new image’s template',
      configFiles === '/var/lib/platform/host-bundle/compose.worker.yml',
      configFiles,
    );
    check(
      'the Claude token is in no file the updater wrote',
      !envText.includes(CLAUDE_TOKEN) &&
        !previousText.includes(CLAUDE_TOKEN) &&
        !folderFile.includes(CLAUDE_TOKEN),
    );
    const workerEnv = (
      await docker([
        'container',
        'inspect',
        '--format',
        '{{json .Config.Env}}',
        (await bundle(['ps', '-q', 'remote-worker'])).stdout.trim(),
      ])
    ).stdout;
    check(
      'the recreated worker still has the token the shell gave the first install',
      workerEnv.includes(`CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}`),
    );

    // 4. A bad update: rolled back.
    await advertise('bad');
    const bad = await waitForReport('bad', 'the bad update’s rollback');
    check(
      'the bad update is rolled back and reported',
      bad?.result === 'rolled_back',
      JSON.stringify(bad),
    );
    check(
      'the worker runs the previous build again',
      (await imageOf('remote-worker')) === ref('new'),
    );
    check(
      'and handshakes',
      (await waitReady('the handshake after the rollback')).includes('"core_handshake":"ok"'),
    );
    check('the updater stayed on the previous build', (await imageOf('updater')) === ref('new'));

    // 5. A downgrade: refused.
    await advertise('old');
    const downgrade = await waitForReport('old', 'the downgrade’s refusal');
    check(
      'a downgrade is refused and reported',
      downgrade?.result === 'failed' && String(downgrade.detail).includes('downgrade'),
      JSON.stringify(downgrade?.detail ?? null),
    );
    check('the worker still runs the new build', (await imageOf('remote-worker')) === ref('new'));

    // 6. The owner's worker.
    const ownerAfter = await ownerContainers();
    const touched = ownerAfter.filter(
      (line) =>
        line.includes(NAMESPACE) ||
        line.includes('/opt/platform/compose.worker.yml') ||
        line.includes('/var/lib/platform/updates/'),
    );
    check(
      `the owner’s project (${OWNER_PROJECT}, ${ownerBefore.length} → ${ownerAfter.length} containers) carries nothing of this check’s: no check image, no apply’s template`,
      touched.length === 0,
      touched.join('; '),
    );
    const canaryLogs = (await bundle(['logs'])).stdout;
    check('the Claude token is in no log line of the bundle', !canaryLogs.includes(CLAUDE_TOKEN));
  } catch (error) {
    failures.push(`${stages.current}: ${String(error)}`);
    await describeInstance(core, 'core').catch(() => undefined);
    await describeInstance(bundle, 'bundle').catch(() => undefined);
    const { stdout: logs } = await bundle(['logs', '--tail', '60', 'updater']).catch(() => ({
      stdout: '',
    }));
    console.log(logs);
  } finally {
    // 7. Nothing is left.
    stages.set('cleanup');
    const applies = (
      await docker([
        'container',
        'ls',
        '-aq',
        '--filter',
        `label=org.platform.update-apply=${BUNDLE}`,
      ]).catch(() => ({ stdout: '' }))
    ).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    if (applies.length > 0)
      await docker(['container', 'rm', '-f', ...applies]).catch(() => undefined);
    await bundle(['down', '-v', '--remove-orphans'], {
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
    }).catch(() => undefined);
    await core(['down', '-v', '--remove-orphans']).catch(() => undefined);
    await docker(['container', 'rm', '-f', REGISTRY_CONTAINER]).catch(() => undefined);
    for (const network of NETWORKS) {
      await docker(['network', 'rm', network.name]).catch(() => undefined);
    }
    const tags = (
      await docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', `${NAMESPACE}/*`]).catch(
        () => ({ stdout: '' }),
      )
    ).stdout
      .trim()
      .split('\n')
      .filter((line) => line !== '' && !line.endsWith(':<none>'));
    const digests = (
      await docker([
        'image',
        'ls',
        '--digests',
        '--format',
        '{{.Repository}}@{{.Digest}}',
        `${NAMESPACE}/*`,
      ]).catch(() => ({ stdout: '' }))
    ).stdout
      .trim()
      .split('\n')
      .filter((line) => line !== '' && !line.endsWith('@<none>'));
    for (const image of [...tags, ...digests, ...derived]) {
      await docker(['image', 'rm', image]).catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  }
};

const settled = installExitBackstop('worker-update-check', stages);
await main();
settled();
if (failures.length > 0) {
  console.log(`FAIL: worker-update-check — ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('PASS: worker-update-check');
}
