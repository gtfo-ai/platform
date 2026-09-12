/**
 * The git vault adapter, driven against **real git repositories in a temp directory**.
 *
 * Real git for the reason `filesystem-vault.test.ts` uses real files, one turn sharper: the whole
 * question this adapter answers is *what git prints*, and the three things it has to get right —
 * the tree listing's modes and sizes, `cat-file --batch`'s byte framing, and the ancestry guard's
 * exit status — are properties of the program, not of our parser. A stubbed runner would test the
 * stub (standing rule 82).
 *
 * The seeded "remote" is another repository on disk, cloned over `file://`. That is a **real fetch
 * over the git transport** — `git clone --mirror` and `git remote update --prune` take the same code
 * path they take against an https remote — with no network in a unit tier.
 *
 * What this tier cannot show, and the integration tier does: that an index run over the snapshot
 * writes the right rows and leaves the wrong ones alone.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { VaultReadResult } from '@platform/application';
import type { Id } from '@platform/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGitVaultSource,
  type GitProcessOptions,
  type GitProcessResult,
  type GitProcessRunner,
  type GitVaultTarget,
  gitEnvironment,
  nodeGitProcessRunner,
  parseCatFileBatch,
  parseTreeEntries,
  probeGit,
  unavailableVaultSource,
} from './git-vault.js';

const execFileAsync = promisify(execFile);

const PROJECT = '00000000-0000-4000-8000-0000000000e1';
const KNOWLEDGE_DIR = '.agentic/knowledge';
const CREDENTIAL = { username: 'oauth2', password: 'glpat-FAKE-not-a-real-token-000000' };

let root: string;
let origin: string;
let mirrorRoot: string;
/** A file outside the repository, with a marker in it, that a symlink entry points at. */
let secretFile: string;
const SECRET_MARKER = 'MARKER-THE-SYMLINK-TARGET-MUST-NOT-BE-READ';

const git = async (args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', [...args], {
    env: { ...gitEnvironment(), GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z' },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
};

const commit = (repo: string, message: string): Promise<string> =>
  git([
    '-C',
    repo,
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'user.name=Fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
  ]);

const write = async (repo: string, relative: string, body: string): Promise<void> => {
  const absolute = path.join(repo, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, body, 'utf8');
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'git-vault-'));
  origin = path.join(root, 'origin');
  mirrorRoot = path.join(root, 'mirrors');
  secretFile = path.join(root, 'secret-target.txt');
  await mkdir(mirrorRoot, { recursive: true });
  await writeFile(secretFile, `${SECRET_MARKER}\n`, 'utf8');

  await git(['init', '-q', '-b', 'main', origin]);
  await write(origin, 'CLAUDE.md', '# Claude\n');
  await write(origin, 'AGENTS.md', '# Agents\n');
  await write(origin, `${KNOWLEDGE_DIR}/index.md`, '# Index\n');
  await write(origin, `${KNOWLEDGE_DIR}/lessons/L-1.md`, '---\nid: L-1\n---\n# Lesson\n');
  await write(origin, '.agentic/rules/r1.md', '---\nid: R-1\n---\n# Rule\n');
  await write(origin, 'src/app.ts', 'export const x = 1;\n');
  await symlink(secretFile, path.join(origin, KNOWLEDGE_DIR, 'evil.md'));
  await git(['-C', origin, 'add', '-A']);
  // A gitlink with no submodule behind it: the tree entry is the whole point, and a real submodule
  // would add a second repository to the fixture for nothing.
  await git([
    '-C',
    origin,
    'update-index',
    '--add',
    '--cacheinfo',
    '160000,0000000000000000000000000000000000000001,vendor/sub',
  ]);
  await commit(origin, 'the vault');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const target = (overrides: Partial<GitVaultTarget> = {}): GitVaultTarget => ({
  repoUrl: `file://${origin}`,
  defaultBranch: 'main',
  credential: CREDENTIAL,
  ...overrides,
});

const read = (
  options: {
    readonly commitSha?: string;
    readonly target?: GitVaultTarget | null;
    readonly git?: GitProcessRunner;
    readonly mirrorRoot?: string;
    readonly targetThrows?: Error;
  } = {},
): Promise<VaultReadResult> =>
  createGitVaultSource({
    mirrorRoot: options.mirrorRoot ?? mirrorRoot,
    ...(options.git === undefined ? {} : { git: options.git }),
    target: async () => {
      if (options.targetThrows !== undefined) throw options.targetThrows;
      return options.target === undefined ? target() : options.target;
    },
  }).read({
    projectId: PROJECT,
    knowledgeDir: KNOWLEDGE_DIR,
    ...(options.commitSha === undefined ? {} : { commitSha: options.commitSha }),
  });

