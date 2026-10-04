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
 *
 * **Whose token** (decision 13a, WP-141): {@link StaticRunCredentialSupport.ownerField} says
 * `dedicated_user` (the default, decision 13) or `operator` — the operator's own token with
 * repository scopes only. Everything above holds for both; what differs is the probe (a role check
 * for the first, a scope proof and the default branch's protection for the second, the latter
 * re-read before each run) and the stated loss: an operator's token reaches every repository its
 * owner can.
 */
import {
  type DeployKeyRunCredential,
  deployKeyPairFault,
  parseSshEd25519PublicKey,
  type SshGitRoute,
  type StaticRunCredential,
} from '@platform/application';

/**
 * Which config keys hold a provider's static run credential. Every name is checked against the
 * provider's `configSchema` at registration, and the two token fields against its `secretFields`.
 */
export interface StaticRunCredentialSupport {
  /**
   * `minted | static` — and, for a provider that declares {@link deployKey}, its value too; the
   * default (absent) is `minted`. GitLab: `run_credential`.
   */
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
  /**
   * `dedicated_user | operator` — whose token the run token is (TD-028 decision 13a, WP-141); the
   * default (absent) is `dedicated_user`. GitLab: `run_token_owner`.
   */
  readonly ownerField: string;
  /**
   * The provider's words for the scope proof's refusal of a token that **can** call the API
   * (decision 13a item 1). GitLab: *"this token can call the GitLab API; create one with only
   * `read_repository` and `write_repository`"*.
   */
  readonly scopeProofHint: string;
  /**
   * A project **SSH deploy key** as a third `modeField` value (TD-028 decision 13b, WP-146) — absent
   * for a provider that offers none.
   */
  readonly deployKey?: DeployKeyRunCredentialSupport;
}

/**
 * Which config keys hold a provider's deploy key (decision 13b item 1). The private key is a secret
 * field (checked at registration), the public key plain configuration.
 */
export interface DeployKeyRunCredentialSupport {
  /** The `modeField` value that selects it. GitLab: `deploy_key`. */
  readonly modeValue: string;
  /** The OpenSSH Ed25519 private key's secret field. GitLab: `run_ssh_private_key`. */
  readonly privateKeyField: string;
  /** The declared `ssh-ed25519 AAAA…` line. GitLab: `run_ssh_public_key`. */
  readonly publicKeyField: string;
  /**
   * The SSH route a run of this integration takes, or the refusal **by name** when the provider has
   * none for the configured host (GitLab: a self-managed instance, decision 13b item 4).
   */
  readonly sshRoute: (config: Readonly<Record<string, unknown>>) => SshGitRoute | string;
}

/** Whose personal access token a static run credential is (TD-028 decisions 13 and 13a). */
export type StaticRunTokenOwner = 'dedicated_user' | 'operator';

/** The value of {@link StaticRunCredentialSupport.ownerField} that selects the operator's own token. */
export const OPERATOR_RUN_TOKEN_OWNER = 'operator';

/** The owner a document declares — `dedicated_user` unless it says `operator`. */
export const runTokenOwnerOf = (
  support: StaticRunCredentialSupport,
  config: Readonly<Record<string, unknown>>,
): StaticRunTokenOwner =>
  config[support.ownerField] === OPERATOR_RUN_TOKEN_OWNER ? 'operator' : 'dedicated_user';

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
  if (support === undefined) {
    return [];
  }
  if (!declaresStaticRunCredential(support, config)) {
    // WP-141: an owner says whose static token it is, so it means nothing for any other source —
    // and a reader who sees `operator` beside `minted` would believe the wrong probe ran.
    // WP-146: a deploy key's own configuration rules (decision 13b) are read in the same place, so
    // every write and the load that ask this question ask them too.
    return [
      ...(runTokenOwnerOf(support, config) === 'operator'
        ? [
            {
              path: support.ownerField,
              message: `\`${support.ownerField}: operator\` applies only to \`${support.modeField}: static\`; it says whose run token is handed to runs, and this integration hands none (TD-028 decision 13a)`,
            },
          ]
        : []),
      ...deployKeyConfigIssues(support, config),
    ];
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
      message: `\`${support.modeField}: static\` needs \`${support.usernameField}\`, the ${
        runTokenOwnerOf(support, config) === 'operator' ? 'operator' : 'dedicated user'
      } the run token belongs to`,
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
  const privateKeyField = support.deployKey?.privateKeyField;
  const issues = [
    ...staticRunCredentialConfigIssues(support, merged),
    // WP-146: a deploy key sealed beside the run token is refused at use as at the write.
    ...(privateKeyField === undefined
      ? []
      : deployKeyWriteIssues(support, merged, {
          [privateKeyField]: text(merged[privateKeyField]),
        })),
  ];
  return {
    owner: runTokenOwnerOf(support, merged),
    username: text(merged[support.usernameField]),
    value,
    expiresAt: expiryInstantOf(text(merged[support.expiresAtField])),
    declaredExpiry: text(merged[support.expiresAtField]),
    sameAsApiToken: value !== '' && value === text(merged[support.apiTokenField]),
    refusal: issues.length === 0 ? null : issues.map((issue) => issue.message).join('; '),
  };
};

/** Whether a document selects the provider's deploy key (TD-028 decision 13b, WP-146). */
export const declaresDeployKeyRunCredential = (
  support: StaticRunCredentialSupport | undefined,
  config: Readonly<Record<string, unknown>>,
): boolean =>
  support?.deployKey !== undefined && config[support.modeField] === support.deployKey.modeValue;

