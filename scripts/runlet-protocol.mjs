/**
 * The run shim's protocol, read off its one definition — for the build, which cannot import
 * TypeScript (WP-151, TD-025's M9 amendment).
 *
 * `docker/runtime.Dockerfile` labels the run image `com.agentic.runlet-protocol` so the launcher can
 * refuse a create whose image's shim does not speak the requesting runner's protocol. A `LABEL`
 * cannot take a value a `RUN` computed, so the number reaches the Dockerfile as the build argument
 * `RUNLET_PROTOCOL`, which `scripts/build-images.mjs` takes from here — and the Dockerfile's `shim`
 * stage checks it against the same line of the source it bundles, so a hand-written argument that
 * is not the constant fails the build. `scripts/runlet-protocol.test.ts` holds the three together:
 * this reader, the constant as TypeScript sees it, and the Dockerfile's own check.
 *
 * Plain JavaScript because `build-images.mjs` runs without a TypeScript resolver.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Where `RUNLET_PROTOCOL_VERSION` is defined, relative to the repository root. */
export const RUNLET_PROTOCOL_SOURCE = 'packages/contracts/src/runlet.ts';

/** The defining line, exactly — the shape the Dockerfile's `sed` reads too. */
export const RUNLET_PROTOCOL_LINE = /^export const RUNLET_PROTOCOL_VERSION = ([0-9]+);$/gm;

/**
 * The protocol number the source at `repo` defines. Throws unless exactly one defining line is
 * found: two would be a question this reader must not answer by picking one.
 *
 * @param {string} repo the repository root
 * @returns {number}
 */
export const readRunletProtocol = (repo) => {
  const text = readFileSync(path.join(repo, RUNLET_PROTOCOL_SOURCE), 'utf8');
  const found = [...text.matchAll(RUNLET_PROTOCOL_LINE)];
  if (found.length !== 1) {
    throw new Error(
      `${RUNLET_PROTOCOL_SOURCE} must define RUNLET_PROTOCOL_VERSION on exactly one line of the form "export const RUNLET_PROTOCOL_VERSION = <n>;" (found ${found.length})`,
    );
  }
  return Number(found[0][1]);
};
