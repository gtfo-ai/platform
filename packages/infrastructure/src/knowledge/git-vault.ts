/**
 * `VaultSource` over a **platform-side bare mirror**, read with git plumbing — TD-026, WP-18a.
 *
 * The sibling adapter (`filesystem-vault.ts`) walks a checkout, and the platform process has none:
 * TD-021 puts a run's tree on `ws-<run>` inside a run container and the launcher's mirror on
 * `repo-cache`, and neither is mounted here — nor may this process construct a Docker client to
 * reach them (TD-021's WP-15g amendment). So the indexer gets a mirror of its own, cloned and
 * fetched by *this* process, under `APP_KNOWLEDGE_MIRROR_ROOT`, in a directory named by
 * {@link mirrorCacheKeyFor} — the same function the workspace spec uses, so the platform's two
 * mirrors cannot be named two ways.
 *
 * **No working tree is ever created.** Three plumbing commands answer every field of
 * `VaultSnapshot`, and the measurements behind them are in `docs/research/13-bare-mirror-vault-read.md`:
 *
 *  - `git rev-parse refs/heads/<default-branch>` — the commit;
 *  - `git ls-tree -r -l -z <commit>` — `repoPaths` (the paths **tracked at the commit**, which is
 *    what technical/07 step 3's validate-on-read wants, rather than the paths on a disk), plus each
 *    entry's mode, blob sha and size;
 *  - one `git cat-file --batch` process — every document body, framed by the byte length in its
 *    header, with the requests travelling on **stdin** so no path is ever concatenated into a
 *    command line.
 *
 * ## The four rules that travel with it
 *
 * **A fetch that fails is `unavailable`, never a read of the stale copy** (TD-026 decision 4).
 * Reporting `unchanged` from a mirror that failed to advance is the silent failure the port's whole
 * design exists to prevent, so every refusal below returns `{status: 'unavailable', reason}` and the
 * indexer leaves the existing index in place.
 *
 * **An explicit commit must be an ancestor of the default branch** (decision 8, BD-025). The sha
 * reaches the index job from a provider event, so it is untrusted input (BD-022): it is shape-checked
 * before it is an argument, then checked to exist (`cat-file -e`), then checked to be reachable
 * (`merge-base --is-ancestor`). An MR must not be able to change the rules that govern its own
 * review.
 *
 * **Mode `120000` and `160000` are listed and never read** (decision 9). Measured: `cat-file -p` on
 * a symlink entry prints the *link target* — so an adapter that read one would index a document
 * whose body is a path, while the filesystem adapter (whose `entry.isFile()` is false for a symlink)
 * indexes nothing, and the two would disagree about the same repository. A gitlink has no blob at
 * all. Both keep their place in `repoPaths`.
 *
 * **`contentHash` is the git blob sha** (decision 10), which `ls-tree` already carries, so nothing
 * here hashes anything. The port asks only for a digest that changes when the content does; a
 * project whose index was built by the other adapter re-indexes once, and that shows in the report.
 *
 * ## What the fetch is not
 *
 * It is **not an `IntegrationActionExecutor` action** and writes no `integration_actions` row.
 * technical/06 § "Outbound: actions" scopes the executor to *action calls* on a provider port —
 * shadow mode, idempotency and rate limits are about mutations the platform makes to a provider's
 * state — and this is the git transport: no adapter, no API call, nothing changed on the far side,
 * and nothing to replay. It is the same operation the launcher's `updateMirror` performs, which
 * writes no audit row either. What *is* recorded is the index run: `knowledge.index.rebuilt` carries
 * the commit and the counts, and a failure's reason string reaches the `IndexReport` and the log.
 *
 * ## The credential
 *
 * Supplied by the caller per call (Q55's shape) and handed to `git` as a **credential-helper
 * environment**, never inside the URL — the reasoning is at
 * `packages/infrastructure/src/workspace/provider.ts:445-449` and is not repeated. Two consequences
 * this adapter is responsible for: the URL it clones from has no userinfo, so `remote.origin.url` in
 * the mirror's own `config` cannot hold the secret; and the child's environment is an **allow-list**
 * rather than the platform process's own, which carries `APP_SECRET_KEY` and `ANTHROPIC_API_KEY`
 * that `git` has no use for.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  isIndexedVaultPath,
  isPresencePath,
  isProjectPromptPath,
  type Logger,
  MAX_PRESENCE_PATHS,
  MAX_PROJECT_PROMPT_FILE_BYTES,
  MAX_PROJECT_PROMPT_FILES,
  MAX_REPOSITORY_FILE_BYTES,
  PROJECT_PROMPTS_DIR,
  type ProjectPromptReading,
  REPOSITORY_FILE_PATHS,
  type RepositoryFileEntry,
  type RepositoryFilePath,
  type RepositoryFileSource,
  type RepositoryFilesResult,
  silentLogger,
  type VaultDocumentSource,
  type VaultReadRequest,
  type VaultReadResult,
  type VaultSource,
  vaultRelativePath,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { mirrorCacheKeyFor } from '../workspace/spec.js';
import { markMirrorUsed } from './mirror-storage.js';

/**
 * A username and password for `git`'s credential helper.
 *
 * Structurally the integration ring's `GitMirrorCredential`, restated because the two packages are
 * peers under the dependency rule — the same reason `WorkspaceGitCredential` restates
 * `MintedCredential`'s secret half.
 */
export interface GitVaultCredential {
  readonly username: string;
  readonly password: string;
}

/** What the mirror needs to know about one project, resolved per call. */
export interface GitVaultTarget {
  /** `projects.repo_url`. */
  readonly repoUrl: string;
  /** `projects.default_branch` — the only ref this adapter reads (BD-025). */
  readonly defaultBranch: string;
  /**
   * The git binding's credential.
   *
   * **Not nullable, deliberately.** "This project has no git binding" is the `null` *target* below,
   * and "the binding has no usable credential" is a throw from the loader that resolves it — so
   * there is no third spelling here for a credential-less fetch to slip through. An anonymous fetch
   * would work against a public repository and fail against every private one, which is the
   * permissive default standing rule 16 names.
   */
  readonly credential: GitVaultCredential;
}