/**
 * Whether a document hands its runs a credential **of its own** — a static run token or a deploy
 * key — and may therefore be bound by one project only (decisions 13 item 1 and 13b item 1).
 */
export const declaresDedicatedRunCredential = (
  support: StaticRunCredentialSupport | undefined,
  config: Readonly<Record<string, unknown>>,
): boolean =>
  declaresStaticRunCredential(support, config) || declaresDeployKeyRunCredential(support, config);

/**
 * The refusals a deploy-key **configuration document** alone can answer: minting switched on, a
 * public key that is not an Ed25519 line, and a host the provider has no SSH route for. Empty for a
 * document that does not select `deploy_key`.
 */
export const deployKeyConfigIssues = (
  support: StaticRunCredentialSupport | undefined,
  config: Readonly<Record<string, unknown>>,
): readonly StaticRunCredentialIssue[] => {
  const deployKey = support?.deployKey;
  if (
    support === undefined ||
    deployKey === undefined ||
    !declaresDeployKeyRunCredential(support, config)
  ) {
    return [];
  }
  const issues: StaticRunCredentialIssue[] = [];
  if (config[support.mintingField] === true) {
    issues.push({
      path: support.mintingField,
      message: `\`${support.modeField}: ${deployKey.modeValue}\` and \`${support.mintingField}: true\` are both set; an integration gives its runs one kind of credential, so the audit can say which (TD-028 decision 13b)`,
    });
  }
  if (parseSshEd25519PublicKey(text(config[deployKey.publicKeyField])) === null) {
    issues.push({
      path: deployKey.publicKeyField,
      message: `\`${support.modeField}: ${deployKey.modeValue}\` needs \`${deployKey.publicKeyField}\`, the deploy key's \`ssh-ed25519 AAAA…\` line (an Ed25519 key; this build signs with no other type)`,
    });
  }
  const route = deployKey.sshRoute(config);
  if (typeof route === 'string') {
    issues.push({ path: support.modeField, message: route });
  }
  return issues;
};

/**
 * The refusals of a deploy-key **write** (decision 13b item 1): the configuration's, plus no private
 * key, a key that is not an unencrypted Ed25519 one or not the declared public key's, and a run token
 * sealed beside it (*"`run_token` and the key are mutually exclusive"*). For a `static` document the
 * one rule in the other direction: a sealed private key beside it is refused too.
 */
export const deployKeyWriteIssues = (
  support: StaticRunCredentialSupport | undefined,
  config: Readonly<Record<string, unknown>>,
  secrets: Readonly<Record<string, string>>,
): readonly StaticRunCredentialIssue[] => {
  const deployKey = support?.deployKey;
  if (support === undefined || deployKey === undefined) {
    return [];
  }
  const privateKey = secrets[deployKey.privateKeyField] ?? '';
  const exclusive = (path: string): StaticRunCredentialIssue => ({
    path,
    message: `\`${support.tokenField}\` and \`${deployKey.privateKeyField}\` are both sealed; an integration gives its runs one kind of credential — remove the one its \`${support.modeField}\` does not use (TD-028 decision 13b)`,
  });
  if (declaresStaticRunCredential(support, config)) {
    return privateKey.trim() === '' ? [] : [exclusive(deployKey.privateKeyField)];
  }
  if (!declaresDeployKeyRunCredential(support, config)) {
    return [];
  }
  const issues = [...deployKeyConfigIssues(support, config)];
  if ((secrets[support.tokenField] ?? '').trim() !== '') {
    issues.push(exclusive(support.tokenField));
  }
  if (privateKey.trim() === '') {
    issues.push({
      path: deployKey.privateKeyField,
      message: `\`${support.modeField}: ${deployKey.modeValue}\` needs the private key itself, sealed as \`${deployKey.privateKeyField}\` through \`secret_refs\`; nothing falls back to another credential`,
    });
    return issues;
  }
  const fault = deployKeyPairFault(privateKey, text(config[deployKey.publicKeyField]));
  if (fault !== null && !issues.some((issue) => issue.path === deployKey.publicKeyField)) {
    issues.push({ path: deployKey.privateKeyField, message: fault });
  }
  return issues;
};

/**
 * The deploy key a **loaded** integration declares, for the run-credential path — or `undefined`
 * when it declares none. Every fault is carried as `refusal`, so a declared-but-broken key is refused
 * by name at use rather than becoming "no credential" (standing rule 18).
 */
export const deployKeyRunCredentialOf = (
  support: StaticRunCredentialSupport | undefined,
  merged: Readonly<Record<string, unknown>>,
): DeployKeyRunCredential | undefined => {
  const deployKey = support?.deployKey;
  if (
    support === undefined ||
    deployKey === undefined ||
    !declaresDeployKeyRunCredential(support, merged)
  ) {
    return undefined;
  }
  const secrets = Object.fromEntries(
    [support.tokenField, deployKey.privateKeyField].map((field) => [field, text(merged[field])]),
  );
  const issues = deployKeyWriteIssues(support, merged, secrets);
  const route = deployKey.sshRoute(merged);
  return {
    privateKey: text(merged[deployKey.privateKeyField]),
    publicKey: text(merged[deployKey.publicKeyField]).trim(),
    route: typeof route === 'string' ? null : route,
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
    : Object.fromEntries(
        Object.entries(values).filter(
          // WP-146: the deploy key's private half is a run-only field too (decision 13b item 2).
          ([key]) => key !== support.tokenField && key !== support.deployKey?.privateKeyField,
        ),
      );
