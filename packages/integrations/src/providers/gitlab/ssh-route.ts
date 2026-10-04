/**
 * How a run reaches **GitLab.com** over SSH with a deploy key — TD-028 decision 13b items 3 and 4
 * (WP-146).
 *
 * The run's egress sidecar is tinyproxy, which admits `CONNECT` to port 443 and nothing else, and
 * whose `ConnectPort` is global — admitting 22 would admit it for every allowed host. GitLab.com
 * answers SSH on 443 at `altssh.gitlab.com` (<https://docs.gitlab.com/user/gitlab_com/>, retrieved
 * 2026-10-04: *"GitLab.com can be reached by using a different SSH port for `git+ssh`"* — hostname
 * `altssh.gitlab.com`, port `443`), so a run's SSH is a `CONNECT altssh.gitlab.com:443`, and its host
 * keys are pinned under `gitlab.com` with `HostKeyAlias`.
 *
 * **The keys are the documented ones** (the same page, § "SSH `known_hosts` entries"), never a first
 * connection's. Measured at WP-146 (2026-10-04, `ssh-keyscan -p 443 -t ed25519,rsa,ecdsa
 * altssh.gitlab.com` from the implementer's machine, not through the sidecar): altssh answered
 * `SSH-2.0-GitLab-SSHD` with exactly these three keys, fingerprints ED25519
 * `SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8`, RSA `SHA256:ROQFvPThGrW4RuWLoL9tq9I9zJ42fK4XywyRtbOz/EQ`,
 * ECDSA `SHA256:HbW3g8zUjNSksFbqTiUWPWg2Bq1x8xdGUrliXFzSnUw` — research/10's 2026-10-04 addendum's
 * `[unverified]` line, answered.
 *
 * **A self-managed instance has no route** in this build and is refused by name: it would need its
 * SSH port admitted by the egress sidecar, which this build does not do (decision 13b item 4).
 */
import type { SshGitRoute } from '@platform/application';

/** GitLab.com's instance root, as `base_url` spells it. */
export const GITLAB_COM_BASE_URL = 'https://gitlab.com';

/** The documented `known_hosts` lines of gitlab.com (see the module docblock for the source). */
export const GITLAB_COM_KNOWN_HOSTS: readonly string[] = [
  'gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf',
  'gitlab.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCsj2bNKTBSpIYDEGk9KxsGh3mySTRgMtXL583qmBpzeQ+jqCMRgBqB98u3z++J1sKlXHWfM9dyhSevkMwSbhoR8XIq/U0tCNyokEi/ueaBMCvbcTHhO7FcwzY92WK4Yt0aGROY5qX2UKSeOvuP4D6TPqKF1onrSzH9bx9XUf2lEdWT/ia1NEKjunUqu1xOB/StKDHMoX4/OKyIzuS0q/T1zOATthvasJFoPrAjkohTyaDUz2LN5JoH839hViyEG82yB+MjcFV5MU3N1l1QL3cVUCh93xSaua1N85qivl+siMkPGbO5xR/En4iEY6K2XPASUEMaieWVNTRCtJ4S8H+9',
  'gitlab.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFSMqzJeV9rUzU4kWitGjeR4PWSa29SPqJ1fVkhtj3Hw9xjLVXVYrU9QlYWrOLXBpQ6KWjbjTDTdDkoohFzgbEY=',
];

/** GitLab.com's SSH route for a deploy-key run. */
export const GITLAB_COM_SSH_ROUTE: SshGitRoute = {
  httpsPrefix: 'https://gitlab.com/',
  sshPrefix: 'ssh://git@altssh.gitlab.com:443/',
  connectHost: 'altssh.gitlab.com',
  connectPort: 443,
  hostKeyAlias: 'gitlab.com',
  knownHosts: GITLAB_COM_KNOWN_HOSTS,
};

/** decision 13b item 4's refusal, verbatim. */
export const SELF_MANAGED_SSH_REFUSAL =
  'SSH deploy-key runs reach gitlab.com through altssh.gitlab.com:443 only; a self-managed host needs its SSH port admitted by the egress sidecar, which this build does not do (TD-028 decision 13b)';

/** The route for a GitLab document, or the refusal by name for any host but GitLab.com. */
export const gitlabSshRoute = (config: Readonly<Record<string, unknown>>): SshGitRoute | string =>
  config['base_url'] === GITLAB_COM_BASE_URL ? GITLAB_COM_SSH_ROUTE : SELF_MANAGED_SSH_REFUSAL;
