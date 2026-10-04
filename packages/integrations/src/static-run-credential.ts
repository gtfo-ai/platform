/**
 * A **static run credential** — TD-028 decision 13 (the founder's answer to Q98 (b), 2026-10-03),
 * BD-025's and TD-021's amendments of the same date, plan row WP-137.
 *
 * A git provider whose host cannot mint a run-scoped token (GitLab.com Free: project access tokens
 * need Premium there) may let an operator declare, **per integration and opt-in**, a dedicated
 * low-privilege token the platform hands to a run exactly where a minted one would go. This module
 * is the provider-neutral half: a registration **declares which of its config keys** carry the
 * setting ({@link StaticRunCredentialSupport}), and everything that reads them — the binding loader,
 * the write paths of `apps/server`, the probe — reads them through the functions below, so no
 * consumer names GitLab (BD-017) and the rules are written once.
 *
 * What the declaration buys, each a rule of decision 13 item 1:
 *
 *  - the run token is a **separate secret field**, so it is sealed only through `secret_refs`,
 *    stripped from `GET /api/integrations` like every credential, and redacted by exact value in
 *    every process that loads the integration;
 *  - it is **never the API token** — {@link staticRunCredentialOf} compares the two decrypted values
 *    (`sameAsApiToken`) and the run-credential path refuses on it, as the write does;
 *  - **one source per integration**: `static` beside minting switched on is refused;
 *  - a **declared expiry**, required, at most {@link StaticRunCredentialSupport.maxLifetimeDays}
 *    ahead at the write, and refused at use once passed (the platform does not ask the provider).
 *
 * What it does **not** buy, stated rather than implied (decision 13 item 5): the token is not
 * run-lifetime, cannot be revoked per run and reaches read-only stages with its push scope; its reach
 * is the dedicated user's memberships, which the platform cannot see.
 */
import type { StaticRunCredential } from '@platform/application';

/**
 * Which config keys hold a provider's static run credential. Every name is checked against the
 * provider's `configSchema` at registration, and the two token fields against its `secretFields`.
 */
export interface StaticRunCredentialSupport {
  /** `minted | static`; the default (absent) is `minted`. GitLab: `run_credential`. */
  readonly modeField: string;
  /** The run token's secret field. GitLab: `run_token`. Read only by the run-credential path. */
  readonly tokenField: string;
  /** The binding's API token — the value the run token must never equal. GitLab: `token`. */
  readonly apiTokenField: string;
  /** The username git sends beside the token. GitLab: `run_token_username`. */
  readonly usernameField: string;
  /** The declared expiry, an ISO date (`YYYY-MM-DD`). GitLab: `run_token_expires_at`. */
  readonly expiresAtField: string;
  /** The minting switch that must be off beside `static`. GitLab: `mint_credentials`. */
  readonly mintingField: string;
  /** How far ahead the declared expiry may be at the write. Decision 13: 90 days. */
  readonly maxLifetimeDays: number;
}

/** The value of {@link StaticRunCredentialSupport.modeField} that selects a static credential. */
export const STATIC_RUN_CREDENTIAL_MODE = 'static';

