#!/usr/bin/env node
/**
 * `pnpm notices` — regenerate `THIRD_PARTY_NOTICES.md` from the lockfile and the build files.
 *
 *   node scripts/notices.mjs            write the file, reporting what changed
 *   node scripts/notices.mjs --check    exit 1 if the committed file is stale (a step of `verify`)
 *
 * technical/11 § "Repository layout" lists `THIRD_PARTY_NOTICES.md` beside the licence, and
 * `docker/base.Dockerfile` copies it into every image built on the base. A notices file written by
 * hand is a list of what somebody remembered, which is standing rule **7** in the one place where
 * being out of date is a legal statement rather than a stale comment — so this file is generated,
 * committed, and held to its sources by `pnpm notices:check` in `verify:static` (the `schemas:check`
 * precedent, and rule **34**: the step is in `verify:static`, which is exactly the one command CI's
 * lint job runs).
 *
 * ## Where the scope comes from — two sources, neither of them a list in this file
 *
 * **1. npm packages: `pnpm-lock.yaml`.** Every package reachable from an importer's `dependencies`
 * or `optionalDependencies`, transitively through `snapshots`. `devDependencies` are **excluded**,
 * and that is a statement about what the artefacts ship rather than a convenience: the product
 * image installs `pnpm install --frozen-lockfile --prod --filter @platform/server...`
 * (`docker/app.Dockerfile`), the launcher and runtime images do the same for their own sub-graphs,
 * and the browser bundle inlines `apps/web`'s `dependencies` only — vitest, biome, playwright,
 * vite and tailwind are in no image and in no bundle. A `link:` version is a workspace package of
 * this repository (Apache-2.0, `LICENSE`) and is skipped.
 *
 * The lockfile is a **multi-document** YAML stream: pnpm writes its own `packageManagerDependencies`
 * document first and the workspace's second. Nothing here special-cases that, because the rule
 * above already excludes it — `pnpm` itself is under `packageManagerDependencies`, which is neither
 * `dependencies` nor `optionalDependencies`.
 *
 * **2. Everything that is not an npm package: `docker/*.Dockerfile` and `compose.yml`.** Every
 * `ARG <NAME>=<value>` whose name ends in `_VERSION`, `_IMAGE` or `_URL`, every `image:` in the
 * compose file, and every compose environment default for a key ending in `_IMAGE` (which is how
 * `alpine/git` reaches a run). A licence for one of those cannot be derived from this tree — there
 * is no `package.json` to read — so it is **declared** in {@link PINNED_ARTEFACTS} with the URL it
 * was read from and the date it was read. The list is self-policing rather than hand-maintained in
 * the sense rule 7 forbids: the scan and the table are compared **in both directions**, so a new
 * pinned binary fails the generator by name until somebody decides its licence, and an entry that
 * no build file mentions any more fails too.
 *
 * ## Where the licences come from
 *
 * For an npm package, the `license` field of its own `package.json` in the pnpm store
 * (`node_modules/.pnpm/…`). A declaration that is not an SPDX expression — `SEE LICENSE IN …`, or
 * missing altogether — is refused unless it has an entry in {@link NON_SPDX_DECLARATIONS} stating
 * what was measured and where. That is the same self-policing shape: a dependency whose terms are
 * not an SPDX identifier is a decision a human makes once, loudly, rather than an `Unknown` that
 * ships.
 *
 * ## Platform-specific builds are a family, and the reason is that this check has to run twice
 *
 * A package the lockfile marks with `os`, `cpu` or `libc` is a per-platform build; only the host's
 * own is installed. Reading its `package.json` would therefore make the generated file depend on
 * the machine that generated it — macOS here, `ubuntu-latest` in CI — and `notices:check` would
 * fail on one of the two whatever was committed. So a variant's own `package.json` is **never**
 * read: the variants are listed under the base package that declares them, by name and version,
 * from the lockfile, which is byte-identical on every host. What the notices then state about a
 * variant is what its family states, which is the honest claim — `@anthropic-ai/claude-agent-sdk`
 * and `@anthropic-ai/claude-agent-sdk-linux-x64` both point at a file rather than at an SPDX
 * identifier, and that is exactly TD-018's open item.
 *
 * ## What it cannot do, stated rather than implied
 *
 * - It reads the **declared** licence, not the licence text, and it does not verify that a package's
 *   declaration matches the `LICENSE` file beside it. Two packages in this tree are known to
 *   disagree with their own declaration and are recorded in {@link NON_SPDX_DECLARATIONS}.
 * - A base image is an aggregate of hundreds of distribution packages (`node:24-trixie-slim` carries
 *   Debian trixie, `alpine:3.21` carries Alpine's own). The notices name the image and its upstream's
 *   licence; they do **not** enumerate the distribution's package manifest, which is obtained from
 *   the image itself (`dpkg-query -W -f='${Package} ${source:Version}\n'` / `apk info -v`).
 * - It says nothing about a transitive licence obligation (a copyleft dependency of a dependency is
 *   listed, not analysed).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

// ── The declared facts ───────────────────────────────────────────────────────────────────────────

/**
 * The non-npm artefacts the images and the compose file pin, each with the terms that were read and
 * the page they were read from.
 *
 * Keyed by the Dockerfile `ARG` name or the compose image reference the scan produces, so the two
 * sides can be compared as sets. `ours` marks something this repository builds or a build argument
 * that is not an artefact at all; it carries a reason because "why is this not in the notices" is
 * the question a reader of a notices file asks.
 */
