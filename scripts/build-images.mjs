#!/usr/bin/env node
/**
 * `node scripts/build-images.mjs [image…]` — build the platform's images from this checkout.
 *
 * One place that knows which Dockerfile makes which image, what it is built on and what it may
 * weigh, so that a developer, the e2e tier and `.github/workflows/image.yml` all build the same
 * thing (standing rule 7: a second list drifts). With no arguments it builds all of them, in
 * dependency order.
 *
 *   node scripts/build-images.mjs                  every image, base first
 *   node scripts/build-images.mjs runtime egress   what the workspace e2e needs
 *   node scripts/build-images.mjs --tag v1.2.3     a different tag than `dev`
 *   node scripts/build-images.mjs --size-check     build, then hold each to its budget
 *
 * ## The budgets are per image and derived, not one number
 *
 * technical/11 asks `image.yml` for a "size check ≤ 1 GB". That is one number for images with very
 * different contents, and the run image cannot meet it: TD-021 puts the `claude` CLI in it (217 MB
 * measured) plus the six agent CLIs (260 MB), which is half a gigabyte before any of ours. So each
 * image carries its own ceiling below, each is roughly a third above what it measures today, and
 * the amendment is recorded in technical/11 rather than left as a number nobody could meet.
 *
 * ## Which size — because three commands answer three different questions
 *
 * The budgets bound the **unpacked size**: the bytes an image costs on a host that has pulled it,
 * which is what "the image grew" means to an operator and what technical/11's 1 GB was reaching
 * for. It is read from `docker images --format '{{.Size}}'`, the one figure both the classic and
 * the containerd image stores report as the unpacked total.
 *
 * The two obvious alternatives were **measured on this daemon** (29.7.2, containerd store) and are
 * a different quantity, which is why neither is used — the first version of this script used the
 * first of them and was therefore checking ~4× smaller numbers against these ceilings:
 *
 *   docker image inspect --format '{{.Size}}' platform-base:dev  →  130 357 549
 *   docker save platform-base:dev | wc -c                        →  130 378 240
 *   docker images --format '{{.Size}}' platform-base:dev         →  547MB
 *
 * The first two are the **compressed content** — the pull size — because a containerd store keeps
 * the blobs as they arrived; on a classic store the same two commands return the unpacked size
 * instead. A check whose meaning depends on how the daemon stores things is not a check (standing
 * rule 64: state what you measured). The cost of reading the human string is three significant
 * figures, which is precision a ceiling a third above the measurement does not need, and an
 * unparseable string is a failure rather than a zero.
 *
 * ## Why a script and not `docker compose build`
 *
 * Compose builds what a *deployment* needs. The e2e needs `platform-runtime` and `platform-egress`,
 * which no service in `compose.yml` runs: the launcher creates them per run, so they appear in no
 * `services:` block and compose would never build them.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @type {{name: string, dockerfile: string, dependsOn: string|null, maxBytes: number,
 *   versioned?: boolean}[]}
 * In build order: `dependsOn` is passed as `BASE_IMAGE`, so a run of this script is self-contained.
 * `versioned` marks the two images that declare `APP_VERSION`/`APP_COMMIT`/`APP_BUILT_AT` — the
 * others would answer a build argument they do not use with a warning.
 */