export interface GitVaultOptions {
  /** `APP_KNOWLEDGE_MIRROR_ROOT`; absolute, and never defaulted (TD-026 decision 5). */
  readonly mirrorRoot: string;
  /**
   * The project's repository, branch and credential — asked **per call**, because the credential is
   * per project and is decrypted by the binding loader (Q55, TD-026 decision 3). `null` means the
   * project has no git binding, which is a refusal rather than an anonymous fetch.
   */
  readonly target: (projectId: Id) => Promise<GitVaultTarget | null>;
  /** The one seam: everything that is not a process launch is testable without spawning git. */
  readonly git?: GitProcessRunner;
  readonly logger?: Logger;
  /**
   * The instant a prepared read stamps on the mirror as its last use (WP-65,
   * `mirror-storage.ts`). Defaults to the wall clock: the stamp is compared with the same clock by
   * the eviction, and nothing else reads it.
   */
  readonly now?: () => Date;
}

// ── The process seam ─────────────────────────────────────────────────────────

export interface GitProcessResult {
  readonly code: number | null;
  /** Bytes, not a string: a blob is arbitrary bytes and `cat-file --batch` frames by byte length. */
  readonly stdout: Buffer;
  readonly stderr: string;
  /** True when {@link GitProcessOptions.maxStdoutBytes} stopped the read. */
  readonly truncated: boolean;
}

export interface GitProcessOptions {
  readonly cwd?: string;
  /** Extra environment on top of {@link gitEnvironment}'s allow-list. */
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
  /** Ceiling on collected stdout; the child is killed when it is passed. */
  readonly maxStdoutBytes: number;
}

export interface GitProcessRunner {
  run(args: readonly string[], options: GitProcessOptions): Promise<GitProcessResult>;
}

/** Longest stderr excerpt a refusal quotes. git is chatty and a reason is read by a human. */
export const MAX_STDERR_CHARS = 2_000;