const PINNED_ARTEFACTS = {
  // Build arguments that name no third-party artefact.
  BASE_IMAGE: { ours: 'platform-base, built from docker/base.Dockerfile in this repository' },
  APP_VERSION: { ours: 'build metadata stamped into the image label; empty by default' },

  NODE_IMAGE: {
    artefact: 'node:24-trixie-slim (Node.js runtime, Debian trixie base)',
    licence:
      'MIT (Node.js); the image also carries Debian trixie packages under their own licences',
    url: 'https://github.com/nodejs/node/blob/main/LICENSE',
    retrieved: '2026-09-13',
    note: "Node's own LICENSE file is an aggregate: it carries the notices of the dependencies Node bundles (V8, ICU, zlib, OpenSSL and others) after the MIT grant. The Debian layer is not enumerated here; see “What this file does not cover”.",
  },
  GH_VERSION: {
    artefact: 'gh (GitHub CLI)',
    licence: 'MIT',
    url: 'https://github.com/cli/cli/blob/trunk/LICENSE',
    retrieved: '2026-09-13',
  },
  GLAB_VERSION: {
    artefact: 'glab (GitLab CLI)',
    licence: 'MIT',
    url: 'https://gitlab.com/gitlab-org/cli/-/blob/main/LICENSE',
    retrieved: '2026-09-13',
  },
  LOGCLI_VERSION: {
    artefact: 'logcli (Grafana Loki)',
    licence: 'AGPL-3.0-only',
    url: 'https://github.com/grafana/loki/blob/main/LICENSE',
    retrieved: '2026-09-13',
    note: 'Executed as a separate process inside a run container and never linked; the AGPL obligation attaches to Loki, which this project neither modifies nor serves over a network.',
  },
  SENTRY_CLI_VERSION: {
    artefact: 'sentry-cli',
    licence: 'FSL-1.1-MIT (Functional Source License 1.1, MIT Future License)',
    url: 'https://github.com/getsentry/sentry-cli/blob/3.7.0/LICENSE',
    retrieved: '2026-09-13',
    note: 'Read at the pinned tag rather than at the default branch. Not an OSI-approved licence: it permits any purpose that does not compete with Sentry, and converts to MIT two years after each release.',
  },
  JIRA_CLI_VERSION: {
    artefact: 'jira (ankitpokhrel/jira-cli)',
    licence: 'MIT',
    url: 'https://github.com/ankitpokhrel/jira-cli/blob/main/LICENSE',
    retrieved: '2026-09-13',
  },
  SENTRY_MCP_VERSION: {
    artefact: '@sentry/mcp-server (installed with npm inside the image, not through the lockfile)',
    licence: 'FSL-1.1-ALv2 (Functional Source License 1.1, Apache 2.0 Future License)',
    url: 'https://registry.npmjs.org/@sentry/mcp-server/0.39.0',
    retrieved: '2026-09-13',
    note: "Declared by the published package itself. The repository's own LICENSE.md is reported by the GitHub licence API as `NOASSERTION`, which is what that API answers for a licence it does not recognise.",
  },
  ACLI_URL: {
    artefact: 'acli (Atlassian CLI)',
    licence: '[unverified] — Atlassian publishes no licence with the binary',
    url: 'https://developer.atlassian.com/cloud/acli/',
    retrieved: '2026-09-13',
    note: "TD-018's open item, unresolved. The download is a bare binary from a single “latest” path with no licence file, no checksum and no terms on the product page; Atlassian's general Developer Terms are linked from the page footer and say nothing about redistributing the binary inside a third-party image. Recorded as unverified rather than assumed permissive. An operator who must avoid the question builds `platform-runtime` with `--build-arg ACLI_URL=<their own copy>`.",
  },
  ALPINE_IMAGE: {
    artefact: 'alpine:3.21 (base of platform-egress)',
    licence:
      'MIT (the image recipe); the distribution aggregates many licences, musl MIT and busybox GPL-2.0-only among them',
    url: 'https://github.com/alpinelinux/docker-alpine/blob/master/LICENSE',
    retrieved: '2026-09-13',
  },
  TINYPROXY_VERSION: {
    artefact: 'tinyproxy (the per-run egress proxy)',
    licence: 'GPL-2.0',
    url: 'https://github.com/tinyproxy/tinyproxy/blob/master/COPYING',
    retrieved: '2026-09-13',
    note: 'Executed as a separate process in a sidecar container and never linked.',
  },

  // compose.yml — `image:` values and `*_IMAGE` environment defaults.
  'platform:${PLATFORM_TAG:-dev}': { ours: 'the product image, docker/app.Dockerfile' },
  'platform-base:${PLATFORM_TAG:-dev}': {
    ours: 'the base image, docker/base.Dockerfile; compose passes it as a build argument',
  },
  'platform-launcher:${PLATFORM_TAG:-dev}': {
    ours: 'the launcher image, docker/launcher.Dockerfile',
  },
  'platform-runtime:${PLATFORM_TAG:-dev}': { ours: 'the run image, docker/runtime.Dockerfile' },
  'platform-egress:${PLATFORM_TAG:-dev}': { ours: 'the egress sidecar, docker/egress.Dockerfile' },
  'postgres:18': {
    artefact: 'postgres:18 (the database)',
    licence: 'PostgreSQL License (OSI-approved, BSD/MIT-like)',
    url: 'https://www.postgresql.org/about/licence/',
    retrieved: '2026-09-13',
    note: 'The Docker Official Image recipe is MIT (github.com/docker-library/postgres); the server it packages is under the PostgreSQL License.',
  },
  'tecnativa/docker-socket-proxy:0.3.0': {
    artefact: 'tecnativa/docker-socket-proxy (TD-021, the filter in front of the daemon)',
    licence: 'Apache-2.0',
    url: 'https://github.com/Tecnativa/docker-socket-proxy/blob/master/LICENSE.txt',
    retrieved: '2026-09-13',
  },
  'prodrigestivill/postgres-backup-local:18': {
    artefact: 'prodrigestivill/postgres-backup-local (the `backup` profile)',
    licence: 'MIT',
    url: 'https://github.com/prodrigestivill/docker-postgres-backup-local/blob/master/LICENSE',
    retrieved: '2026-09-13',
  },
  'alpine/git:v2.49.1': {
    artefact: 'alpine/git (the helper container the launcher clones and exports with)',
    licence: 'Apache-2.0 (the image recipe); git itself is GPL-2.0-only with LGPL-2.1 parts',
    url: 'https://github.com/alpine-docker/git/blob/master/LICENSE',
    retrieved: '2026-09-13',
    note: 'Started as a container and never linked. The GitHub licence API answers `NOASSERTION` for git itself because `COPYING` is GPLv2 with an LGPL exception note; the file itself is the GNU General Public License, Version 2.',
  },
};

