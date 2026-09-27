/**
 * The decisions `gitleaks.mjs` makes, kept apart from the entrypoint so a test can import them
 * without running a scan: where the repository really is (a linked worktree's git directory lives
 * in the main worktree's `.git`), how a container is told so, and whether a finished scan proved
 * that it read anything. The reasoning is in `gitleaks.mjs`'s docblock; this file is the mechanism.
 *
 * Plain JavaScript for the reason `os-artefacts.mjs` gives: the hook runs it with no TypeScript
 * resolver loaded. `gitleaks-audit.d.mts` carries the types.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';

/** Where the container sees the work tree and the common git directory. */
const CONTAINER_WORK_TREE = '/repo';
const CONTAINER_COMMON_DIR = '/gitcommon';

/**
 * The host's view of the repository the scan is about: the work tree, the common git directory
 * (the main worktree's `.git`) and this checkout's own git directory. In an ordinary checkout the
 * last two are the same path; in a linked worktree the git directory is
 * `<common>/worktrees/<name>`. Answers `null` when git cannot say — which the Docker branch then
 * treats as a refusal rather than guessing a layout.
 */
export function gitLayout(root) {
  const probe = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'],
    { cwd: root, encoding: 'utf8' },
  );
  if (probe.error !== undefined || probe.status !== 0) {
    return null;
  }
  const [workTree, commonDir, gitDir] = probe.stdout
    .trim()
    .split('\n')
    .map((path) => realpathSync(path));
  if (workTree === undefined || commonDir === undefined || gitDir === undefined) {
    return null;
  }
  const relativeGitDir = relative(commonDir, gitDir);
  if (relativeGitDir.startsWith('..')) {
    // A git directory outside its common directory is a layout this script does not mount.
    return null;
  }
  return { workTree, commonDir, gitDir, linked: gitDir !== commonDir, relativeGitDir };
}

/**
 * `docker run` arguments that let git in the container read this checkout — linked or not.
 * Both mounts are read-only: gitleaks only reads, and `git diff --staged` takes no lock.
 */
export function containerArgs(layout, image, scanArgs) {
  const containerGitDir =
    layout.relativeGitDir === ''
      ? CONTAINER_COMMON_DIR
      : `${CONTAINER_COMMON_DIR}/${layout.relativeGitDir.split(sep).join('/')}`;
  return [
    'run',
    '--rm',
    '--network=none',
    '-v',
    `${layout.workTree}:${CONTAINER_WORK_TREE}:ro`,
    '-v',
    `${layout.commonDir}:${CONTAINER_COMMON_DIR}:ro`,
    '-e',
    `GIT_DIR=${containerGitDir}`,
    '-e',
    `GIT_COMMON_DIR=${CONTAINER_COMMON_DIR}`,
    '-e',
    `GIT_WORK_TREE=${CONTAINER_WORK_TREE}`,
    '-w',
    CONTAINER_WORK_TREE,
    image,
    ...scanArgs,
  ];
}

/**
 * Lines the staged diff adds, as the host's git counts them. A binary file (`-` in `--numstat`)
 * counts as nothing, because gitleaks does not scan one either.
 */
export function stagedAddedLines(root) {
  const numstat = spawnSync('git', ['diff', '--cached', '--numstat', '-z', '--no-renames'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (numstat.error !== undefined || numstat.status !== 0) {
    return null;
  }
  let added = 0;
  for (const record of numstat.stdout.split('\0')) {
    const count = Number.parseInt(record.split('\t')[0] ?? '', 10);
    if (Number.isFinite(count)) {
      added += count;
    }
  }
  return added;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: an ANSI colour escape starts with ESC.
const ANSI = /\u001b\[[0-9;]*m/g;

/** The byte count from gitleaks' `scanned ~N bytes` log line, or `null` when there is none. */
export function bytesScanned(output) {
  const match = /scanned ~(\d+) bytes/.exec(output.replace(ANSI, ''));
  return match === null ? null : Number.parseInt(match[1] ?? '', 10);
}

/**
 * Whether a finished scan may be reported as it stands.
 *
 * A non-zero exit is already a failure (a finding, or gitleaks' own error) and passes through
 * unchanged. Exit 0 is believed only when the output proves the scanner read the repository.
 */
export function scanVerdict({ status, output, mayBeEmpty }) {
  if (status !== 0) {
    return { ok: true, status };
  }
  const plain = output.replace(ANSI, '');
  if (/\[git\] fatal:/.test(plain)) {
    return { ok: false, reason: 'git failed inside the scan, so gitleaks read no repository' };
  }
  const bytes = bytesScanned(plain);
  if (bytes === null) {
    return {
      ok: false,
      reason: 'gitleaks reported no "scanned ~N bytes" line, so nothing proves it read anything',
    };
  }
  if (bytes === 0 && !mayBeEmpty) {
    return {
      ok: false,
      reason: 'gitleaks scanned ~0 bytes of a target that has content to scan',
    };
  }
  return { ok: true, status: 0 };
}
