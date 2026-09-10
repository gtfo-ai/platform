/**
 * Every name and path a run's Docker objects are given, and the guards that decide them.
 *
 * This file exists because one value — the run id — becomes four different kinds of external
 * identifier: a Docker container name, a network name, a volume name, and a **path component** of
 * the shared control volume (`<ctl>/<run-id>/`, TD-025 §2). A path component is the dangerous one.
 * The daemon resolves `volume-subpath` inside the volume, so a run id containing `..` would mount
 * another run's control directory — and the run token that authenticates the control channel lives
 * in it.
 *
 * The guard is `runIdSchema` (a uuid) and it is applied *here*, at the point where a string turns
 * into a path, rather than only where the spec is parsed. That is deliberate duplication: the
 * pipeline validates its spec, and this adapter still refuses to build a path out of anything but
 * a uuid, because a guard that lives only at the far end of a call chain is one refactor away from
 * being skipped.
 *
 * What the negatives in `names.test.ts` are chosen to discriminate (standing rule 43): `../x`
 * proves nothing on its own, because every candidate implementation rejects it. `..%2f` (a
 * percent-encoded separator, which a URL-decoding daemon or proxy would turn back into `../`),
 * `x/../../y` (an escape that normalises *back* inside before it leaves), a full-width `．．／`
 * and a uuid with a trailing `/.` are the cases that separate "validates the shape" from "strips
 * the obvious".
 */
import path from 'node:path';
import { runIdSchema, WorkspaceError } from '@platform/application';

/** Refuses anything that is not a uuid, naming the value's *shape* rather than the value. */
export const assertRunId = (runId: string): string => {
  const parsed = runIdSchema.safeParse(runId);
  if (!parsed.success) {
    throw new WorkspaceError('invalid_spec', 'run id is not a uuid', {
      detail: `length ${runId.length}`,
    });
  }
  return parsed.data;
};

/** `ws-<run-id>`: the workspace volume. Outlives the container, per retention. */
export const workspaceVolumeName = (runId: string): string => `ws-${assertRunId(runId)}`;

/** `run-<run-id>`: the per-run `internal: true` network. */
export const runNetworkName = (runId: string): string => `run-${assertRunId(runId)}`;

/** `ws-<run-id>`: the run container. Same stem as the volume; different Docker namespace. */
export const runContainerName = (runId: string): string => `ws-${assertRunId(runId)}`;

/** `egress-<run-id>`: the sidecar. */
export const egressContainerName = (runId: string): string => `egress-${assertRunId(runId)}`;

/**
 * The run's sub-directory of the shared control volume, as the *runner* sees it.
 *
 * `path.join` would happily absorb a `..`; the id is asserted first, so it cannot contain one.
 * The result is checked against the root anyway — the belt to the braces, because this is the
 * value that decides which run's token a container can read.
 */
export const controlDirectory = (controlRoot: string, runId: string): string => {
  const resolved = path.resolve(controlRoot, assertRunId(runId));
  const root = path.resolve(controlRoot);
  if (resolved !== path.join(root, runId) || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new WorkspaceError('invalid_spec', 'control directory escapes the control volume', {
      runId,
    });
  }
  return resolved;
};

/**
 * The longest a Unix socket path may be.
 *
 * `sockaddr_un.sun_path` is **104** bytes on macOS and the BSDs and 108 on Linux, so 103 is the
 * portable ceiling for the string. This is not a theoretical bound: it was hit while writing this
 * work package's tests, where a temp directory under macOS' `/var/folders/kc/…/T/` left only 40
 * characters for `<uuid>/ctl.sock`'s 45, and Node reported **`EINVAL` from `connect`** — a message
 * that names nothing and looks exactly like a protocol fault. It is the same class of failure
 * WP-13 called out for the socket's uid (Q51): a one-line configuration mistake wearing the
 * disguise of a bug in the frame protocol.
 *
 * TD-025's own layout costs 45 of the budget (`/<uuid>/ctl.sock`), so a control root longer than
 * 58 characters cannot work. Production's is `/run/agentic/ctl` — 16.
 */
export const MAX_UNIX_SOCKET_PATH = 103;

/** The control socket, from the runner's side of the volume (TD-025 §2). */
export const controlSocketPath = (controlRoot: string, runId: string): string => {
  const socket = path.join(controlDirectory(controlRoot, runId), 'ctl.sock');
  if (Buffer.byteLength(socket, 'utf8') > MAX_UNIX_SOCKET_PATH) {
    throw new WorkspaceError(
      'invalid_spec',
      `the control socket path is ${Buffer.byteLength(socket, 'utf8')} bytes, over the ` +
        `${MAX_UNIX_SOCKET_PATH}-byte limit a Unix socket address can hold; shorten the control ` +
        'volume mount point (TD-025 uses /run/agentic/ctl)',
      { runId },
    );
  }
  return socket;
};

/** The bare mirror of one project on the shared `repo-cache` volume, as a container sees it. */
export const mirrorPath = (cacheMount: string, cacheKey: string): string => {
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(cacheKey) || cacheKey.includes('..')) {
    throw new WorkspaceError('invalid_spec', 'mirror cache key is not a safe path component', {
      detail: `length ${cacheKey.length}`,
    });
  }
  return `${cacheMount}/${cacheKey}.git`;
};

/** Where the workspace's clone lives inside the run container. TD-025 §2's `cwd`. */
export const WORKSPACE_WORKDIR = '/work/repo';

/** Where the control volume's run sub-directory is mounted inside the run container. */
export const CONTAINER_CONTROL_MOUNT = '/ctl';

/** Where the bare mirrors are mounted, read-only, inside the run container. */
export const CONTAINER_CACHE_MOUNT = '/cache';