/**
 * npm packages whose `license` field is not an SPDX expression, with what was actually read.
 *
 * Every entry here is a decision somebody made once. The generator refuses any other package with a
 * non-SPDX declaration, so this list cannot grow silently.
 */
const NON_SPDX_DECLARATIONS = {
  'awilix-manager': {
    licence: 'MIT',
    note: 'The published package has **no `license` field** at all; the `LICENSE` file it ships is the MIT License, “Copyright (c) 2023 Igor Savin”. Recorded here rather than published as `Unknown`, which is what a licence tool reading the manifest alone answers.',
  },
  '@anthropic-ai/claude-agent-sdk': {
    licence: '[unverified] proprietary — © Anthropic PBC, all rights reserved',
    note: "The README it points at has no licence section; the package ships `LICENSE.md`, which reads in full: “© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.” Its platform-specific packages, listed in the section below, carry the `claude` executable itself — 217 MB of the product image. **Whether that binary may be redistributed inside a public image is TD-018's open item and is still unverified**; the fallback TD-018 records — install it at image build from the official source, or at first start — is unchanged by this file.",
  },
};

// ── The lockfile ─────────────────────────────────────────────────────────────────────────────────

/**
 * A parser for the subset of YAML a pnpm v9 lockfile is written in.
 *
 * Deliberately not a YAML library: the repository has none at the root, and adding a dependency to
 * a script whose whole purpose is to account for dependencies is a poor trade. The subset is
 * two-space block mappings with bare or single-quoted keys, scalars kept as raw strings, and `---`
 * document separators; flow values (`{integrity: …}`, `[arm64]`) are kept verbatim and interpreted
 * by the caller. {@link parseLockfile} refuses a `lockfileVersion` it was not written for, so a
 * format change is a failure rather than a silent misread.
 */
