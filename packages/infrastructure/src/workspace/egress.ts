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
 * ## What the unit test proves, and what the daemon proved (WP-22)
 *
 * The unit test compiles the rendered pattern with JavaScript's own regular expressions, which is
 * a **model** of tinyproxy's POSIX ERE, and a model is not the binary. Until WP-22 that was all
 * there was: no test in this repository had ever started the daemon. The binary is now
 * `platform-egress` (`docker/egress.Dockerfile`, tinyproxy 1.11.2 pinned), and
 * `test/e2e/workspace/docker-workspace.e2e.test.ts` runs a **request through it** from inside the
 * run container — an allowed host answers 200, a host that is not on the list is refused 403 —
 * under exactly the flags `sidecarCreateBody` sets: uid 1000, `CapDrop: ['ALL']`, read-only rootfs.
 *
 * ## `User nobody` is gone, and the reason it was expected to matter turned out to be wrong
 *
 * WP-14's review found by reading — not by running — that `User nobody`/`Group nobody` asks
 * tinyproxy to drop privileges while `sidecarCreateBody` starts the container as uid 1000 with
 * every capability dropped, and predicted that **"the real image would not start with this file as
 * written"** (PROGRESS backlog 7). Measured against the real image at WP-22, that prediction is
 * **false**: with both lines present tinyproxy 1.11.2 starts, stays up as uid 1000, serves a
 * proxied request to an allowed host (200) and refuses a filtered one (403, *"Proxying refused on
 * filtered domain"*). It does not even warn. Standing rule 27 again — *measure a prescribed fix
 * before applying it*.
 *
 * They are removed anyway, for the reason that survives the measurement rather than the one that
 * did not: the process does **not** honour them, so they are a claim about this container that
 * nothing enforces (standing rule 3), and they are a trap for the day somebody starts the sidecar
 * as root, when the directive would suddenly bind and move the proxy off the uid the rest of the
 * design assumes. The uid is the create body's to state, and it states it.
 *
 * `FilterExtended On` is likewise replaced by `FilterType ere`, which is the same setting under the
 * spelling the pinned binary wants: with the old one it logs *"line 11: deprecated option
 * FilterExtended, use FilterType"*, and the anchoring this whole module rests on is an **ERE**
 * property, so it is not a directive to leave on a deprecation path.
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
    // No `User`/`Group`: the container already runs as uid 1000 (`sidecarCreateBody`) and the
    // directive is the create body's job, not this file's. See the measurement in the docblock.
    'Listen 0.0.0.0',
    `Port ${EGRESS_PORT}`,
    'Timeout 600',
    'MaxClients 32',
    'LogLevel Notice',
    'DisableViaHeader Yes',
    `Filter "${EGRESS_CONFIG_MOUNT}/filter"`,
    'FilterURLs Off',
    // `FilterExtended On` under the spelling tinyproxy 1.11 asks for; the old one warns.
    'FilterType ere',
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
