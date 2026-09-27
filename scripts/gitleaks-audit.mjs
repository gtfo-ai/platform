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

/** The frame the container prints its own staged `--numstat` in, ahead of the scan (backlog 246). */
export const NUMSTAT_BEGIN = '@@gitleaks-container-numstat-begin@@';
export const NUMSTAT_END = '@@gitleaks-container-numstat-end@@';
const NUMSTAT_FAILED = '@@gitleaks-container-numstat-failed@@';
/** Separates the numstat half of the frame from the blob-id half (review round 1). */
export const RAW_BEGIN = '@@gitleaks-container-raw-begin@@';

/** The one `git diff` both sides ask, so the host's answer and the container's are comparable. */
const NUMSTAT_ARGS = ['diff', '--cached', '--numstat', '-z', '--no-renames'];
/**
 * The staged **blob ids**, both sides (WP-73b review round 1). Counts alone pass a partly stale
 * index whose stale blob has the same line counts — a placeholder staged, edited into a real key
 * and staged again is `1 0 file` both times — so the object id the index names for each path is
 * compared too. `--no-abbrev` so two ids never share a prefix by accident.
 */
const RAW_ARGS = ['diff', '--cached', '--raw', '--no-abbrev', '-z', '--no-renames'];

/**
 * The shell the container runs when the scan is of the **staged** diff (WP-73b, PROGRESS backlog
 * 246): its own view of the index first, framed, then the scan in the **same** container — so the
 * index the comparison reads is the one the scan read, and not a second container's that Docker
 * Desktop's file sharing may have served differently (the stale index WP-68 measured was per run).
 */
const PROBE_SCRIPT = [
  `printf '%s\\n' '${NUMSTAT_BEGIN}'`,
  `git ${NUMSTAT_ARGS.join(' ')} || { printf '\\n%s\\n' '${NUMSTAT_FAILED}'; exit 125; }`,
  `printf '\\n%s\\n' '${RAW_BEGIN}'`,
  `git ${RAW_ARGS.join(' ')} || { printf '\\n%s\\n' '${NUMSTAT_FAILED}'; exit 125; }`,
  `printf '\\n%s\\n' '${NUMSTAT_END}'`,
  'exec gitleaks "$@"',
].join('; ');

/**
 * `docker run` arguments that let git in the container read this checkout — linked or not.
 * Both mounts are read-only: gitleaks only reads, and `git diff --staged` takes no lock.
 *
 * With `probeIndex`, the container runs {@link PROBE_SCRIPT} instead of gitleaks directly, so its
 * stdout starts with its own staged `--numstat` between {@link NUMSTAT_BEGIN} and
 * {@link NUMSTAT_END}; {@link containerIndexVerdict} reads it back. The image ships `/bin/sh` and
 * `git` (measured on the pinned digest at WP-73b: `/usr/bin/git`, 2.49.1).
 */
export function containerArgs(layout, image, scanArgs, options = {}) {
  const containerGitDir =
    layout.relativeGitDir === ''
      ? CONTAINER_COMMON_DIR
      : `${CONTAINER_COMMON_DIR}/${layout.relativeGitDir.split(sep).join('/')}`;
  const probe = options.probeIndex === true;
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
    ...(probe ? ['--entrypoint', '/bin/sh'] : []),
    image,
    ...(probe ? ['-c', PROBE_SCRIPT, 'gitleaks-probe'] : []),
    ...scanArgs,
  ];
}