export const parseYamlDocuments = (text) => {
  const documents = [];
  let lines = [];
  for (const line of text.split('\n')) {
    if (line === '---') {
      if (lines.length > 0) documents.push(parseBlock(lines, 0, 0).value);
      lines = [];
      continue;
    }
    lines.push(line);
  }
  if (lines.length > 0) documents.push(parseBlock(lines, 0, 0).value);
  return documents;
};

/**
 * Reads one block mapping — or, when the first entry at `indent` is a `- ` item, one block sequence
 * of scalars — starting at `index`; returns the value and where it ended.
 */
const parseBlock = (lines, index, indent) => {
  let value = {};
  let sequence = null;
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) {
      cursor += 1;
      continue;
    }
    const depth = line.length - line.trimStart().length;
    if (depth < indent) break;
    if (depth > indent) {
      throw new Error(`unexpected indentation at line ${cursor + 1}: ${JSON.stringify(line)}`);
    }
    if (line.slice(indent).startsWith('- ')) {
      if (Object.keys(value).length > 0) {
        throw new Error(`sequence item inside a mapping at line ${cursor + 1}`);
      }
      if (sequence === null) sequence = [];
      sequence.push(unquote(line.slice(indent + 2)));
      cursor += 1;
      continue;
    }
    if (sequence !== null) {
      throw new Error(`mapping entry inside a sequence at line ${cursor + 1}`);
    }
    const match = /^(?:'((?:[^']|'')*)'|([^:]*)):(?: (.*))?$/.exec(line.slice(indent));
    if (match === null) {
      throw new Error(`cannot parse line ${cursor + 1}: ${JSON.stringify(line)}`);
    }
    const key = match[1] === undefined ? match[2] : match[1].replaceAll("''", "'");
    const scalar = match[3];
    if (scalar === undefined) {
      const nested = parseBlock(lines, cursor + 1, indent + 2);
      value[key] = nested.empty ? null : nested.value;
      cursor = nested.index;
      continue;
    }
    value[key] = scalar;
    cursor += 1;
  }
  if (sequence !== null) value = sequence;
  return {
    value,
    index: cursor,
    empty: sequence === null && Object.keys(value).length === 0,
  };
};

/** `'a''b'` → `a'b`; anything unquoted is returned as it stands. */
const unquote = (text) =>
  text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1).replaceAll("''", "'") : text;

/** Strips the peer-dependency suffix a snapshot id carries: `a@1(b@2)` → `a@1`. */
export const packageIdOf = (snapshotId) => {
  const parenthesis = snapshotId.indexOf('(');
  return parenthesis === -1 ? snapshotId : snapshotId.slice(0, parenthesis);
};

/** Splits `@scope/name@1.2.3` into its two halves. */
export const splitPackageId = (packageId) => {
  const at = packageId.lastIndexOf('@');
  if (at <= 0) throw new Error(`not a package id: ${packageId}`);
  return { name: packageId.slice(0, at), version: packageId.slice(at + 1) };
};

/**
 * The npm packages any image or bundle ships, as package ids, with the platform variants separated.
 *
 * Walks every document's importers (see the docblock: `packageManagerDependencies` is excluded by
 * the rule rather than by a special case) and every snapshot reachable from them.
 */
