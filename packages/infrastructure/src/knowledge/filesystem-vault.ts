/**
 * `VaultSource` over a checkout on disk — the project's repository at its default branch (BD-025).
 *
 * ## What it reads, and why the set is asked of the filesystem
 *
 * technical/07 names four things: `knowledge_dir`, `.agentic/rules`, `CLAUDE.md` and `AGENTS.md`.
 * The walk is driven by `isIndexedVaultPath` in `@platform/application` rather than by a list kept
 * here, so a rule added to the repository is indexed on the next run with no code change, and the
 * predicate the indexer's tests drive is the same one the adapter uses (rule 7).
 *
 * ## It is not the adapter production composes — `git-vault.ts` is (WP-18a)
 *
 * This one takes "the absolute path of a checkout", and the platform process has none: a run's tree
 * lives on `ws-<run>` inside a container and the launcher's mirror on `repo-cache`, neither of which
 * the server mounts. TD-026 therefore gave the indexer a second `VaultSource` over a platform-side
 * **bare mirror**, read with git plumbing, and that is what `apps/server/src/knowledge.ts` composes.
 * This adapter stays as the reader for a tree that is genuinely on disk — a checkout a future
 * take-over, import or test hands it — and the two are held to the same corpus by `FIXTURE_VAULT`.
 *
 * ## `repoPaths` is the working tree, and the residual is stated
 *
 * `VaultSnapshot.repoPaths` is what validate-on-read checks a document's `paths:` against, and
 * technical/07 words it as "no longer exist **at HEAD**". This adapter answers with the files
 * present in the checkout, skipping `.git` — which is the same set in the situation the platform
 * actually produces, a fresh clone at the default branch with nothing untracked in it. In a *dirty*
 * tree the two differ by the untracked files, and the direction of that error is to **keep** a
 * document whose cited path exists only locally rather than to drop one. The git-backed adapter has
 * no such residual, because `ls-tree` answers with the paths tracked *at the commit* — which is the
 * sharper reason it, and not this, is what the index job reads.
 *
 * ## Failure is `unavailable`, never an empty vault
 *
 * A missing directory, an unreadable file, a path that is not a directory: all of them come back as
 * `{ status: 'unavailable', reason }`, so the indexer leaves the existing index in place. The one
 * case that is **not** a failure is a checkout that exists and contains no vault documents — that
 * is a project which has not written anything yet, and it indexes to zero documents on purpose.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  isIndexedVaultPath,
  type VaultDocumentSource,
  type VaultReadRequest,
  type VaultReadResult,
  type VaultSource,
  vaultRelativePath,
} from '@platform/application';

/** Directories never walked: version control metadata and dependency trees. */
export const SKIPPED_DIRECTORIES: readonly string[] = ['.git', 'node_modules'];

/** A ceiling on the walk, so a pathological checkout cannot hang an index job. */
export const MAX_WALKED_ENTRIES = 200_000;

export interface FilesystemVaultOptions {
  /** Absolute path of the checkout. */
  readonly rootPath: string;
  /** The commit the checkout is at; recorded on every indexed row. */
  readonly commitSha: string;
}

const digest = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

interface WalkResult {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

const walk = async (root: string): Promise<WalkResult> => {
  const found: string[] = [];
  const queue: string[] = [''];
  let truncated = false;

  while (queue.length > 0) {
    const relative = queue.shift() as string;
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
        queue.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (found.length >= MAX_WALKED_ENTRIES) {
        truncated = true;
        return { paths: found, truncated };
      }
      found.push(child);
    }
  }
  return { paths: found.sort(), truncated };
};

export const createFilesystemVaultSource = (options: FilesystemVaultOptions): VaultSource => ({
  read: async (request: VaultReadRequest): Promise<VaultReadResult> => {
    try {
      const rootStat = await stat(options.rootPath);
      if (!rootStat.isDirectory()) {
        return { status: 'unavailable', reason: `${options.rootPath} is not a directory` };
      }
    } catch (cause) {
      return {
        status: 'unavailable',
        reason: `cannot read the checkout: ${(cause as Error).message}`,
      };
    }

    let walked: WalkResult;
    try {
      walked = await walk(options.rootPath);
    } catch (cause) {
      return { status: 'unavailable', reason: `walk failed: ${(cause as Error).message}` };
    }
    if (walked.truncated) {
      return {
        status: 'unavailable',
        reason: `checkout has more than ${MAX_WALKED_ENTRIES} files; refusing a partial listing`,
      };
    }

    const documents: VaultDocumentSource[] = [];
    for (const relative of walked.paths) {
      if (!isIndexedVaultPath(relative, request.knowledgeDir)) continue;
      try {
        const source = await readFile(path.join(options.rootPath, relative), 'utf8');
        documents.push({
          path: relative,
          vaultRelativePath: vaultRelativePath(relative, request.knowledgeDir),
          source,
          contentHash: digest(source),
        });
      } catch (cause) {
        // One unreadable document fails the whole read. A partial vault silently missing the page
        // that would have prevented the bug is worse than an index run that did not happen.
        return {
          status: 'unavailable',
          reason: `cannot read ${relative}: ${(cause as Error).message}`,
        };
      }
    }

    return {
      status: 'ok',
      snapshot: {
        commitSha: request.commitSha ?? options.commitSha,
        documents,
        repoPaths: walked.paths,
      },
    };
  },
});