export const nodeGitProcessRunner: GitProcessRunner = {
  run: (args, options) =>
    new Promise<GitProcessResult>((resolve, reject) => {
      const child = spawn('git', [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: { ...gitEnvironment(), ...(options.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = '';
      let truncated = false;
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return;
        size += chunk.length;
        if (size > options.maxStdoutBytes) {
          truncated = true;
          child.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({
          code,
          stdout: Buffer.concat(chunks),
          stderr: stderr.slice(0, MAX_STDERR_CHARS),
          truncated,
        });
      });
      if (options.input !== undefined) {
        child.stdin.end(options.input);
      } else {
        child.stdin.end();
      }
    }),
};

/**
 * The environment `git` is given — an allow-list, not the platform process's own.
 *
 * Inheriting would put `APP_SECRET_KEY`, `ANTHROPIC_API_KEY` and every integration credential into
 * the environment of a subprocess that has no use for any of them, and a globally configured
 * credential helper is exactly the kind of thing that reads an environment it was not meant to see.
 * A deny-list would be a claim about what an operator's environment contains (standing rule 55), so
 * this names what git needs: a `PATH` to find its own helpers, a `HOME` so the operator's
 * `~/.gitconfig` still applies, the proxy and CA variables a corporate network needs, and a locale.
 *
 * `GIT_TERMINAL_PROMPT=0` is not optional: without it a credential git does not have becomes a
 * prompt on a stdin nobody is attached to, which is an index job that hangs until its lease expires
 * rather than one that fails with a reason.
 */
export const GIT_ENVIRONMENT_PASSTHROUGH: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_SSL_CAINFO',
];

export const gitEnvironment = (
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> => {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  for (const name of GIT_ENVIRONMENT_PASSTHROUGH) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

/**
 * The credential as environment for a helper, exactly as the launcher's `#gitCredentialEnv` builds
 * it (`workspace/provider.ts:445-467`): two variables and a `GIT_CONFIG_*` helper that echoes them.
 * Never in the URL — a URL with a password in it is echoed in git's error messages and written into
 * the mirror's `config` by `clone`.
 */
export const gitCredentialEnvironment = (
  credential: GitVaultCredential,
): Record<string, string> => ({
  GIT_USER: credential.username,
  GIT_PASS: credential.password,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '!f() { echo "username=$GIT_USER"; echo "password=$GIT_PASS"; }; f',
});

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Tree entries the listing may carry before the read is refused.
 *
 * The filesystem adapter's `MAX_WALKED_ENTRIES` for the same reason and at the same number: a
 * partial listing is worse than none, because `repoPaths` is what validate-on-read drops documents
 * against, so a truncated one silently invalidates citations that are perfectly good. Not imported
 * from there because that constant bounds a directory walk and this bounds a tree; they are two
 * measurements of the same repository that happen to agree.
 */
export const MAX_TREE_ENTRIES = 200_000;

/**
 * Total bytes of vault documents one read will buffer.
 *
 * Deliberately an aggregate rather than a per-document cap: a per-document cap would make this
 * adapter refuse a page the filesystem adapter indexes, and TD-026 decision 9 is explicit that the
 * two must not disagree about the same repository. The sum is known **before** anything is read,
 * because `ls-tree -l` carries each blob's size, so the refusal happens without buffering a byte.
 * 64 MiB is four times the largest document `parseKbDocument` can chunk without truncating
 * (`MAX_CHUNK_BYTES × MAX_CHUNKS_PER_DOCUMENT` = 16 MiB), so it bounds the *vault*, never a page.
 */
export const MAX_VAULT_BYTES = 64 * 1_024 * 1_024;

/** Regular blobs. Mode `120000` is a symlink and `160000` a gitlink — listed, never read. */
const READABLE_MODES: readonly string[] = ['100644', '100755'];

// ── Untrusted arguments ──────────────────────────────────────────────────────

/**
 * A commit sha, as it may appear in an argument vector.
 *
 * `VaultReadRequest.commitSha` reaches the index job from a provider event (BD-022). Nothing here
 * is passed through a shell, so this is not about quoting: it is about a value that begins with `-`
 * being read by git as an **option**, and about `ext::…`-shaped revisions. Hex only, and the length
 * range covers both sha-1 and sha-256 repositories.
 */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/;

/**
 * A branch name this adapter will build a ref from.
 *
 * The pattern refuses a leading `-` (an option to git) **by construction**; it does not refuse `..`,
 * because `.` is in the class — `a..b` matches it, and so does `a/../../HEAD`. That is stated rather
 * than implied, and closed by the explicit check in {@link isSafeBranchName} instead of by widening
 * the regex into something nobody can read. Measured for the record: without the explicit check git
 * itself refuses `refs/heads/a/../../HEAD` (`rev-parse` exit 128), so the outcome was already
 * `unavailable` — what the check buys is that the refusal is *ours*, named, and does not depend on a
 * future git accepting a traversal in a ref.
 */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export const isSafeBranchName = (branch: string): boolean =>
  BRANCH_NAME.test(branch) && !branch.includes('..');

/**
 * The mirror's directory name, checked before it is joined to a path.
 *
 * `mirrorCacheKeyFor` is total over any string, so the shape of what comes out of it is a property
 * of its *input* — and the input is an id that reached the job in a payload. It is a uuid today
 * (`idSchema` at the event boundary, then a cast), so this is unreachable; standing rule 55 is about
 * exactly that reasoning, though — a guard is a claim about intent, not about the value a caller
 * happens to pass — and this is the one untrusted-shaped value in the read that becomes a **path**.
 * The pattern is `workspaceRepoSchema`'s, which is what the launcher holds its own cache key to.
 */
const MIRROR_KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * Remote URLs a mirror may be cloned from.
 *
 * An allow-list, because git's remote helpers include `ext::<command>`, which executes it. `file://`
 * is admitted deliberately: a local repository is a legitimate remote, and it is what lets the
 * integration tier fetch from a **real** seeded remote rather than from a double.
 *
 * **It excludes git's scp-style `git@host:acme/api.git`, which this repository supports elsewhere**
 * — `egressHostOfRepoUrl` (`workspace/spec.ts:86-95`) parses it, and `repositoryPathOf`
 * (`apps/server/src/pipeline.ts`) reads a port out of it — so a project whose `repo_url` is written
 * that way indexes to a permanent `vault_unavailable` naming the scheme. That is the **stated**
 * trade rather than an oversight: the form carries no scheme at all, so admitting it means deciding
 * by shape which strings are `ssh` and which are `ext::`-adjacent, and the mirror needs an
 * https-style credential anyway (an scp-style URL is an SSH remote, whose credential is a key this
 * platform does not hold). technical/12 says so where an operator sets the variable; if SSH remotes
 * are ever wanted, the key material is the decision, not this pattern.
 */
const ALLOWED_URL_SCHEME = /^(?:https?|file):\/\/[^\s]+$/i;

// ── Parsing (pure, so the shape is tested without a repository) ───────────────

export interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly objectId: string;
  /** Bytes of the blob; `-` for anything that is not one, reported as 0. */
  readonly size: number;
  readonly path: string;
}

/**
 * `git ls-tree -r -l -z` output: `<mode> SP <type> SP <object> SP<padded size>TAB<path>` per entry,
 * NUL-separated. Recorded from `git version 2.50.1`; the size is right-aligned, which is why the
 * head is split on whitespace rather than on single spaces.
 */
export const parseTreeEntries = (stdout: string): readonly TreeEntry[] => {
  const entries: TreeEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab < 0) {
      throw new Error(
        `ls-tree record has no path separator: ${JSON.stringify(record.slice(0, 80))}`,
      );
    }
    const head = record
      .slice(0, tab)
      .split(/\s+/)
      .filter((part) => part !== '');
    const [mode, type, objectId, size] = head;
    if (mode === undefined || type === undefined || objectId === undefined) {
      throw new Error(`ls-tree record is malformed: ${JSON.stringify(record.slice(0, 80))}`);
    }
    entries.push({
      mode,
      type,
      objectId,
      size: size === undefined || size === '-' ? 0 : Number.parseInt(size, 10),
      path: record.slice(tab + 1),
    });
  }
  return entries;
};

export interface BatchObject {
  readonly objectId: string;
  readonly content: Buffer;
}

/**
 * `git cat-file --batch` output: `<sha> SP <type> SP <size>\n<size bytes>\n` per request, or
 * `<request> SP missing\n` when the object is not there.
 *
 * Framed on the declared byte length rather than on a delimiter, because a blob may contain
 * anything — including the `\n` a line reader would stop at. A `missing` line throws: the caller
 * asked for shas it had just read out of the same tree, so one that is absent means the mirror
 * changed under the read, and half a vault is worse than none.
 */
export const parseCatFileBatch = (stdout: Buffer): readonly BatchObject[] => {
  const objects: BatchObject[] = [];
  let offset = 0;
  while (offset < stdout.length) {
    const newline = stdout.indexOf(0x0a, offset);
    if (newline < 0) {
      throw new Error('cat-file --batch ended inside a header');
    }
    const header = stdout.toString('utf8', offset, newline);
    const parts = header.split(' ');
    if (parts.length < 3) {
      throw new Error(
        `cat-file --batch refused an object: ${JSON.stringify(header.slice(0, 120))}`,
      );
    }
    const [objectId, , rawSize] = parts;
    const size = Number.parseInt(rawSize ?? '', 10);
    if (objectId === undefined || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(
        `cat-file --batch header is malformed: ${JSON.stringify(header.slice(0, 120))}`,
      );
    }
    const start = newline + 1;
    const end = start + size;
    if (end > stdout.length) {
      throw new Error(`cat-file --batch body is short for ${objectId}`);
    }
    objects.push({ objectId, content: stdout.subarray(start, end) });
    // The trailing newline git writes after each body.
    offset = end + 1;
  }
  return objects;
};

// ── The adapter ──────────────────────────────────────────────────────────────

const unavailable = (
  reason: string,
): { readonly status: 'unavailable'; readonly reason: string } => ({
  status: 'unavailable',
  reason,
});

const failureDetail = (result: GitProcessResult): string => {
  const stderr = result.stderr.trim().replaceAll('\n', ' ');
  return stderr === '' ? `exit ${String(result.code)}` : `exit ${String(result.code)}: ${stderr}`;
};

const directoryExists = async (target: string): Promise<boolean> => {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
};

/** A process that runs `git` inside the project's mirror, without the credential. */
type MirrorRunner = (
  args: readonly string[],
  extra?: { readonly input?: string; readonly maxStdoutBytes?: number },
) => Promise<GitProcessResult>;

type PreparedMirror =
  | { readonly status: 'unavailable'; readonly reason: string }
  | {
      readonly status: 'ok';
      /** The commit to read: the pinned one, or the default branch's head. */
      readonly commit: string;
      readonly refreshed: boolean;
      readonly inMirror: MirrorRunner;
      /** `refs/heads/<projects.default_branch>` — the branch this read was made from (WP-147). */
      readonly ref: string;
    };

/**
 * Everything a read of the default branch shares, whichever paths it then reads: the checks on the
 * untrusted inputs, the clone or the fetch (with the credential, and only for those two commands),
 * the default-branch head and the ancestry rule for a pinned commit.
 *
 * Factored out at WP-63, when a second reader of the same mirror arrived
 * ({@link createGitRepositoryFileSource}); two copies of "which commit may be read" would be one
 * copy that drifts (standing rule 41). The vault read below is unchanged in what it does.
 */
/**
 * **One refresh of a mirror at a time, per process** (WP-138 review round 1, measured).
 *
 * Every reader composed over the same `APP_KNOWLEDGE_MIRROR_ROOT` — the knowledge index, the
 * configuration reading, the readiness re-check and, since WP-138, the CI gate and the merge
 * request's pipeline duty (`mr_ready` then, `mr_pipeline` since backlog 486) asking whether the default branch has a `.gitlab-ci.yml` — prepares its read with a
 * `git remote update` into the same bare mirror, and they are separate instances of this adapter.
 * Two refreshes of one mirror at once lose a ref race: *"cannot lock ref 'refs/heads/main': is at
 * … but expected …"* (measured in `readiness-loop.e2e.test.ts`, where the `mr_ready` duty's read
 * landed beside the after-merge index run and the index run reported `vault_unavailable`). So the
 * refresh — the set-url and the update, or the clone — is serialised **per mirror directory** in a
 * module-level map, which every instance in the process shares; the reads after it are not.
 *
 * **What it does not cover, stated**: two *processes* sharing the volume (`app` and `runner`) can
 * still race the same way; the failing read is then `unavailable` for that run and the next
 * trigger reads again. That residual predates WP-138.
 */
const refreshes = new Map<string, Promise<unknown>>();

export const serialisedPerMirror = async <T>(mirror: string, fn: () => Promise<T>): Promise<T> => {
  const before = refreshes.get(mirror) ?? Promise.resolve();
  const turn = before.then(fn, fn);
  const settled = turn.then(
    () => undefined,
    () => undefined,
  );
  refreshes.set(mirror, settled);
  try {
    return await turn;
  } finally {
    if (refreshes.get(mirror) === settled) {
      refreshes.delete(mirror);
    }
  }
};

const prepareMirrorRead = async (
  options: GitVaultOptions,
  git: GitProcessRunner,
  request: { readonly projectId: Id; readonly commitSha?: string },
): Promise<PreparedMirror> => {
  if (request.commitSha !== undefined && !COMMIT_SHA.test(request.commitSha)) {
    return unavailable(
      `the requested commit is not a commit sha; it reached the index job from a provider event and is not used as an argument (BD-022)`,
    );
  }
  if (!path.isAbsolute(options.mirrorRoot)) {
    return unavailable(
      `APP_KNOWLEDGE_MIRROR_ROOT ${JSON.stringify(options.mirrorRoot)} is not an absolute path`,
    );
  }
  if (!(await directoryExists(options.mirrorRoot))) {
    // Not created here: a root that does not exist is a misconfigured volume, and silently
    // making one would put every project's mirror somewhere nobody is looking (rule 18).
    return unavailable(
      `APP_KNOWLEDGE_MIRROR_ROOT ${JSON.stringify(options.mirrorRoot)} is not a directory on this process' filesystem; the knowledge mirror needs a writable data volume`,
    );
  }

  let target: GitVaultTarget | null;
  try {
    target = await options.target(request.projectId);
  } catch (cause) {
    return unavailable(`the project's git binding could not be read: ${(cause as Error).message}`);
  }
  if (target === null) {
    return unavailable(
      'the project has no git binding, so there is no repository to mirror; the knowledge index is left alone',
    );
  }
  if (!ALLOWED_URL_SCHEME.test(target.repoUrl)) {
    return unavailable(
      `projects.repo_url ${JSON.stringify(target.repoUrl)} is not an http(s) or file URL; git remote helpers such as "ext::" run commands, so the scheme is an allow-list, and git's scp-style "git@host:path" form is outside it (see the pattern's docblock)`,
    );
  }
  if (!isSafeBranchName(target.defaultBranch)) {
    return unavailable(
      `projects.default_branch ${JSON.stringify(target.defaultBranch)} is not a branch name this adapter will build a ref from`,
    );
  }

  const mirrorKey = mirrorCacheKeyFor(request.projectId);
  if (!MIRROR_KEY.test(mirrorKey)) {
    return unavailable(
      `the mirror directory name derived from project ${JSON.stringify(request.projectId)} is not a plain directory name; it is not joined to a path`,
    );
  }

  const ref = `refs/heads/${target.defaultBranch}`;
  const mirror = path.join(options.mirrorRoot, mirrorKey);
  const credential = target.credential;
  const repoUrl = target.repoUrl;

  /**
   * The credential goes to the **two network commands only**, not to every child.
   *
   * `rev-parse`, `ls-tree`, `cat-file` and `merge-base` are local object-database reads: they
   * open no connection, so a credential in their environment is a secret in four more process
   * environments for nothing (least privilege, and the same reasoning `RunSpec.secretEnvNames`
   * is written to). It also keeps the tests honest — an assertion that "the password really is
   * supplied" can only be satisfied here by a command that would actually send it.
   */
  const run = (
    args: readonly string[],
    extra: {
      readonly cwd?: string;
      readonly input?: string;
      readonly maxStdoutBytes?: number;
      readonly withCredential?: boolean;
    } = {},
  ): Promise<GitProcessResult> =>
    git.run(args, {
      env: extra.withCredential === true ? gitCredentialEnvironment(credential) : {},
      maxStdoutBytes: extra.maxStdoutBytes ?? MAX_VAULT_BYTES,
      ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
      ...(extra.input === undefined ? {} : { input: extra.input }),
    });

  const inMirror = (args: readonly string[], extra: Parameters<typeof run>[1] = {}) =>
    run(['-C', mirror, ...args], extra);

  const present = await directoryExists(mirror);

  /**
   * The mirror's **last use** (WP-65, Q63): eviction under `APP_KNOWLEDGE_MIRROR_MAX_BYTES` removes
   * the least recently used mirror first, and this is what "used" means — a read the adapter is
   * preparing, pinned or not, refreshed or not. It is stamped **twice** (review round 1): here,
   * before any git work, because a fetch into a mirror the stamp still called idle was exactly
   * what another process (`app` and `runner` share the volume) could `rm -r` mid-fetch; and again
   * once the read is prepared, so a fresh clone — which cannot be stamped before it exists, since
   * `git clone` refuses a non-empty target — carries one too. A stamp that cannot be written costs
   * the eviction order its accuracy for this mirror and nothing else, so the read goes on and the
   * failure is named.
   */
  const stamp = async (): Promise<void> => {
    try {
      await markMirrorUsed(mirror, (options.now ?? (() => new Date()))());
    } catch (cause) {
      (options.logger ?? silentLogger).warn(
        { project_id: request.projectId, err: cause },
        'knowledge mirror: the last-use stamp could not be written; eviction by last use will read this mirror as older than it is',
      );
    }
  };
  if (present) {
    await stamp();
  }

  /**
   * Skip the fetch only when the pinned commit is already **on the default branch** here.
   *
   * TD-026 says "skipped when the requested commit is already present"; present is not
   * enough on its own, because a sha can be in the mirror as an MR head while the branch has
   * not moved — and answering `unavailable` for a merge commit the remote already has would
   * turn the after-merge trigger into a refusal.
   */
  let refreshed = false;
  return serialisedPerMirror(mirror, async () => {
    // Asked again inside the turn: a read that waited may find the clone the one before it made.
    const present = await directoryExists(mirror);
    const pinnedIsReady =
      present &&
      request.commitSha !== undefined &&
      (await inMirror(['cat-file', '-e', `${request.commitSha}^{commit}`])).code === 0 &&
      (await inMirror(['merge-base', '--is-ancestor', request.commitSha, ref])).code === 0;

    if (!pinnedIsReady) {
      if (present) {
        const url = await inMirror(['remote', 'set-url', 'origin', repoUrl]);
        if (url.code !== 0) {
          return unavailable(`the mirror's remote could not be set: ${failureDetail(url)}`);
        }
        const update = await inMirror(['remote', 'update', '--prune'], {
          withCredential: true,
        });
        if (update.code !== 0) {
          return unavailable(`the mirror could not be refreshed: ${failureDetail(update)}`);
        }
      } else {
        /**
         * The mirror is created here (Q63).
         *
         * One bare clone per project appears on that project's first index run, on the operator's
         * data volume. Since WP-65 it is **measured** — `platform_storage_bytes{component=
         * "knowledge_mirrors"}` and `knowledge_mirror_bytes{project_id}` (`mirror-storage.ts`) — and
         * it is removed only under an operator-declared ceiling (`APP_KNOWLEDGE_MIRROR_MAX_BYTES`,
         * unset by default, so **by default nothing removes it**), least recently used first and never
         * within an hour of a read: BD-012 makes it a derived cache that is safe to delete, and Q63's
         * recommendation is explicitly to *not* evict an active project's mirror at the worst moment.
         * The residual on a stock instance is therefore disk growth proportional to the sum of the
         * customers' repositories — now on a gauge rather than invisible.
         */
        const clone = await run(['clone', '--mirror', '--', repoUrl, mirror], {
          withCredential: true,
        });
        if (clone.code !== 0) {
          return unavailable(`the mirror could not be cloned: ${failureDetail(clone)}`);
        }
      }
      refreshed = true;
    }

    const head = await inMirror(['rev-parse', '--verify', '--end-of-options', ref]);
    if (head.code !== 0) {
      return unavailable(
        `the mirror has no ${ref}; the project's default branch is what the knowledge base is read from (BD-025): ${failureDetail(head)}`,
      );
    }
    const headSha = head.stdout.toString('utf8').trim();

    let commit = headSha;
    if (request.commitSha !== undefined) {
      const exists = await inMirror(['cat-file', '-e', `${request.commitSha}^{commit}`]);
      if (exists.code !== 0) {
        return unavailable(
          `commit ${request.commitSha} is not in the mirror after a fetch; it is not read (BD-022)`,
        );
      }
      const ancestor = await inMirror(['merge-base', '--is-ancestor', request.commitSha, ref]);
      if (ancestor.code !== 0) {
        return unavailable(
          `commit ${request.commitSha} is not an ancestor of ${ref}; the knowledge base is read from the default branch only (BD-025)`,
        );
      }
      commit = request.commitSha;
    }
    // The second stamp (see `stamp` above): the one a fresh clone gets.
    await stamp();
    return { status: 'ok', commit, refreshed, inMirror, ref } as const;
  });
};

export const createGitVaultSource = (options: GitVaultOptions): VaultSource => {
  const git = options.git ?? nodeGitProcessRunner;
  const logger = options.logger ?? silentLogger;

  return {
    read: async (request: VaultReadRequest): Promise<VaultReadResult> => {
      try {
        const prepared = await prepareMirrorRead(options, git, request);
        if (prepared.status === 'unavailable') {
          return prepared;
        }
        const { commit, refreshed, inMirror } = prepared;

        const tree = await inMirror(['ls-tree', '-r', '-l', '-z', '--full-tree', commit]);
        if (tree.code !== 0) {
          return unavailable(`the tree at ${commit} could not be listed: ${failureDetail(tree)}`);
        }
        if (tree.truncated) {
          return unavailable(
            `the tree listing at ${commit} exceeded ${MAX_VAULT_BYTES} bytes; refusing a partial listing`,
          );
        }
        const entries = parseTreeEntries(tree.stdout.toString('utf8'));
        if (entries.length > MAX_TREE_ENTRIES) {
          return unavailable(
            `the repository has more than ${MAX_TREE_ENTRIES} tracked paths; refusing a partial listing`,
          );
        }

        const wanted = entries.filter(
          (entry) =>
            READABLE_MODES.includes(entry.mode) &&
            isIndexedVaultPath(entry.path, request.knowledgeDir),
        );
        const bytes = wanted.reduce((total, entry) => total + entry.size, 0);
        if (bytes > MAX_VAULT_BYTES) {
          return unavailable(
            `the vault at ${commit} is ${bytes} bytes across ${wanted.length} documents, over the ${MAX_VAULT_BYTES}-byte ceiling`,
          );
        }

        const documents: VaultDocumentSource[] = [];
        if (wanted.length > 0) {
          const batch = await inMirror(['cat-file', '--batch'], {
            input: `${wanted.map((entry) => entry.objectId).join('\n')}\n`,
          });
          if (batch.code !== 0 || batch.truncated) {
            return unavailable(
              `the vault's documents could not be read: ${batch.truncated ? 'output exceeded the vault ceiling' : failureDetail(batch)}`,
            );
          }
          const objects = parseCatFileBatch(batch.stdout);
          if (objects.length !== wanted.length) {
            return unavailable(
              `asked for ${wanted.length} documents and git answered ${objects.length}; the mirror changed under the read`,
            );
          }
          for (const [index, entry] of wanted.entries()) {
            const object = objects[index];
            if (object === undefined || object.objectId !== entry.objectId) {
              return unavailable(
                `git answered for ${String(object?.objectId)} where ${entry.path} was asked for; the mirror changed under the read`,
              );
            }
            documents.push({
              path: entry.path,
              vaultRelativePath: vaultRelativePath(entry.path, request.knowledgeDir),
              source: object.content.toString('utf8'),
              // TD-026 decision 10: the blob sha, which `ls-tree` already carried.
              contentHash: entry.objectId,
            });
          }
        }

        logger.debug(
          {
            project_id: request.projectId,
            commit_sha: commit,
            refreshed,
            paths: entries.length,
            documents: documents.length,
          },
          'knowledge vault read from the platform mirror',
        );

        return {
          status: 'ok',
          snapshot: {
            commitSha: commit,
            documents,
            repoPaths: entries.map((entry) => entry.path).sort(),
          },
        };
      } catch (cause) {
        // A spawn that never started (no `git` on PATH), or a parse that refused its input. Both
        // are `unavailable`: the index stays as it was.
        return unavailable(`the knowledge mirror could not be read: ${(cause as Error).message}`);
      }
    },
  };
};

/**
 * Is `git` on this process' PATH, and which one?
 *
 * TD-026 makes the binary a dependency of the platform process, so the composition root probes and
 * **names it** when it is absent rather than letting the first index run fail with `ENOENT` (rule
 * 18, and the shape `createCtagsSymbolExtractor` already uses for universal-ctags).
 */
export const probeGit = async (
  runner: GitProcessRunner = nodeGitProcessRunner,
): Promise<{ readonly available: boolean; readonly detail: string }> => {
  try {
    const result = await runner.run(['--version'], { maxStdoutBytes: 4_096 });
    const banner = result.stdout.toString('utf8').trim();
    return result.code === 0
      ? { available: true, detail: banner }
      : { available: false, detail: `git --version ${failureDetail(result)}` };
  } catch (cause) {
    return { available: false, detail: `git could not be started: ${(cause as Error).message}` };
  }
};

/**
 * The `VaultSource` a process composes when it cannot build a real one — TD-026 decision 5.
 *
 * A **refusal**, not an empty vault: `read` answers `unavailable` with the piece that is missing, so
 * the index job reports `vault_unavailable`, names the variable, and the indexer leaves an existing
 * index exactly where it was. The same shape `unavailableClaudeRunner` uses in `apps/server`, and
 * for the same reason — "nothing is configured" and "the vault is empty" must not be spelled alike
 * (standing rules 18 and 31).
 */
export const unavailableVaultSource = (reason: string): VaultSource => ({
  read: async (): Promise<VaultReadResult> => ({ status: 'unavailable', reason }),
});

/**
 * `RepositoryFileSource` over the same mirror — **the widening of this adapter**, stated (WP-63).
 *
 * The vault read above answers the four indexed kinds of path and nothing else; this answers the
 * paths `REPOSITORY_FILE_PATHS` names — `.agentic/config.yml`, `CLAUDE.md`, (WP-64) `AGENTS.md` and
 * (WP-94) the twenty-six exact paths the readiness re-check reads R10 and R13 from — and **refuses any
 * other path it is handed**, so the allow-list is enforced where the bytes are read and not only in
 * the type. The batch's output bound grows with the paths asked (`MAX_REPOSITORY_FILE_BYTES` each),
 * so a re-check's read is bounded at 29 files of 64 KiB. **WP-92 widens it by one named directory**: with `promptDirectory`, it also lists
 * `.agentic/prompts/` in the same `ls-tree` and reads the direct children `isProjectPromptPath`
 * accepts (`<name>.md`, marker alphabet, no subdirectory) — the first `MAX_PROJECT_PROMPT_FILES` by
 * path, each under `MAX_PROJECT_PROMPT_FILE_BYTES` — through the same `cat-file --batch`. A symlink or
 * a submodule there is `not_a_file` and never followed, exactly as at the named paths. Everything that decides *which commit* is shared with the vault read
 * ({@link prepareMirrorRead}): the same fetch with the same credential, the default branch only
 * (BD-025 §1), and a pinned commit only when it is an ancestor of it.
 *
 * Each path is listed with `ls-tree -r -l` first, so its mode and size are known before a byte is
 * read: a symlink, a submodule or a directory at the path is `not_a_file` and is never followed
 * (TD-026 decision 9), and a blob over `MAX_REPOSITORY_FILE_BYTES` is `oversized` and never
 * buffered. The bodies travel through one `cat-file --batch`, requested on stdin, as the vault's do.
 *
 * **One listing, one cap** (WP-92 review): the prompt directory is listed in the same `ls-tree` as
 * `.agentic/config.yml`, under the same output cap, so a prompt directory with enough entries to
 * overflow it makes the **whole** reading `unavailable` — the configuration file is then not read
 * either. Only someone with merge rights can cause it; the reading fails closed, stated here.
 */
export const createGitRepositoryFileSource = (options: GitVaultOptions): RepositoryFileSource => {
  const git = options.git ?? nodeGitProcessRunner;
  const logger = options.logger ?? silentLogger;
  const permitted: readonly string[] = REPOSITORY_FILE_PATHS;

  return {
    read: async (request): Promise<RepositoryFilesResult> => {
      const refused = request.paths.filter((entry) => !permitted.includes(entry));
      const presence = request.presence ?? [];
      // WP-143: the one provider-named path whose bytes are read — the CI file, for its rules.
      const ciConfigPath = request.ciConfigPath;
      if (ciConfigPath !== undefined && !isPresencePath(ciConfigPath)) {
        return unavailable(
          `this reader reads a CI configuration only at a repository-relative path; ${JSON.stringify(ciConfigPath.slice(0, 80))} is not one`,
        );
      }
      if (
        refused.length > 0 ||
        (request.paths.length === 0 && presence.length === 0 && ciConfigPath === undefined)
      ) {
        return unavailable(
          `this reader answers the ${permitted.length} exact paths REPOSITORY_FILE_PATHS names and nothing else; ${JSON.stringify(refused)} is outside what the platform reads from a repository`,
        );
      }
      // WP-139: presence only, bounded and shaped before it reaches an argument vector.
      const badPresence = presence.filter((entry) => !isPresencePath(entry));
      if (presence.length > MAX_PRESENCE_PATHS || badPresence.length > 0) {
        return unavailable(
          `this reader answers the presence of at most ${MAX_PRESENCE_PATHS} repository-relative paths; ${JSON.stringify(badPresence.map((entry) => entry.slice(0, 80)))} is not one`,
        );
      }
      try {
        const prepared = await prepareMirrorRead(options, git, request);
        if (prepared.status === 'unavailable') {
          return prepared;
        }
        const { commit, inMirror, ref } = prepared;
        const listing = await inMirror(
          [
            'ls-tree',
            '-r',
            '-l',
            '-z',
            '--full-tree',
            commit,
            '--',
            ...request.paths,
            ...presence,
            ...(ciConfigPath === undefined ? [] : [ciConfigPath]),
            ...(request.promptDirectory === true ? [PROJECT_PROMPTS_DIR] : []),
          ],
          { maxStdoutBytes: 1_024 * 1_024 },
        );
        if (listing.code !== 0 || listing.truncated) {
          return unavailable(
            `the paths at ${commit} could not be listed: ${listing.truncated ? 'the listing exceeded its bound' : failureDetail(listing)}`,
          );
        }
        const entries = parseTreeEntries(listing.stdout.toString('utf8'));
        const files: Partial<Record<RepositoryFilePath, RepositoryFileEntry>> = {};
        /** `path` is a `RepositoryFilePath`, or the CI path when `ci` (WP-143). */
        const wanted: { readonly path: string; readonly entry: TreeEntry; readonly ci?: true }[] =
          [];
        let ciConfig: RepositoryFileEntry | undefined;
        const classify = (wantedPath: string): RepositoryFileEntry | TreeEntry => {
          const exact = entries.find((entry) => entry.path === wantedPath);
          if (exact === undefined) {
            // A directory at the path lists its children under `-r`; it is not a file either.
            const nested = entries.some((entry) => entry.path.startsWith(`${wantedPath}/`));
            return nested ? { kind: 'not_a_file', mode: '040000' } : { kind: 'absent' };
          }
          if (exact.type !== 'blob' || !READABLE_MODES.includes(exact.mode)) {
            return { kind: 'not_a_file', mode: exact.mode };
          }
          if (exact.size > MAX_REPOSITORY_FILE_BYTES) {
            return { kind: 'oversized', bytes: exact.size };
          }
          return exact;
        };
        for (const wantedPath of request.paths) {
          const found = classify(wantedPath);
          if ('kind' in found) files[wantedPath] = found;
          else wanted.push({ path: wantedPath, entry: found });
        }
        if (ciConfigPath !== undefined) {
          const found = classify(ciConfigPath);
          if ('kind' in found) ciConfig = found;
          else wanted.push({ path: ciConfigPath, entry: found, ci: true });
        }
        const prompts =
          request.promptDirectory === true ? promptDirectoryListing(entries) : undefined;
        const promptBlobs = prompts?.wanted ?? [];
        if (wanted.length > 0 || promptBlobs.length > 0) {
          const batch = await inMirror(['cat-file', '--batch'], {
            input: `${[...wanted, ...promptBlobs].map(({ entry }) => entry.objectId).join('\n')}\n`,
            maxStdoutBytes:
              wanted.length * (MAX_REPOSITORY_FILE_BYTES + 256) +
              promptBlobs.length * (MAX_PROJECT_PROMPT_FILE_BYTES + 256),
          });
          if (batch.code !== 0 || batch.truncated) {
            return unavailable(
              `the repository files could not be read: ${batch.truncated ? 'output exceeded the bound' : failureDetail(batch)}`,
            );
          }
          const objects = parseCatFileBatch(batch.stdout);
          for (const [index, { path: wantedPath, entry, ci }] of wanted.entries()) {
            const object = objects[index];
            if (object === undefined || object.objectId !== entry.objectId) {
              return unavailable(
                `git answered for ${String(object?.objectId)} where ${wantedPath} was asked for; the mirror changed under the read`,
              );
            }
            const read: RepositoryFileEntry = {
              kind: 'file',
              text: object.content.toString('utf8'),
              blobSha: entry.objectId,
            };
            if (ci === true) ciConfig = read;
            else files[wantedPath as RepositoryFilePath] = read;
          }
          for (const [offset, { path: promptPath, entry }] of promptBlobs.entries()) {
            const object = objects[wanted.length + offset];
            if (object === undefined || object.objectId !== entry.objectId) {
              return unavailable(
                `git answered for ${String(object?.objectId)} where ${promptPath} was asked for; the mirror changed under the read`,
              );
            }
            prompts?.files.set(promptPath, {
              kind: 'file',
              text: object.content.toString('utf8'),
              blobSha: entry.objectId,
            });
          }
        }
        logger.debug(
          { project_id: request.projectId, commit_sha: commit, paths: request.paths },
          'repository files read from the platform mirror',
        );
        // WP-63 review round 1: is this commit strictly older than the reading already recorded?
        // Only a *strict ancestor* is older: a recorded commit this mirror no longer has (a
        // force-pushed default branch) answers "not an ancestor", so the new reading is recorded.
        // WP-147 (backlog 442): and only a recorded commit **on the branch read now** is newer —
        // a reading of the previous default branch (`develop`, whose head `main` is often an
        // ancestor of) is not a newer reading of `main`, so a change of the default branch is
        // never answered with the old branch's configuration.
        const recorded = request.recordedCommit;
        const behindRecorded =
          recorded !== undefined &&
          COMMIT_SHA.test(recorded) &&
          recorded !== commit &&
          (await inMirror(['merge-base', '--is-ancestor', recorded, ref])).code === 0 &&
          (await inMirror(['merge-base', '--is-ancestor', commit, recorded])).code === 0;
        return {
          status: 'ok',
          commitSha: commit,
          files,
          behindRecorded,
          ...(prompts === undefined ? {} : { prompts: promptReadingOf(prompts) }),
          ...(ciConfig === undefined ? {} : { ciConfig }),
          ...(presence.length === 0
            ? {}
            : {
                presence: Object.fromEntries(
                  presence.map((wantedPath) => [
                    wantedPath,
                    entries.some(
                      (entry) =>
                        entry.path === wantedPath || entry.path.startsWith(`${wantedPath}/`),
                    )
                      ? ('present' as const)
                      : ('absent' as const),
                  ]),
                ),
              }),
        };
      } catch (cause) {
        return unavailable(`the repository files could not be read: ${(cause as Error).message}`);
      }
    },
  };
};

/** The prompt directory's listing, before its bodies are read. */
interface PromptDirectoryListing {
  /** Path → entry, in path order; a readable file is filled in after the batch. */
  readonly files: Map<string, RepositoryFileEntry>;
  readonly wanted: readonly { readonly path: string; readonly entry: TreeEntry }[];
  readonly truncated: boolean;
}

/**
 * Which of a recursive listing's entries are prompt files (WP-92): direct children of
 * `.agentic/prompts/` with an accepted name, the first `MAX_PROJECT_PROMPT_FILES` by path. A symlink,
 * a submodule or anything but a regular blob is `not_a_file`; a blob over the bound is `oversized`
 * and is never buffered — the same three answers the named paths get.
 */
const promptDirectoryListing = (entries: readonly TreeEntry[]): PromptDirectoryListing => {
  const candidates = entries
    .filter((entry) => isProjectPromptPath(entry.path))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const files = new Map<string, RepositoryFileEntry>();
  const wanted: { path: string; entry: TreeEntry }[] = [];
  for (const entry of candidates.slice(0, MAX_PROJECT_PROMPT_FILES)) {
    if (entry.type !== 'blob' || !READABLE_MODES.includes(entry.mode)) {
      files.set(entry.path, { kind: 'not_a_file', mode: entry.mode });
    } else if (entry.size > MAX_PROJECT_PROMPT_FILE_BYTES) {
      files.set(entry.path, { kind: 'oversized', bytes: entry.size });
    } else {
      // A placeholder the batch replaces; a read that fails returns `unavailable` before this
      // listing is ever published, so no placeholder survives.
      files.set(entry.path, { kind: 'absent' });
      wanted.push({ path: entry.path, entry });
    }
  }
  return { files, wanted, truncated: candidates.length > MAX_PROJECT_PROMPT_FILES };
};

const promptReadingOf = (listing: PromptDirectoryListing): ProjectPromptReading => ({
  files: Object.fromEntries(listing.files),
  truncated: listing.truncated,
});

/** The file reader's refusal for a process that composed no mirror — named, like the vault's. */
export const unavailableRepositoryFileSource = (reason: string): RepositoryFileSource => ({
  read: async (): Promise<RepositoryFilesResult> => ({ status: 'unavailable', reason }),
});