export const productionClosure = (documents) => {
  const packages = {};
  const snapshots = {};
  const roots = [];
  for (const document of documents) {
    Object.assign(packages, document.packages ?? {});
    Object.assign(snapshots, document.snapshots ?? {});
    for (const importer of Object.values(document.importers ?? {})) {
      for (const group of ['dependencies', 'optionalDependencies']) {
        for (const [name, entry] of Object.entries(importer?.[group] ?? {})) {
          roots.push(`${name}@${entry.version}`);
        }
      }
    }
  }

  const seen = new Set();
  const dependents = new Map();
  const queue = roots.filter((id) => !id.includes('@link:'));
  while (queue.length > 0) {
    const snapshotId = queue.pop();
    if (seen.has(snapshotId)) continue;
    seen.add(snapshotId);
    const snapshot = snapshots[snapshotId];
    if (snapshot === undefined) {
      throw new Error(`no snapshot for ${snapshotId} — the lockfile is not self-consistent`);
    }
    for (const group of ['dependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(snapshot[group] ?? {})) {
        if (version.startsWith('link:')) continue;
        const child = `${name}@${version}`;
        const declarers = dependents.get(packageIdOf(child)) ?? new Set();
        declarers.add(packageIdOf(snapshotId));
        dependents.set(packageIdOf(child), declarers);
        queue.push(child);
      }
    }
  }

  const ids = [...new Set([...seen].map(packageIdOf))].sort();
  const variantOf = {};
  const plain = [];
  for (const id of ids) {
    const metadata = packages[id];
    if (metadata === undefined) {
      throw new Error(`no \`packages\` entry for ${id} — the lockfile is not self-consistent`);
    }
    const platformBound = ['os', 'cpu', 'libc'].some((field) => metadata[field] !== undefined);
    if (!platformBound) {
      plain.push(id);
      continue;
    }
    // The family is read off the lockfile, not guessed from the name: `@rolldown/binding-linux-x64`
    // belongs to `rolldown` and no prefix rule says so. The one package that declares it as an
    // optional dependency is the one whose terms it is published under; two would be a question
    // nobody has answered, and none means it was pulled in directly, which is also a decision.
    const family = [...(dependents.get(id) ?? new Set())];
    if (family.length !== 1) {
      throw new Error(
        `${id} is a platform-specific build declared by ${family.length === 0 ? 'nothing' : family.join(' and ')}; decide how it should be reported before it can be published`,
      );
    }
    variantOf[family[0]] = [...(variantOf[family[0]] ?? []), id];
  }
  return { ids: plain, variantOf, packages };
};

/** Parses the lockfile text, refusing a version this parser was not written against. */
export const parseLockfile = (text) => {
  const documents = parseYamlDocuments(text);
  for (const document of documents) {
    if (document.lockfileVersion !== "'9.0'") {
      throw new Error(
        `unsupported lockfileVersion ${document.lockfileVersion}; scripts/notices.mjs parses 9.0`,
      );
    }
  }
  return documents;
};

// ── Licences from the pnpm store ─────────────────────────────────────────────────────────────────

const SPDX = /^[A-Za-z0-9.+()\-\s]+$/;

/** `@scope/name` → `@scope+name`, which is how pnpm names the store directory. */
const storeDirectoryName = (name, version) => `${name.replace('/', '+')}@${version}`;

/**
 * Reads each package's declared licence out of `node_modules/.pnpm`.
 *
 * A package in the closure that is not on disk is a failure by name: it means the install is not the
 * lockfile's, and a notices file generated from a partial install is the silent kind of wrong.
 */
export const readDeclaredLicences = (ids, modulesRoot) => {
  const directories = readdirSync(join(modulesRoot, '.pnpm'));
  const declared = {};
  for (const id of ids) {
    const { name, version } = splitPackageId(id);
    const wanted = storeDirectoryName(name, version);
    const directory = directories.find(
      (candidate) => candidate === wanted || candidate.startsWith(`${wanted}_`),
    );
    if (directory === undefined) {
      throw new Error(
        `${id} is in the lockfile's production closure and not in node_modules/.pnpm — run \`pnpm install --frozen-lockfile\` before generating the notices`,
      );
    }
    const manifest = JSON.parse(
      readFileSync(
        join(modulesRoot, '.pnpm', directory, 'node_modules', name, 'package.json'),
        'utf8',
      ),
    );
    declared[id] = typeof manifest.license === 'string' ? manifest.license : null;
  }
  return declared;
};