/** The host's staged `--numstat -z`, raw, or `null` when git cannot say. */
export function stagedNumstat(root) {
  const numstat = spawnSync('git', NUMSTAT_ARGS, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (numstat.error !== undefined || numstat.status !== 0) {
    return null;
  }
  return numstat.stdout;
}

/** The host's staged `--raw -z` (blob ids), or `null` when git cannot say. */
export function stagedRaw(root) {
  const raw = spawnSync('git', RAW_ARGS, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (raw.error !== undefined || raw.status !== 0) {
    return null;
  }
  return raw.stdout;
}

/**
 * A `--raw -z` answer as sorted `<path> <whole header>` records. `-z` puts each path after its
 * `:<old mode> <new mode> <old id> <new id> <status>` header as a field of its own, and the whole
 * header is compared (review round 2): the old id catches a container that sees an older HEAD
 * against the same index, and the modes catch a mode-only change.
 */
export function rawRecords(raw) {
  const fields = raw.split('\0').map((field) => field.replace(/^\n+|\n+$/g, ''));
  const records = [];
  for (let index = 0; index < fields.length; index += 1) {
    const header = fields[index] ?? '';
    if (!header.startsWith(':')) {
      continue;
    }
    records.push(`${fields[index + 1] ?? ''} ${header}`);
    index += 1;
  }
  return records.toSorted();
}

/** A `--numstat -z` answer as its sorted records, so two answers compare by content. */
export function numstatRecords(numstat) {
  return numstat
    .split('\0')
    .map((record) => record.replace(/^\n+|\n+$/g, ''))
    .filter((record) => record !== '')
    .toSorted();
}

/** The added lines of a `--numstat -z` answer; a binary file (`-`) counts as nothing. */
export function addedLinesOf(numstat) {
  let added = 0;
  for (const record of numstatRecords(numstat)) {
    const count = Number.parseInt(record.split('\t')[0] ?? '', 10);
    if (Number.isFinite(count)) {
      added += count;
    }
  }
  return added;
}

/**
 * Lines the staged diff adds, as the host's git counts them. A binary file (`-` in `--numstat`)
 * counts as nothing, because gitleaks does not scan one either.
 */
export function stagedAddedLines(root) {
  const numstat = stagedNumstat(root);
  return numstat === null ? null : addedLinesOf(numstat);
}

/**
 * Whether the container saw the index the host sees (WP-73b, PROGRESS backlog 246).
 *
 * WP-68 measured Docker Desktop serving the container a **stale** index — twice in four runs the
 * whole tree read as deleted — and the zero-byte audit refuses only the fully stale case. A partly
 * stale one (some added lines visible, the credential's not) would scan a non-zero number of bytes
 * and pass. So the container prints its own staged `--numstat` **and** the blob id the index names
 * for every staged path (`--raw --no-abbrev`) ahead of the scan, and anything but the host's answer
 * record for record — a missing frame, a failed `git diff`, one line more or less, one blob id
 * different — is a refusal. `rest` is the stdout with the frame taken out, which is what gets
 * echoed. **Still unchecked**: that gitleaks, once exec'd, reads the same index the two `git diff`
 * calls just read — the three run in one container moments apart, and a mount that changed between
 * them is not detected. (A mode-only change *is* compared since review round 2: the whole raw
 * header is.)
 */
export function containerIndexVerdict({ hostNumstat, hostRaw, stdout }) {
  const begin = stdout.indexOf(NUMSTAT_BEGIN);
  if (stdout.includes(NUMSTAT_FAILED)) {
    return {
      ok: false,
      reason: 'git inside the container could not read the staged diff',
      rest: stdout,
    };
  }
  const end = stdout.indexOf(NUMSTAT_END, begin);
  if (begin === -1 || end === -1) {
    return {
      ok: false,
      reason: 'the container printed no staged --numstat, so nothing proves it read your index',
      rest: stdout,
    };
  }
  const framed = stdout.slice(begin + NUMSTAT_BEGIN.length, end);
  const rest = `${stdout.slice(0, begin)}${stdout.slice(end + NUMSTAT_END.length).replace(/^\n/, '')}`;
  const split = framed.indexOf(RAW_BEGIN);
  if (split === -1) {
    return {
      ok: false,
      reason: 'the container printed no staged blob ids, so nothing proves it read your index',
      rest,
    };
  }
  const container = framed.slice(0, split);
  const containerRaw = framed.slice(split + RAW_BEGIN.length);
  if (hostNumstat === null || hostRaw === null) {
    return { ok: false, reason: 'the host could not read its own staged diff', rest };
  }
  const host = numstatRecords(hostNumstat);
  const seen = numstatRecords(container);
  if (host.length !== seen.length || host.some((record, index) => record !== seen[index])) {
    return {
      ok: false,
      reason: `the container read a different staged diff than the host (host: ${host.length} files, ${addedLinesOf(hostNumstat)} added lines; container: ${seen.length} files, ${addedLinesOf(container)} added lines) — a stale index, so its scan is not evidence`,
      rest,
    };
  }
  const hostBlobs = rawRecords(hostRaw);
  const seenBlobs = rawRecords(containerRaw);
  if (
    hostBlobs.length !== seenBlobs.length ||
    hostBlobs.some((record, index) => record !== seenBlobs[index])
  ) {
    return {
      ok: false,
      reason:
        'the container read the same line counts but different staged blobs than the host — a stale index, so its scan is not evidence',
      rest,
    };
  }
  return { ok: true, rest };
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
