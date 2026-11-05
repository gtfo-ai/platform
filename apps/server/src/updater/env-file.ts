/**
 * **The updater's managed block in the worker's env file** — WP-287 (2), TD-032 decision 4.
 *
 * The four product images are named in `compose.worker.yml` as `${PLATFORM_*_IMAGE:-…}`, so the
 * updater re-pins them by owning a **marked block** of those four lines in the project's env file: the
 * one file of the install folder the project was brought up with — the **name** of the single
 * `--env-file` Compose recorded on its containers (`com.docker.compose.project.environment_file`),
 * inside the folder the updater has mounted, else `.env` (`envFileNameOf` in `updater.ts`, S-22.21).
 * The person's own `docker compose up` reads the same file, so it keeps the pinned digests. The file is written **atomically** (a temporary file in the same directory,
 * then a rename) and the whole previous file is kept as `<file>.previous` — the rollback restores it
 * byte for byte.
 *
 * A managed key set **outside** the block (a person's own `PLATFORM_IMAGE=…`) would make the file say
 * two things; dotenv's last-wins would hide it. Such a line is commented out with the reason, never
 * deleted, so the person can see what the updater took over.
 */
import { chmod, chown, copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CoreImageDigests } from '@platform/contracts';
import { WORKER_IMAGE_VARIABLE } from '../workers/compose.js';
import { IMAGE_KEYS, type ImageReferences } from './decide.js';

export const MANAGED_BLOCK_BEGIN =
  '# >>> agentic-platform updater — managed block (TD-032 decision 4): rewritten on every update';
export const MANAGED_BLOCK_END = '# <<< agentic-platform updater';

const MANAGED_KEYS: readonly string[] = IMAGE_KEYS.map((key) => WORKER_IMAGE_VARIABLE[key]);

/** The managed block for these references. */
export const managedBlock = (references: ImageReferences): string =>
  [
    MANAGED_BLOCK_BEGIN,
    ...IMAGE_KEYS.map((key) => `${WORKER_IMAGE_VARIABLE[key]}=${references[key]}`),
    MANAGED_BLOCK_END,
  ].join('\n');

/** `text` with the block replaced (or appended) and every managed key outside it commented out. */
export const rewriteManagedBlock = (text: string, references: ImageReferences): string => {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line === MANAGED_BLOCK_BEGIN) {
      inside = true;
      continue;
    }
    if (inside) {
      if (line === MANAGED_BLOCK_END) inside = false;
      continue;
    }
    const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (assignment !== null && MANAGED_KEYS.includes(assignment[1] as string)) {
      kept.push(`# ${line}  # taken over by the updater's block below`);
      continue;
    }
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') kept.pop();
  return `${[...kept, ...(kept.length === 0 ? [] : ['']), managedBlock(references)].join('\n')}\n`;
};

/** The references the managed block of `text` pins, or `null` when it has none or a partial one. */
export const managedReferencesOf = (text: string): ImageReferences | null => {
  const start = text.indexOf(`${MANAGED_BLOCK_BEGIN}\n`);
  if (start < 0) return null;
  const end = text.indexOf(MANAGED_BLOCK_END, start);
  if (end < 0) return null;
  const values = new Map<string, string>();
  for (const line of text.slice(start, end).split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match !== null) values.set(match[1] as string, match[2] as string);
  }
  const references: Partial<Record<keyof CoreImageDigests, string>> = {};
  for (const key of IMAGE_KEYS) {
    const value = values.get(WORKER_IMAGE_VARIABLE[key]);
    if (value === undefined || value === '') return null;
    references[key] = value;
  }
  return references as ImageReferences;
};

/**
 * Writes `text` to `file` atomically and gives it the **directory's** owner — the updater runs as
 * root, and a root-owned `.env` in a person's own directory would need `sudo` to edit.
 */
export const writeFileAtomically = async (
  file: string,
  text: string,
  explicitMode?: number,
): Promise<void> => {
  const directory = path.dirname(file);
  const owner = await stat(directory);
  // The file keeps its own mode; a new one is private.
  const mode =
    explicitMode ??
    (await stat(file).then(
      (existing) => existing.mode & 0o777,
      () => 0o600,
    ));
  const temporary = path.join(directory, `.${path.basename(file)}.updater-${process.pid}`);
  await writeFile(temporary, text, { mode });
  await chmod(temporary, mode);
  await chown(temporary, owner.uid, owner.gid).catch(() => undefined);
  await rename(temporary, file);
};

/** The env file's text, or `''` when it does not exist yet (a first install that used the shell). */
export const readEnvFile = async (file: string): Promise<string> =>
  readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });

/** `<file>.previous`: the whole file before this update, the rollback's source. */
export const previousOf = (file: string): string => `${file}.previous`;

/**
 * Keeps the current file as `.previous` (an absent file is kept as an empty one, so a rollback can
 * restore "no file" as "no variables") and writes the new block.
 */
export const pinReferences = async (file: string, references: ImageReferences): Promise<void> => {
  const current = await readEnvFile(file);
  const exists = await stat(file).then(
    () => true,
    () => false,
  );
  if (exists) {
    await copyFile(file, previousOf(file));
    // Private whatever the original's mode: it may hold the shell's token a person wrote in.
    await chmod(previousOf(file), 0o600);
    const owner = await stat(path.dirname(file));
    await chown(previousOf(file), owner.uid, owner.gid).catch(() => undefined);
  } else {
    await writeFileAtomically(previousOf(file), '', 0o600);
  }
  await writeFileAtomically(file, rewriteManagedBlock(current, references));
};

/**
 * `source` over `target` byte for byte and atomically — a copy beside `target`, then a rename — with
 * `target`'s directory owner. The temporary name is `.<target>.restore-<pid>`, distinct from a write's.
 */
export const copyFileAtomically = async (source: string, target: string): Promise<void> => {
  const directory = path.dirname(target);
  const owner = await stat(directory);
  const temporary = path.join(directory, `.${path.basename(target)}.restore-${process.pid}`);
  await copyFile(source, temporary);
  await chown(temporary, owner.uid, owner.gid).catch(() => undefined);
  await rename(temporary, target);
};

/** The rollback: `.previous` back, byte for byte. */
export const restorePrevious = async (file: string): Promise<void> => {
  await copyFileAtomically(previousOf(file), file);
};