/** The licence to publish for a package, refusing a non-SPDX declaration nobody has decided. */
export const resolveLicence = (id, declaration) => {
  const { name } = splitPackageId(id);
  const decided = NON_SPDX_DECLARATIONS[name];
  const isSpdx =
    declaration !== null && SPDX.test(declaration) && !/^SEE LICENSE IN/i.test(declaration);
  if (isSpdx) {
    if (decided !== undefined) {
      throw new Error(
        `${name} declares the SPDX expression ${JSON.stringify(declaration)} and still has a NON_SPDX_DECLARATIONS entry; remove the entry`,
      );
    }
    return { licence: declaration, note: null };
  }
  if (decided === undefined) {
    throw new Error(
      `${id} declares ${JSON.stringify(declaration)}, which is not an SPDX expression. Read its terms, then add an entry to NON_SPDX_DECLARATIONS in scripts/notices.mjs saying what you read.`,
    );
  }
  return { licence: decided.licence, note: decided.note, declaration };
};

// ── The build files ──────────────────────────────────────────────────────────────────────────────

/** Every pinned non-npm artefact the Dockerfiles and the compose file name, as scan keys. */
export const scanPinnedArtefacts = (root) => {
  const found = new Map();
  const dockerDirectory = join(root, 'docker');
  for (const file of readdirSync(dockerDirectory).sort()) {
    if (!file.endsWith('.Dockerfile')) continue;
    const text = readFileSync(join(dockerDirectory, file), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^ARG ([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match === null || !/_(VERSION|IMAGE|URL)$/.test(match[1])) continue;
      const where = found.get(match[1]) ?? { pins: new Set(), files: new Set() };
      if (match[2].length > 0) where.pins.add(match[2]);
      where.files.add(`docker/${file}`);
      found.set(match[1], where);
    }
  }
  const compose = readFileSync(join(root, 'compose.yml'), 'utf8');
  for (const line of compose.split('\n')) {
    const image = /^\s*image:\s*(\S+)\s*$/.exec(line);
    // `APP_WORKSPACE_*_IMAGE` is how the launcher is told which image to create a run from, so it
    // names artefacts no `image:` key does — `alpine/git`, which no compose service ever starts.
    // Two spellings: a literal, and `${VAR:-default}` where the default is the shipped choice.
    const variable = /^\s*[A-Z0-9_]+_IMAGE:\s*(\S+)\s*$/.exec(line);
    const indirect = variable === null ? null : /^\$\{[A-Z0-9_]+:-(.+)\}$/.exec(variable[1]);
    const reference = image?.[1] ?? indirect?.[1] ?? variable?.[1];
    if (reference === undefined || reference === null) continue;
    // A digest pin is part of the artefact, not part of its identity: `postgres:18@sha256:…` and
    // `postgres:18` are the same upstream project with the same licence, and putting the digest in
    // the key would make a Renovate bump fail this generator for no decision anybody has to take.
    const key = reference.split('@sha256:')[0];
    const where = found.get(key) ?? { pins: new Set(), files: new Set() };
    where.pins.add(reference);
    where.files.add('compose.yml');
    found.set(key, where);
  }
  return found;
};

/**
 * The scan and {@link PINNED_ARTEFACTS} compared **in both directions** (the census shape).
 *
 * One direction alone would be a filter that outlives what it excuses: an entry for an artefact no
 * build file mentions any more is as wrong as a pinned binary with no entry, and only the second
 * has a symptom anybody would notice.
 *
 * @param declared the table to compare against; the default is this file's own.
 */
export const assertPinnedArtefactsAgree = (pinned, declared = PINNED_ARTEFACTS) => {
  const missing = [...pinned.keys()].filter((key) => declared[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `the build files pin artefacts scripts/notices.mjs has no entry for: ${missing.join(', ')}. Read each one's licence, then add it to PINNED_ARTEFACTS with the URL and the date.`,
    );
  }
  const stale = Object.keys(declared).filter((key) => !pinned.has(key));
  if (stale.length > 0) {
    throw new Error(
      `PINNED_ARTEFACTS names artefacts no build file mentions any more: ${stale.join(', ')}`,
    );
  }
};

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

const HEADER = `<!--
  Generated by \`pnpm notices\` from pnpm-lock.yaml, docker/*.Dockerfile and compose.yml.
  Do not edit by hand: \`pnpm notices:check\` (a step of \`verify:static\`, which CI's lint job runs)
  fails when this file and its sources disagree. The reasoning is in scripts/notices.mjs.
-->`;

const escapeCell = (text) => text.replaceAll('|', '\\|');

export const renderNotices = ({ ids, variantOf, declared, pinned }) => {
  const resolved = new Map(ids.map((id) => [id, resolveLicence(id, declared[id])]));

  const counts = new Map();
  for (const { licence } of resolved.values()) {
    counts.set(licence, (counts.get(licence) ?? 0) + 1);
  }
  const summary = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1),
  );

  const variantCount = Object.values(variantOf).reduce((total, list) => total + list.length, 0);
  const thirdParty = [...pinned.entries()]
    .filter(([key]) => PINNED_ARTEFACTS[key].ours === undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  const ours = [...pinned.entries()]
    .filter(([key]) => PINNED_ARTEFACTS[key].ours !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1));

  const lines = [
    HEADER,
    '',
    '# Third-party notices',
    '',
    'The platform itself is [Apache-2.0](LICENSE). This file accounts for everything else it ships:',
    `the **${ids.length} npm packages** its images and its browser bundle carry (plus ${variantCount}`,
    'per-platform builds of those packages), and the **pinned binaries and container images** the',
    'Dockerfiles and `compose.yml` name. Bundled CLIs are *executed*, never linked.',
    '',
    'It is generated — `pnpm notices` — and `pnpm notices:check` fails the build when it and its',
    'sources disagree, so it cannot go stale quietly.',
    '',
    '## What is in scope',
    '',
    '- **npm**: every package reachable from a workspace `dependencies`/`optionalDependencies` entry',
    '  in `pnpm-lock.yaml`, transitively. `devDependencies` are not walked — the product image installs',
    '  `--prod` — and some development tooling is nevertheless in the list below, which is not a',
    '  mistake: `better-auth` declares `vitest` as an **optional peer**, pnpm’s default',
    '  `autoInstallPeers: true` applies (the lockfile records it under `settings:`), and a `--prod`',
    '  install therefore resolves it together with `vite`,',
    '  `rolldown` and `happy-dom`. Measured rather than reasoned — the `platform:dev` image built from',
    '  this tree carries 312 packages in `/app/node_modules/.pnpm`, `vitest@5.0.0`, `vite@8.2.2` and',
    '  `@rolldown/binding-linux-arm64-gnu@1.2.7` among them, and carries **no** biome, playwright,',
    '  tailwind or typescript, which no such edge reaches. This repository’s own `@platform/*`',
    '  packages are Apache-2.0 under the licence above and are not listed.',
    '- **Everything else**: every `ARG …_VERSION|_IMAGE|_URL` in `docker/*.Dockerfile` and every image',
    '  `compose.yml` names.',
    '',
    '## Summary',
    '',
    '| Licence | Packages |',
    '| --- | ---: |',
    ...summary.map(([licence, count]) => `| ${escapeCell(licence)} | ${count} |`),
    '',
    '## Pinned binaries and container images',
    '',
    'These are not npm packages, so there is no manifest in this tree to read a licence from. Each',
    'was read from the source named beside it on the date given.',
    '',
    '| Artefact | Pinned as | Licence | Read from |',
    '| --- | --- | --- | --- |',
    ...thirdParty.map(([key, where]) => {
      const entry = PINNED_ARTEFACTS[key];
      const pins = [...where.pins]
        .sort()
        .map((pin) => `\`${pin}\``)
        .join('<br>');
      return `| ${escapeCell(entry.artefact)} | ${escapeCell(pins)} | ${escapeCell(entry.licence)} | [${escapeCell(new URL(entry.url).host)}](${entry.url}) (${entry.retrieved}) |`;
    }),
    '',
    ...thirdParty
      .filter(([key]) => PINNED_ARTEFACTS[key].note !== undefined)
      .flatMap(([key]) => {
        const entry = PINNED_ARTEFACTS[key];
        return [`**${entry.artefact}** — ${entry.note}`, ''];
      }),
    'Built here and therefore covered by `LICENSE`, listed so that the table above can be read as',
    'complete: ' +
      ours.map(([key]) => `\`${key}\` (${PINNED_ARTEFACTS[key].ours})`).join('; ') +
      '.',
    '',
    '## npm packages',
    '',
    `${ids.length} packages, with the licence each one declares in its own \`package.json\`. Packages`,
    'that are built per platform are in the section after this one.',
    '',
    '| Package | Version | Licence |',
    '| --- | --- | --- |',
    ...ids.map((id) => {
      const { name, version } = splitPackageId(id);
      const { licence } = resolved.get(id);
      return `| \`${escapeCell(name)}\` | ${escapeCell(version)} | ${escapeCell(licence)} |`;
    }),
    '',
    ...ids
      .filter((id) => resolved.get(id).note != null)
      .flatMap((id) => {
        const { name } = splitPackageId(id);
        const { note, declaration } = resolved.get(id);
        return [
          `**\`${name}\`** — declared \`${declaration ?? '(no licence field)'}\`. ${note}`,
          '',
        ];
      }),
    '## Platform-specific packages',
    '',
    `${variantCount} packages in the closure are published per platform (the lockfile constrains them`,
    'with `os`, `cpu` or `libc`), so **only the host’s own build is ever installed**. This file does not',
    'read their manifests: doing so would make it depend on the machine that generated it, and',
    '`pnpm notices:check` would then fail on whichever of a contributor’s macOS and CI’s Linux had not',
    'produced it. Each is published by the project that declares it as an optional dependency, named',
    'beside it, and is covered by that project’s entry above — with one caveat worth stating, because',
    'the table cannot: a package here may be an independent project that merely happens to be',
    'platform-bound, rather than a build of the project that pulls it in. The images ship the',
    '`linux-x64` and `linux-arm64` builds.',
    '',
    '| Package | Version | Optional dependency of |',
    '| --- | --- | --- |',
    ...Object.entries(variantOf)
      .flatMap(([base, variants]) =>
        [...variants].sort().map((variant) => {
          const { name, version } = splitPackageId(variant);
          return `| \`${escapeCell(name)}\` | ${escapeCell(version)} | \`${escapeCell(splitPackageId(base).name)}\` |`;
        }),
      )
      .sort(),
    '',
    '## What this file does not cover',
    '',
    '- **The distribution packages inside a base image.** `node:24-trixie-slim` carries Debian trixie',
    '  and `alpine:3.21` carries Alpine; both are hundreds of packages under their own licences. Get',
    '  that manifest from the image rather than from here: `docker run --rm platform-base:<tag>',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg's own format syntax, quoted for a reader.
    "  dpkg-query -W -f='${Package} ${Version} ${binary:Summary}\\n'`, and `apk info -v` for the",
    '  egress image.',
    '- **Licence *texts*.** The table records what each package declares, not the body of its licence.',
    '  A distribution that must carry the texts collects them from the packages themselves; every one',
    '  is present under `node_modules` and inside the images.',
    '- **Whether a declaration is true.** Where a package’s own files disagree with its manifest, the',
    '  note beside it says what was read.',
    '- **Transitive obligations.** A copyleft dependency is listed, not analysed.',
    '',
  ];
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
};

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.stdout.write('FAIL: notices:check\n');
  process.exit(1);
};