const IMAGES = [
  // Node 24 slim plus git/jq/ripgrep/ssh and the uid-1000 user. Measured 547 MB.
  { name: 'platform-base', dockerfile: 'base.Dockerfile', dependsOn: null, maxBytes: 750e6 },
  // base + the six agent CLIs (260 MB) + the `claude` binary (217 MB) + the shim. Measured 1.32 GB.
  {
    name: 'platform-runtime',
    dockerfile: 'runtime.Dockerfile',
    dependsOn: 'platform-base',
    maxBytes: 1.8e9,
  },
  // Alpine + tinyproxy. Measured 13.2 MB; the ceiling is deliberately tight, because anything that
  // grows this image is something running beside the only route out of a run.
  { name: 'platform-egress', dockerfile: 'egress.Dockerfile', dependsOn: null, maxBytes: 64e6 },
  // base + a production `node_modules` + the built SPA. Measured 1.1 GB, of which **207 MB is the
  // Agent SDK's `claude` binary** — its per-platform `optionalDependency`, which pnpm installs
  // beside the SDK. technical/11's single 1 GB cannot be met while that is in it, and removing it
  // is a measurement nobody has taken: the SDK only checks the executable exists on the branch
  // where it spawns the process *itself* (`if (spawnClaudeCodeProcess) … else spawnLocalProcess`),
  // and this platform always overrides that — so it is probably removable and is not removed on a
  // "probably". PROGRESS carries it as discovered work.
  {
    name: 'platform',
    dockerfile: 'app.Dockerfile',
    dependsOn: 'platform-base',
    maxBytes: 1.4e9,
    versioned: true,
  },
  // The same production tree for `@platform/launcher`, on the same base.
  {
    name: 'platform-launcher',
    dockerfile: 'launcher.Dockerfile',
    dependsOn: 'platform-base',
    maxBytes: 1.4e9,
    versioned: true,
  },
];

const args = process.argv.slice(2);
const tagIndex = args.indexOf('--tag');
const tag = tagIndex === -1 ? 'dev' : (args[tagIndex + 1] ?? 'dev');
const sizeCheck = args.includes('--size-check');
const known = new Set(['--tag', '--size-check']);
const unknownFlag = args.find((value) => value.startsWith('--') && !known.has(value));
if (unknownFlag !== undefined) {
  // An unrecognised flag is refused rather than ignored: `--size-chek` silently building without
  // the check is the shape of a guard that is never applied (standing rule 18).
  process.stderr.write(
    `unknown option ${unknownFlag}\nusage: build-images.mjs [--tag <tag>] [--size-check] [image…]\n`,
  );
  process.exit(2);
}
const wanted = args.filter((value, index) => {
  if (value.startsWith('--')) {
    return false;
  }
  return index !== tagIndex + 1 || tagIndex === -1;
});

const selected =
  wanted.length === 0
    ? IMAGES
    : IMAGES.filter((image) =>
        wanted.includes(image.name.replace(/^platform-?/, '') || 'platform'),
      );

if (selected.length === 0 && wanted.length > 0) {
  process.stderr.write(
    `unknown image(s): ${wanted.join(', ')}\n` +
      `known: ${IMAGES.map((image) => image.name.replace(/^platform-?/, '') || 'platform').join(', ')}\n`,
  );
  process.exit(2);
}

/** Everything the selection needs, in build order, with dependencies pulled in ahead of it. */
const order = IMAGES.filter(
  (image) =>
    selected.includes(image) ||
    selected.some((entry) => entry.dependsOn === image.name && !hasImage(image.name)),
);

function hasImage(name) {
  return (
    spawnSync('docker', ['image', 'inspect', `${name}:${tag}`], { stdio: 'ignore' }).status === 0
  );
}

/** `547MB` → 547e6. Docker prints decimal units (`kB`, `MB`, `GB`), not binary ones. */
function parseDockerSize(text) {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(B|kB|MB|GB|TB)$/.exec(text.trim());
  if (match === null) {
    throw new Error(`cannot read a size from docker's output: ${JSON.stringify(text)}`);
  }
  const units = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return Number(match[1]) * units[match[2]];
}

/** The unpacked size — see the header for the two quantities this is deliberately not. */
function imageBytes(name) {
  const result = spawnSync('docker', ['images', '--format', '{{.Size}}', `${name}:${tag}`], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`docker images ${name}:${tag} failed: ${result.stderr}`);
  }
  return parseDockerSize(result.stdout);
}

/**
 * The build metadata, from the environment, as **build arguments**.
 *
 * `docker build` does not forward the environment to an `ARG`: a workflow that exported
 * `APP_VERSION` as a step env and called this script produced images reporting `0.0.0-dev` and
 * `commit: null` at `GET /api/version`, on every tag it published. Measured, and it is why
 * {@link assertBuildMetadata} exists rather than a comment saying to remember.
 */