/** One refusal, by the config key it is about — never a value. */
export interface StaticRunCredentialIssue {
  readonly path: string;
  readonly message: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Whether a document (account config, with or without its secrets) selects a static credential. */
export const declaresStaticRunCredential = (
  support: StaticRunCredentialSupport | undefined,
  config: Readonly<Record<string, unknown>>,
): boolean => support !== undefined && config[support.modeField] === STATIC_RUN_CREDENTIAL_MODE;

/**
 * `YYYY-MM-DD` → the instant the credential stops being used: **00:00 UTC on the declared date**,
 * which is GitLab's own reading — *"Personal, group, and project access tokens expire at midnight
 * UTC on the expiry date"* (already cited in `providers/gitlab/credentials.ts`). `null` for anything
 * that is not a calendar date.
 */
export const expiryInstantOf = (date: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  const instant = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== date
    ? null
    : instant.toISOString();
};

/**
 * The refusals a **configuration document** alone can answer (no secret, no clock): `static` with
 * minting switched on, and `static` without a username or a valid expiry. Empty for a document
 * that does not select `static`. Read by every write of `integrations.config` and by the load.
 */
export const staticRunCredentialConfigIssues = (
  support: StaticRunCredentialSupport | undefined,
  config: Readonly<Record<string, unknown>>,
): readonly StaticRunCredentialIssue[] => {
  if (support === undefined || !declaresStaticRunCredential(support, config)) {
    return [];
  }
  const issues: StaticRunCredentialIssue[] = [];
  if (config[support.mintingField] === true) {
    issues.push({
      path: support.mintingField,
      message: `\`${support.modeField}: static\` and \`${support.mintingField}: true\` are both set; an integration gives its runs one kind of credential, so the audit can say which (TD-028 decision 13)`,
    });
  }
  if (text(config[support.usernameField]).trim() === '') {
    issues.push({
      path: support.usernameField,
      message: `\`${support.modeField}: static\` needs \`${support.usernameField}\`, the dedicated user the run token belongs to`,
    });
  }
  if (expiryInstantOf(text(config[support.expiresAtField])) === null) {
    issues.push({
      path: support.expiresAtField,
      message: `\`${support.modeField}: static\` needs \`${support.expiresAtField}\`, the run token's expiry as a date (YYYY-MM-DD); the platform does not ask the provider for it`,
    });
  }
  return issues;
};

/**
 * The refusals of a **write**, which knows the decrypted values and the time: the config issues,
 * plus no run token, a run token equal to the API token, and an expiry passed or more than
 * {@link StaticRunCredentialSupport.maxLifetimeDays} ahead. `secrets` is the integration's whole
 * credential set **after** the write (the sealed fields merged with the ones the write seals).
 */
export const staticRunCredentialWriteIssues = (
  support: StaticRunCredentialSupport | undefined,
  config: Readonly<Record<string, unknown>>,
  secrets: Readonly<Record<string, string>>,
  now: Date,
): readonly StaticRunCredentialIssue[] => {
  if (support === undefined || !declaresStaticRunCredential(support, config)) {
    return [];
  }
  const issues = [...staticRunCredentialConfigIssues(support, config)];
  const token = secrets[support.tokenField] ?? '';
  if (token.trim() === '') {
    issues.push({
      path: support.tokenField,
      message: `\`${support.modeField}: static\` needs the run token itself, sealed as \`${support.tokenField}\` through \`secret_refs\`; nothing falls back to another credential`,
    });
  } else if (token === (secrets[support.apiTokenField] ?? '')) {
    issues.push({
      path: support.tokenField,
      message: `\`${support.tokenField}\` is the integration's own API token (\`${support.apiTokenField}\`); the run token must be a separate, dedicated token, because the API token is never sent to a workspace (TD-028 decisions 6 and 13)`,
    });
  }
  const expiry = expiryInstantOf(text(config[support.expiresAtField]));
  if (expiry !== null) {
    const latest = now.getTime() + support.maxLifetimeDays * 24 * 60 * 60 * 1000;
    if (new Date(expiry).getTime() <= now.getTime()) {
      issues.push({
        path: support.expiresAtField,
        message: `\`${support.expiresAtField}\` is ${text(config[support.expiresAtField])}, which has passed; create a new run token and declare its expiry`,
      });
    } else if (new Date(expiry).getTime() > latest) {
      issues.push({
        path: support.expiresAtField,
        message: `\`${support.expiresAtField}\` is ${text(config[support.expiresAtField])}, more than ${support.maxLifetimeDays} days ahead; a static run credential lives to its expiry, so it must be a short one (TD-028 decision 13)`,
      });
    }
  }
  return issues;
};

/**
 * The static credential a **loaded** integration declares, for the run-credential path — or
 * `undefined` when it declares none (minting is then the only source). `value` is `''` when the
 * integration declares `static` and holds no run token, and `refusal` carries every config-level
 * fault, so the caller refuses by name rather than guessing (standing rule 18).
 *
 * `merged` is the validated configuration with the secrets merged in, as the loader builds it.
 */
export const staticRunCredentialOf = (
  support: StaticRunCredentialSupport | undefined,
  merged: Readonly<Record<string, unknown>>,
): StaticRunCredential | undefined => {
  if (support === undefined || !declaresStaticRunCredential(support, merged)) {
    return undefined;
  }
  const value = text(merged[support.tokenField]);
  const issues = staticRunCredentialConfigIssues(support, merged);
  return {
    username: text(merged[support.usernameField]),
    value,
    expiresAt: expiryInstantOf(text(merged[support.expiresAtField])),
    declaredExpiry: text(merged[support.expiresAtField]),
    sameAsApiToken: value !== '' && value === text(merged[support.apiTokenField]),
    refusal: issues.length === 0 ? null : issues.map((issue) => issue.message).join('; '),
  };
};

/** `secrets` (or a config) without the run-only token field — what an adapter is built from. */
export const withoutRunOnlyFields = <T>(
  support: StaticRunCredentialSupport | undefined,
  values: Readonly<Record<string, T>>,
): Readonly<Record<string, T>> =>
  support === undefined
    ? values
    : Object.fromEntries(Object.entries(values).filter(([key]) => key !== support.tokenField));