const argument = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};

const check = process.argv.includes('--check');
const root = argument('--root', repositoryRoot);
const output = argument('--out', join(root, 'THIRD_PARTY_NOTICES.md'));

/**
 * Only when this file is the program. The exported halves above are what `scripts/notices.test.ts`
 * drives directly; the test also spawns this file, which is the artefact `verify` runs.
 */
const isProgram =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);

if (isProgram) {
  try {
    const documents = parseLockfile(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
    const { ids, variantOf } = productionClosure(documents);
    if (ids.length === 0) {
      throw new Error('the production closure is empty — nothing would be accounted for');
    }
    const declared = readDeclaredLicences(ids, join(root, 'node_modules'));
    const pinned = scanPinnedArtefacts(root);

    assertPinnedArtefactsAgree(pinned);

    const rendered = renderNotices({ ids, variantOf, declared, pinned });
    let current = null;
    try {
      current = readFileSync(output, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (check) {
      if (current !== rendered) {
        fail(
          current === null
            ? `${output} does not exist — run \`pnpm run -s notices\` and commit it.`
            : `${output} is stale — run \`pnpm run -s notices\` and commit the result.`,
        );
      }
      process.stdout.write(
        `PASS: notices:check (${ids.length} npm packages, ${pinned.size} pinned artefacts, up to date)\n`,
      );
    } else {
      if (current !== rendered) writeFileSync(output, rendered, 'utf8');
      process.stdout.write(
        `${current === rendered ? 'unchanged' : 'wrote'} ${output} (${ids.length} npm packages, ${pinned.size} pinned artefacts)\n`,
      );
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