const expectOk = (result: VaultReadResult) => {
  if (result.status !== 'ok') throw new Error(`expected ok, got: ${result.reason}`);
  return result.snapshot;
};

const expectUnavailable = (result: VaultReadResult): string => {
  if (result.status !== 'unavailable') throw new Error('expected unavailable');
  return result.reason;
};

/** Records every argument vector and environment git was given, then really runs it. */
const recordingRunner = (): GitProcessRunner & {
  readonly calls: { args: readonly string[]; env: Readonly<Record<string, string>> }[];
} => {
  const calls: { args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  return {
    calls,
    run: (args: readonly string[], options: GitProcessOptions): Promise<GitProcessResult> => {
      calls.push({ args, env: options.env ?? {} });
      return nodeGitProcessRunner.run(args, options);
    },
  };
};

describe('createGitVaultSource', () => {
  it('reads the four indexed path classes from a mirror with no working tree', async () => {
    const snapshot = expectOk(await read());
    expect(snapshot.documents.map((document) => document.path).sort()).toEqual([
      '.agentic/knowledge/index.md',
      '.agentic/knowledge/lessons/L-1.md',
      '.agentic/rules/r1.md',
      'AGENTS.md',
      'CLAUDE.md',
    ]);

    // The mirror is bare: nothing in it is a checkout of the fixture.
    const mirror = path.join(mirrorRoot, `p${PROJECT.replaceAll('-', '')}`);
    expect(await git(['-C', mirror, 'rev-parse', '--is-bare-repository'])).toBe('true');
    await expect(readFile(path.join(mirror, 'CLAUDE.md'), 'utf8')).rejects.toThrow();
  });

  it('maps rules onto the rules layer and keeps CLAUDE.md at the root', async () => {
    const snapshot = expectOk(await read());
    const relative = new Map(
      snapshot.documents.map((document) => [document.path, document.vaultRelativePath]),
    );
    expect(relative.get('.agentic/rules/r1.md')).toBe('rules/r1.md');
    expect(relative.get('CLAUDE.md')).toBe('CLAUDE.md');
    expect(relative.get(`${KNOWLEDGE_DIR}/lessons/L-1.md`)).toBe('lessons/L-1.md');
  });

  it('answers repoPaths with the tree at the commit, not a walk of a directory', async () => {
    // Present in the commit, absent from any directory this process can see.
    await write(origin, 'uncommitted.md', '# never committed\n');
    const snapshot = expectOk(await read());

    expect(snapshot.repoPaths).toContain('src/app.ts');
    expect(snapshot.repoPaths).toContain('CLAUDE.md');
    expect(snapshot.repoPaths).not.toContain('uncommitted.md');
    expect(snapshot.documents.map((document) => document.path)).not.toContain('uncommitted.md');
  });

  it('lists a symlink and a gitlink and reads neither', async () => {
    const snapshot = expectOk(await read());

    expect(snapshot.repoPaths).toContain(`${KNOWLEDGE_DIR}/evil.md`);
    expect(snapshot.repoPaths).toContain('vendor/sub');
    expect(snapshot.documents.map((document) => document.path)).not.toContain(
      `${KNOWLEDGE_DIR}/evil.md`,
    );
    expect(snapshot.documents.map((document) => document.path)).not.toContain('vendor/sub');
    // Not one byte of the target, and not the link target's path either: `cat-file -p` on a mode
    // 120000 entry prints the path, which is what an adapter that read it would have indexed.
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(snapshot.documents)).not.toContain(secretFile);
  });

  it('refreshes the mirror before it reads, so a commit pushed after the first run is indexed', async () => {
    const first = expectOk(await read());
    expect(first.documents.map((document) => document.path)).not.toContain(
      `${KNOWLEDGE_DIR}/lessons/L-2.md`,
    );

    await write(origin, `${KNOWLEDGE_DIR}/lessons/L-2.md`, '---\nid: L-2\n---\n# Second\n');
    await git(['-C', origin, 'add', '-A']);
    await commit(origin, 'a second lesson');

    const second = expectOk(await read());
    expect(second.documents.map((document) => document.path)).toContain(
      `${KNOWLEDGE_DIR}/lessons/L-2.md`,
    );
    expect(second.commitSha).not.toBe(first.commitSha);
  });

  it('reports a refresh that failed rather than reading the copy it already has', async () => {
    expectOk(await read());
    await rm(origin, { recursive: true, force: true });

    const reason = expectUnavailable(await read());
    expect(reason).toContain('could not be refreshed');
  });

  it('refuses a commit that is not an ancestor of the default branch', async () => {
    expectOk(await read());
    await git(['-C', origin, 'checkout', '-q', '-b', 'agentic/task-1']);
    await write(origin, `${KNOWLEDGE_DIR}/lessons/L-9.md`, '---\nid: L-9\n---\n# On a branch\n');
    await git(['-C', origin, 'add', '-A']);
    await commit(origin, 'a lesson on the task branch');
    const branchHead = await git(['-C', origin, 'rev-parse', 'HEAD']);

    const reason = expectUnavailable(await read({ commitSha: branchHead }));
    expect(reason).toContain('is not an ancestor');
    expect(reason).toContain('BD-025');
  });

  it('reads a commit that is an ancestor of the default branch', async () => {
    const first = expectOk(await read());
    await write(origin, `${KNOWLEDGE_DIR}/lessons/L-3.md`, '---\nid: L-3\n---\n# Third\n');
    await git(['-C', origin, 'add', '-A']);
    await commit(origin, 'a third lesson');

    // The older commit is still an ancestor, and reading it gives the older tree.
    const pinned = expectOk(await read({ commitSha: first.commitSha }));
    expect(pinned.commitSha).toBe(first.commitSha);
    expect(pinned.documents.map((document) => document.path)).not.toContain(
      `${KNOWLEDGE_DIR}/lessons/L-3.md`,
    );
  });

  it('refuses a commit the remote does not have, after trying to fetch it', async () => {
    const reason = expectUnavailable(
      await read({ commitSha: 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff' }),
    );
    expect(reason).toContain('is not in the mirror after a fetch');
  });

  it('never passes a commit that is not a sha to git', async () => {
    const runner = recordingRunner();
    const reason = expectUnavailable(
      await read({ commitSha: '--upload-pack=touch /tmp/pwned', git: runner }),
    );
    expect(reason).toContain('is not a commit sha');
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses a repository URL whose scheme is not http(s) or file', async () => {
    const reason = expectUnavailable(
      await read({ target: target({ repoUrl: 'ext::sh -c "touch /tmp/pwned"' }) }),
    );
    expect(reason).toContain('allow-list');
  });

  it('refuses a project with no git binding, and says so rather than indexing nothing', async () => {
    const reason = expectUnavailable(await read({ target: null }));
    expect(reason).toContain('no git binding');
  });

  it('reports a binding that could not be read as the reason the vault is unavailable', async () => {
    const reason = expectUnavailable(
      await read({ targetThrows: new Error('the credential will not decrypt') }),
    );
    expect(reason).toContain('the credential will not decrypt');
  });

  it('refuses a mirror root that is not a directory, and never creates one', async () => {
    const absent = path.join(root, 'not-mounted');
    const reason = expectUnavailable(await read({ mirrorRoot: absent }));
    expect(reason).toContain('APP_KNOWLEDGE_MIRROR_ROOT');
    await expect(readFile(absent)).rejects.toThrow();
  });

  it('keeps the credential out of the argument vector and out of the mirror’s own config', async () => {
    const runner = recordingRunner();
    expectOk(await read({ git: runner }));

    // Both directions (standing rule 42), and the positive one is asked of a command that would
    // actually send it: the credential is in the environment of the **clone** — the only child in
    // this run that opens a connection — and in no argument vector anywhere.
    const networkCalls = runner.calls.filter(
      (call) => call.args.includes('clone') || call.args.includes('update'),
    );
    expect(networkCalls).toHaveLength(1);
    for (const call of networkCalls) {
      expect(JSON.stringify(call.env)).toContain(CREDENTIAL.password);
    }
    for (const call of runner.calls) {
      expect(call.args.join(' ')).not.toContain(CREDENTIAL.password);
    }

    const config = await readFile(
      path.join(mirrorRoot, `p${PROJECT.replaceAll('-', '')}`, 'config'),
      'utf8',
    );
    expect(config).not.toContain(CREDENTIAL.password);
    expect(config).toContain(`file://${origin}`);
  });

  it('gives the local plumbing reads no credential at all', async () => {
    const runner = recordingRunner();
    expectOk(await read({ git: runner }));

    // `rev-parse`, `ls-tree`, `cat-file` and `merge-base` open no connection, so a credential in
    // their environment would be a secret in four more process environments for nothing.
    const local = runner.calls.filter(
      (call) => !(call.args.includes('clone') || call.args.includes('update')),
    );
    expect(local.length).toBeGreaterThan(0);
    for (const call of local) {
      expect(JSON.stringify(call.env)).not.toContain(CREDENTIAL.password);
      expect(call.env.GIT_CONFIG_VALUE_0).toBeUndefined();
    }
  });

  it('refuses a default branch that could traverse out of refs/heads', async () => {
    const runner = recordingRunner();
    const reason = expectUnavailable(
      await read({ target: target({ defaultBranch: 'a/../../HEAD' }), git: runner }),
    );
    expect(reason).toContain('not a branch name');
    // Refused before it is an argument. Measured without the check: git itself exits 128 on
    // `rev-parse refs/heads/a/../../HEAD`, so the outcome was already `unavailable` — what the
    // check buys is that the refusal is ours and does not depend on git keeping that behaviour.
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses a project id that would not be a plain directory name', async () => {
    const runner = recordingRunner();
    const result = await createGitVaultSource({
      mirrorRoot,
      git: runner,
      target: async () => target(),
    }).read({
      // Unreachable through the job — `idSchema` parses the payload and the composition casts a
      // uuid — which is exactly why the guard is a claim about intent (standing rule 55).
      projectId: '../../etc' as Id,
      knowledgeDir: KNOWLEDGE_DIR,
    });
    expect(expectUnavailable(result)).toContain('plain directory name');
    expect(runner.calls).toHaveLength(0);
  });

  it('gives every document the git blob sha as its content hash', async () => {
    const snapshot = expectOk(await read());
    const blobs = new Map(
      (await git(['-C', origin, 'ls-tree', '-r', 'HEAD']))
        .split('\n')
        .map((line) => line.split('\t'))
        .map(([head, file]) => [file ?? '', (head ?? '').split(' ')[2] ?? '']),
    );
    for (const document of snapshot.documents) {
      expect(document.contentHash).toBe(blobs.get(document.path));
    }
  });
});

describe('parseTreeEntries', () => {
  it('reads a mode, a blob sha, a size and a path with spaces in it', () => {
    const entries = parseTreeEntries(
      '100644 blob 1111111111111111111111111111111111111111      12\ta file.md\0' +
        '160000 commit 2222222222222222222222222222222222222222       -\tvendor/sub\0',
    );
    expect(entries).toEqual([
      {
        mode: '100644',
        type: 'blob',
        objectId: '1111111111111111111111111111111111111111',
        size: 12,
        path: 'a file.md',
      },
      {
        mode: '160000',
        type: 'commit',
        objectId: '2222222222222222222222222222222222222222',
        size: 0,
        path: 'vendor/sub',
      },
    ]);
  });

  it('refuses a record it cannot frame rather than guessing', () => {
    expect(() => parseTreeEntries('100644 blob 1111\0')).toThrow(/no path separator/);
  });
});

describe('parseCatFileBatch', () => {
  it('frames on the declared byte length, including a body that contains newlines', () => {
    const body = 'line one\nline two\n';
    const stdout = Buffer.concat([
      Buffer.from(`1111111111111111111111111111111111111111 blob ${body.length}\n`, 'utf8'),
      Buffer.from(body, 'utf8'),
      Buffer.from('\n', 'utf8'),
      Buffer.from('2222222222222222222222222222222222222222 blob 2\nhi\n', 'utf8'),
    ]);
    expect(parseCatFileBatch(stdout).map((object) => object.content.toString('utf8'))).toEqual([
      body,
      'hi',
    ]);
  });

  it('throws on a missing object instead of returning half a vault', () => {
    expect(() => parseCatFileBatch(Buffer.from('deadbeef missing\n', 'utf8'))).toThrow(/refused/);
  });
});

describe('probeGit', () => {
  it('finds the git this process would spawn', async () => {
    const probe = await probeGit();
    expect(probe.available).toBe(true);
    expect(probe.detail).toContain('git version');
  });

  it('is unavailable when git cannot be started, and says why', async () => {
    const probe = await probeGit({
      run: async () => {
        throw new Error('spawn git ENOENT');
      },
    });
    expect(probe).toEqual({
      available: false,
      detail: 'git could not be started: spawn git ENOENT',
    });
  });
});

describe('unavailableVaultSource', () => {
  it('refuses with the reason it was composed with, for every request', async () => {
    const result = await unavailableVaultSource('APP_KNOWLEDGE_MIRROR_ROOT is not set').read({
      projectId: PROJECT,
      knowledgeDir: KNOWLEDGE_DIR,
    });
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'APP_KNOWLEDGE_MIRROR_ROOT is not set',
    });
  });
});

describe('gitEnvironment', () => {
  it('passes through what git needs and nothing else', () => {
    const env = gitEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/agentic',
      HTTPS_PROXY: 'http://proxy.example.test:3128',
      APP_SECRET_KEY: 'not-for-git',
      ANTHROPIC_API_KEY: 'sk-ant-not-for-git',
    });
    expect(env).toEqual({
      GIT_TERMINAL_PROMPT: '0',
      PATH: '/usr/bin',
      HOME: '/home/agentic',
      HTTPS_PROXY: 'http://proxy.example.test:3128',
    });
  });
});
