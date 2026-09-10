/**
 * The egress sidecar's allow-list, rendered (technical/05 § "Network policy", TD-021).
 *
 * The workspace sits on an `internal: true` network with no default route, so the only way out is
 * the sidecar, and the only thing that decides what the sidecar forwards is the file this module
 * writes. tinyproxy's shape: `FilterDefaultDeny Yes` plus a `Filter` file of extended regular
 * expressions matched against the destination host, and `ConnectPort` lines bounding which ports
 * `CONNECT` may name.
 *
 * ## Anchoring is the whole thing
 *
 * A filter file of bare host names is not an allow-list. tinyproxy matches the pattern anywhere in
 * the host unless it is anchored, so `gitlab.example.com` would admit `gitlab.example.com.evil.test`
 * — and an unescaped `.` would admit `gitlabXexample.com`. The rendered pattern is therefore
 * `^gitlab\.example\.com$`, and `egress.test.ts` drives the discriminating negatives rather than
 * the obvious one (standing rule 43): `evil.example.com` is refused by every candidate
 * implementation and proves nothing, while `evil-gitlab.example.com`, `gitlab.example.com.evil.test`
 * and `xgitlab.example.com` separate exact matching from substring matching, and `gitlabXexample.com`
 * separates an escaped dot from an unescaped one.
 *
 * ## What these tests do *not* prove — and one place the configuration is known to be wrong
 *
 * That tinyproxy applies the file this way. The test compiles the rendered pattern with
 * JavaScript's own regular expressions, which is a **model** of tinyproxy's POSIX ERE, and a model
 * is not the binary. Every directive below is **inferred from tinyproxy's documentation, not
 * measured against it**: no test in this repository has ever started the daemon. The binary
 * arrives with the `platform-runtime`/egress image in WP-22, which is the work package that can run
 * a request through it; `docs/TODO.md` carries that as a verification item. What the e2e here
 * *does* demonstrate is the property underneath — that the workspace has no route off its run
 * network at all, so a sidecar that denied nothing would still be the only path out.
 *
 * A known consequence of that gap, found by reading rather than by running (WP-14 review round 1):
 * `User nobody`/`Group nobody` below asks tinyproxy to drop privileges, while `sidecarCreateBody`
 * starts the container as uid 1000 with `CapDrop: ['ALL']` — and a process with no `CAP_SETUID`
 * cannot setuid, so **the real image would not start with this file as written**. It is left as
 * WP-22's, at the moment the binary first runs, rather than guessed at now: the fix is a line in
 * the config or a capability on the container, and only a running image can say which. `docs/TODO.md`
 * carries it.
 */
import { egressHostSchema, type WorkspaceEgress, WorkspaceError } from '@platform/application';

/** The port the sidecar listens on; `HTTPS_PROXY` in the workspace points at it. */
export const EGRESS_PORT = 8888;

/** Where the rendered files are mounted in the sidecar. */
export const EGRESS_CONFIG_MOUNT = '/etc/egress';

const escapeEre = (host: string): string => host.replaceAll('.', String.raw`\.`);

/**
 * One anchored ERE per allowed host. Exported because the filter file and the tests that
 * discriminate exact matching from substring matching must be looking at the same string.
 */
export const egressFilterPattern = (host: string): string => {
  const parsed = egressHostSchema.safeParse(host);
  if (!parsed.success) {
    // Unreachable through `create` (the spec schema validates first) and deliberately kept: this
    // function's output is a security rule, and a caller reaching it another way must not be able
    // to put a regular expression into it. Standing rule 22 — named, not silently unreachable.
    throw new WorkspaceError('invalid_spec', 'egress host is not a DNS host name', {
      detail: `length ${host.length}`,
    });
  }
  return `^${escapeEre(parsed.data)}$`;
};

export interface RenderedEgressConfig {
  /** `tinyproxy.conf`. */
  readonly config: string;
  /** The filter file `FilterDefaultDeny` consults. */
  readonly filter: string;
}

/**
 * Renders the sidecar's configuration for one run.
 *
 * Deliberate choices, each one a denial:
 *  - `FilterDefaultDeny Yes` — an empty filter file denies everything rather than allowing it.
 *  - `FilterURLs Off` — the filter matches the *host*, not the URL, so a path cannot smuggle an
 *    allowed name into a request for another host.
 *  - `ConnectPort` lines — without them tinyproxy tunnels `CONNECT` to any port, which turns an
 *    HTTPS allow-list into a general TCP relay for the allowed hosts.
 *  - `DisableViaHeader Yes` and no `XTinyproxy` — the workspace learns nothing about the platform.
 */
export const renderEgressConfig = (egress: WorkspaceEgress): RenderedEgressConfig => {
  const hosts = [...new Set(egress.hosts)].sort();
  const ports = [...new Set(egress.connectPorts)].sort((a, b) => a - b);
  if (ports.length === 0) {
    throw new WorkspaceError('invalid_spec', 'egress allows no CONNECT port at all');
  }
  const config = [
    '# Rendered per run by the launcher (technical/05). Do not edit: it is recreated every run.',
    'User nobody',
    'Group nobody',
    'Listen 0.0.0.0',
    `Port ${EGRESS_PORT}`,
    'Timeout 600',
    'MaxClients 32',
    'LogLevel Notice',
    'DisableViaHeader Yes',
    `Filter "${EGRESS_CONFIG_MOUNT}/filter"`,
    'FilterURLs Off',
    'FilterExtended On',
    'FilterCaseSensitive Off',
    'FilterDefaultDeny Yes',
    ...ports.map((port) => `ConnectPort ${port}`),
    '',
  ].join('\n');
  const filter = `${hosts.map(egressFilterPattern).join('\n')}\n`;
  return { config, filter };
};

/** The proxy URL the workspace's `HTTPS_PROXY`/`HTTP_PROXY` point at. */
export const egressProxyUrl = (sidecarHost: string): string =>
  `http://${sidecarHost}:${EGRESS_PORT}`;