const BUILD_METADATA = ['APP_VERSION', 'APP_COMMIT', 'APP_BUILT_AT'];
const metadataArgs = BUILD_METADATA.filter((name) => (process.env[name] ?? '').length > 0).flatMap(
  (name) => ['--build-arg', `${name}=${process.env[name]}`],
);

/**
 * What was passed as a build argument is in the image (`ENV APP_VERSION=${APP_VERSION}`).
 *
 * The failure this guards is silent by construction — an image builds, runs, serves, and reports a
 * version nobody set — so the check is on the artefact rather than on the argument vector, and it
 * runs only when there was something to forward.
 */
function assertBuildMetadata(reference) {
  if (metadataArgs.length === 0) {
    return null;
  }
  const inspected = spawnSync(
    'docker',
    ['image', 'inspect', reference, '--format', '{{json .Config.Env}}'],
    { encoding: 'utf8' },
  );
  // Same rule as the size read below: an answer this script cannot understand is a **failed
  // check**, not a stack. `{{json .Config.Env}}` is `null` for an image with no env at all, and an
  // inspect that failed prints nothing — both parse to something `includes` cannot be called on,
  // and an uncaught throw here would end the run with no `FAIL: build-images` line for a caller
  // reading for one.
  let env;
  try {
    env = JSON.parse(inspected.stdout.trim() || '[]');
    if (!Array.isArray(env)) {
      throw new Error(`expected an array of environment entries, got ${typeof env}`);
    }
  } catch (error) {
    return `${reference} built, but its environment could not be read: ${error}`;
  }
  const missing = BUILD_METADATA.filter((name) => (process.env[name] ?? '').length > 0).filter(
    (name) => !env.includes(`${name}=${process.env[name]}`),
  );
  return missing.length === 0 ? null : `${reference} did not take ${missing.join(', ')}`;
}

let failed = false;
for (const image of order) {
  const reference = `${image.name}:${tag}`;
  const buildArgs = [
    ...(image.dependsOn === null ? [] : ['--build-arg', `BASE_IMAGE=${image.dependsOn}:${tag}`]),
    ...(image.versioned === true ? metadataArgs : []),
  ];
  process.stdout.write(`\n── ${reference} (docker/${image.dockerfile}) ──\n`);
  const build = spawnSync(
    'docker',
    ['build', '-f', path.join('docker', image.dockerfile), ...buildArgs, '-t', reference, '.'],
    { cwd: REPO, stdio: 'inherit' },
  );
  if (build.status !== 0) {
    process.stdout.write(`FAIL: ${reference} did not build\n`);
    failed = true;
    break;
  }
  const metadata = image.versioned === true ? assertBuildMetadata(reference) : null;
  if (metadata !== null) {
    process.stdout.write(`FAIL: ${metadata}\n`);
    failed = true;
  }
  // A size this script cannot read is a **failed check**, not a stack trace: `imageBytes` throws on
  // an empty or unparseable `docker images` output (a tag the daemon no longer has, a future
  // Docker that prints units differently), and an uncaught throw here would end the run without the
  // one line every other path prints — so a caller reading for `PASS:`/`FAIL:` would see neither.
  let bytes;
  try {
    bytes = imageBytes(image.name);
  } catch (error) {
    process.stdout.write(`FAIL: ${reference} built, but its size could not be read: ${error}\n`);
    failed = true;
    continue;
  }
  const mib = (bytes / 1e6).toFixed(0);
  if (sizeCheck && bytes > image.maxBytes) {
    process.stdout.write(
      `FAIL: ${reference} is ${mib} MB unpacked, over its ${(image.maxBytes / 1e6).toFixed(0)} MB budget\n`,
    );
    failed = true;
  } else {
    process.stdout.write(`built ${reference} — ${mib} MB unpacked\n`);
  }
}

process.stdout.write(
  `${failed ? 'FAIL' : 'PASS'}: build-images (${order.length} image(s), tag ${tag})\n`,
);
process.exit(failed ? 1 : 0);
