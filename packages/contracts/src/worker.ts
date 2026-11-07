/**
 * The worker protocol's contract — TD-031 decisions 4, 9 and 11, and TD-032 decision 7 (WP-273).
 *
 * A remote worker (BD-032) speaks a short-poll HTTPS protocol to the core under
 * {@link WORKER_API_PREFIX} and receives a **run package** the core decided. This module is that
 * contract and nothing else: there is no route, no table and no worker process behind it yet
 * (WP-280 to WP-284 serve it). It lives in `@platform/contracts` because both halves — the core's
 * routes and the worker's client — must read the same bytes (standing rule 63), and the worker
 * runs from the same image one protocol version apart at most.
 *
 * ## Two spellings, each stated
 *
 * - **The HTTP DTOs are snake_case**, the house rule for API DTOs (`CLAUDE.md`, technical/08). TD-031
 *   §9 names no field spelling except `compose_url` and `resets_at`, which are snake_case already.
 * - **The run package is camelCase** ({@link runPackageSchema}), the same stated deviation the
 *   launcher's control plane makes (`packages/infrastructure/src/launcher/protocol.ts`, TD-028's
 *   WP-53 note) and for the same reason: its vocabulary *is* `RunSpec` and `WorkspaceSpec`
 *   (`./run-spec.ts`), and a snake_case re-spelling of them for this hop would be a second schema
 *   for one structure. TD-031 §4 states it; technical/08's TD-031 amendment repeats it.
 *
 * ## The two error bodies
 *
 * `426 upgrade_required` and `409 lease_lost` are {@link apiErrorSchema}'s envelope — every non-2xx
 * answer of the API is — and the 426 adds TD-031 §9's three fields beside it (`accepted`,
 * `compose_url`, `digests`). The device flow's token poll is the one exception: TD-031 §10c asks for
 * RFC 8628's shape, whose error body is `{ "error": "<code>" }` (RFC 8628 §3.5, RFC 6749 §5.2), so
 * {@link workerDeviceTokenErrorSchema} is that and not the envelope.
 *
 * ## Protocol versions (TD-032 decision 7)
 *
 * {@link WORKER_PROTOCOL_VERSION} is an integer independent of the build. The core accepts
 * {@link ACCEPTED_WORKER_PROTOCOLS} — `[N-1, N]`, which at `N = 4` is `[3, 4]` (S-26.4) — and answers anything
 * else `426`. A change ships expand → contract: the release that adds a field or a verb accepts both
 * shapes, and the release that removes the old one bumps `N`. `pnpm protocol:check`
 * (`scripts/check-protocol.ts`, a `verify:static` step) refuses a bump that is not `base + 1`, one
 * whose accepted list drops the base's value, and one whose base itself bumped over its predecessor.
 * The check reads this file's two literals as text at the base commit, so **they stay literals**:
 * `export const WORKER_PROTOCOL_VERSION = <int>;` and `export const ACCEPTED_WORKER_PROTOCOLS = [<ints>] as const;`.
 */
import * as z from 'zod';
import { apiErrorSchema, cancelRunRequestSchema, cancelRunResponseSchema } from './api.js';
import {
  agentRoleSchema,
  httpUrlSchema,
  idSchema,
  isoDateTimeSchema,
  modelUsageSchema,
  nonEmptyStringSchema,
  runCostSchema,
  runSavedWorkSchema,
  runStartFailureSchema,
  runTerminalReasonSchema,
  sequenceSchema,
  shaSchema,
  tokenCountSchema,
  tokenUsageSchema,
} from './common.js';
import {
  jsonObjectSchema,
  jsonValueSchema,
  sha256HexSchema,
  taskOwnerViewSchema,
} from './records.js';
import {
  platformSkillNameSchema,
  runCredentialIssues,
  runCredentialSchema,
  runSpecSchema,
  secretInEnvironment,
  workspaceSpecSchema,
} from './run-spec.js';

// ── Versions ─────────────────────────────────────────────────────────────────

/** The protocol this build speaks (TD-032 decision 7). A literal: `protocol:check` reads it as text. */
export const WORKER_PROTOCOL_VERSION = 4;

/**
 * The protocols this build's core serves: `[N-1, N]`, without a `0`. A literal for the same reason as
 * {@link WORKER_PROTOCOL_VERSION}; `worker.test.ts` holds it to the shape.
 */
export const ACCEPTED_WORKER_PROTOCOLS = [3, 4] as const;

/**
 * The first protocol that carries the worker's local UI (TD-031's 2026-11-04 worker-UI amendment §5,
 * WP-292): the verbs `manual-pause` and `runs/:id/cancel`, the handshake's
 * `worker.manually_paused_at` and the package's `display` block. A request at a lower version is
 * answered the version-1 shapes — every schema here is strict, so a version-1 worker would refuse
 * an unknown key — and is refused the two verbs with `426`.
 */
export const WORKER_PROTOCOL_LOCAL_UI = 2;

/**
 * The first protocol that carries the claim scope and *take this one* (TD-031's 2026-11-05
 * claim-scope amendment, decision 6; WP-293): the verbs `GET`/`PUT claim-scope`, `GET offers` and
 * `POST offers/:id/claim`, and the handshake's `worker.claim_project_ids`. A request at a lower
 * version is refused the four verbs with `426` and is sent a handshake without the key.
 */
export const WORKER_PROTOCOL_CLAIM_SCOPE = 3;

/**
 * The first protocol that carries the claim **policy** and a pick that assigns (S-26.4, TD-031's
 * 2026-11-06 amendment items 6–7): the handshake's `worker.claim_policy`, `claim-scope`'s
 * `claim_policy` (read and written) and `policy_skipped_offers`, `offers`' `as_of`, `owner`, `mine`
 * and `policy_skipped_offers`, and the pick body's `as_of` with its two refusals
 * `task_taken_by_another` and `task_owned_by_another`. A version-3 worker is sent none of the keys
 * (every schema here is strict), its `PUT claim-scope` with `[]` is stored as `pick_only` over every
 * project and leaves the policy as it was otherwise, and both pick refusals reach it as
 * `offer_not_claimable`.
 */
export const WORKER_PROTOCOL_CLAIM_POLICY = 4;

/** Whether a worker announcing `version` is served by this build (else `426 upgrade_required`). */
export const isAcceptedWorkerProtocol = (version: number): boolean =>
  (ACCEPTED_WORKER_PROTOCOLS as readonly number[]).includes(version);

/** The request header every worker call carries (TD-031 §9). Lowercase: Node's header spelling. */
export const WORKER_PROTOCOL_HEADER = 'x-worker-protocol';

/**
 * The header's value: a positive decimal integer with no sign, no leading zero and no whitespace.
 * Anything else — absent included — is not a protocol the core accepts, and is answered `426`.
 */
export const workerProtocolHeaderSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,8}$/, 'expected a positive decimal protocol version');

/** The header's version, or `null` when it is absent or not {@link workerProtocolHeaderSchema}. */
export const parseWorkerProtocolHeader = (
  value: string | readonly string[] | undefined,
): number | null => {
  if (typeof value !== 'string') return null;
  return workerProtocolHeaderSchema.safeParse(value).success ? Number(value) : null;
};

/** `{ current, accepted }`: what `handshake` and `GET release` advertise. */
export const workerProtocolRangeSchema = z.strictObject({
  current: z.int().positive(),
  accepted: z.array(z.int().positive()).min(1).max(2),
});
export type WorkerProtocolRange = z.infer<typeof workerProtocolRangeSchema>;

// ── Paths and bounds ─────────────────────────────────────────────────────────

/** Every worker route is under this prefix (TD-031 §9). */
export const WORKER_API_PREFIX = '/api/worker/v1';

/** The verbs of TD-031 §9, relative to {@link WORKER_API_PREFIX}; `:id` is a run id. */
export const WORKER_PATHS = {
  device: 'device',
  deviceToken: 'device/token',
  handshake: 'handshake',
  claims: 'claims',
  heartbeat: 'runs/:id/heartbeat',
  transcript: 'runs/:id/transcript',
  tool: 'runs/:id/tools/:name',
  approvals: 'runs/:id/approvals',
  session: 'runs/:id/session',
  sshSign: 'runs/:id/ssh-sign',
  runRelease: 'runs/:id/release',
  /** The CLI spawn marker (TD-031's 2026-11-04 amendment §4): answered before the `spawn` frame. */
  spawn: 'runs/:id/spawn',
  finish: 'runs/:id/finish',
  lateCost: 'runs/:id/late-cost',
  pause: 'pause',
  /** The owner's hold on claiming, from the worker's local page (WP-292, protocol 2). */
  manualPause: 'manual-pause',
  /** A person's cancel from the worker's local page — the core's `run.cancel` (WP-292, protocol 2). */
  runCancel: 'runs/:id/cancel',
  /** The worker's claim scope, read and set by its owner (WP-293, protocol 3). */
  claimScope: 'claim-scope',
  /** The open offers this worker could claim now, scope ignored (WP-293, protocol 3). */
  offers: 'offers',
  /** *Take this one*: the one claim narrowed to one run, scope ignored (WP-293, protocol 3). */
  offerClaim: 'offers/:id/claim',
  release: 'release',
  composeFile: 'compose.yml',
  /** The one-command install for macOS and Linux, public like `compose.yml` (S-22.20). */
  installSh: 'install.sh',
  /** The one-command install for Windows PowerShell 5.1 and 7, public like `compose.yml` (S-22.20). */
  installPs1: 'install.ps1',
  updateReport: 'update-report',
} as const;

/** A claim scope names at most this many projects (WP-293). */
export const WORKER_CLAIM_SCOPE_MAX_PROJECTS = 100;
/** `GET claim-scope` lists at most this many projects to choose from (WP-293). */
export const WORKER_SCOPE_PROJECTS_MAX = 500;
/** `GET offers` lists at most this many open offers (TD-031's claim-scope amendment, decision 4). */
export const WORKER_OFFERS_LIST_MAX = 50;

/** A run package past this many bytes of JSON is refused, never truncated (TD-031 §4). */
export const WORKER_PACKAGE_MAX_BYTES = 4 * 1024 * 1024;
/** One `transcript` batch's bound (TD-031 §9). Enforced on the body by the route (WP-282). */
export const WORKER_TRANSCRIPT_BATCH_MAX_BYTES = 256 * 1024;
/**
 * One `session` batch's bound on the wire (WP-282): the route's body limit, so a worker chunks the
 * session file's lines below it. A single line may be at most 1 MiB ({@link workerSessionRequestSchema}).
 */
export const WORKER_SESSION_BATCH_MAX_BYTES = 4 * 1024 * 1024;
/** How long `claims` is held before it answers `204` (TD-031 §9). */
export const WORKER_CLAIM_HOLD_MS = 25_000;
/** How long `heartbeat` is held before it answers with nothing pending (TD-031 §9). */
export const WORKER_HEARTBEAT_HOLD_MS = 20_000;
/** A remote run's lease (TD-031 §9; the server's runner keeps `RUN_LEASE_TTL_MS`, 5 min). */
export const WORKER_REMOTE_LEASE_TTL_MS = 10 * 60_000;
/**
 * A remote run's renewal bound (TD-031 §2): the heartbeat is held ≤ {@link WORKER_HEARTBEAT_HOLD_MS}
 * and re-issued at once, so a renewal lands about every 20 s on a healthy link and 30 s is the
 * declared bound the self-termination rule is computed from (`TTL − ½·renew` = 585 s).
 */
export const WORKER_REMOTE_LEASE_RENEW_MS = 30_000;
/**
 * How long a run token keeps authenticating after its run is terminal (TD-031 §7): fifteen minutes,
 * for `late-cost` — a worker that comes back after the sweep reports what its run burned (Q70 (b)).
 */
export const WORKER_RUN_TOKEN_AFTER_END_MS = 15 * 60_000;

// ── Shared pieces ────────────────────────────────────────────────────────────

/** An OCI image digest: `sha256:` and 64 lowercase hex characters. Never a tag. */
export const imageDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected an image digest sha256:<64 hex>');

/** The core's four product images by digest (TD-032 decision 3), what `handshake`/`release`/`426` name. */
export const coreImageDigestsSchema = z.strictObject({
  platform: imageDigestSchema,
  platform_launcher: imageDigestSchema,
  platform_runtime: imageDigestSchema,
  platform_egress: imageDigestSchema,
});
export type CoreImageDigests = z.infer<typeof coreImageDigestsSchema>;

/** The digests a worker holds locally; at most this many are reported. */
export const MAX_REPORTED_IMAGE_DIGESTS = 64;
const heldDigestsSchema = z.array(imageDigestSchema).max(MAX_REPORTED_IMAGE_DIGESTS);

/** `(run_id, epoch)`'s second half: incremented by every claim, `0` never claimed (TD-031 §2). */
export const leaseEpochSchema = z.int().positive();

/** 32 random bytes in unpadded base64url — 43 characters — the shape of a device code and a run token. */
const random32Schema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'expected 32 bytes of unpadded base64url');

/** The run token (TD-031 §7): authenticates every run-scoped call, never enters the container. */
export const runTokenSchema = random32Schema;

/**
 * The worker credential, `wkr_<base32 id>_<43 base64url chars>` (TD-031 §7). The id is a uuid's
 * 128 bits in lowercase RFC 4648 base32 without padding — 26 characters (an assumption WP-280 pins).
 */
export const workerCredentialSchema = z
  .string()
  .regex(/^wkr_[a-z2-7]{26}_[A-Za-z0-9_-]{43}$/, 'expected wkr_<base32 id>_<43 base64url>');

// ── The run package (TD-031 §4) — camelCase, stated above ────────────────────

/**
 * The environment names that carry a **model** credential. The core never puts one in a package
 * (TD-031 §4): the worker adds `CLAUDE_CODE_OAUTH_TOKEN` from its own environment, locally.
 */
export const MODEL_CREDENTIAL_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/**
 * Value prefixes no package environment may contain: an Anthropic key or OAuth token (`sk-ant-`)
 * and a worker credential (`wkr_`). Defence in depth beside the exact-value rules; the shipped
 * pattern redactor (`packages/infrastructure/src/redaction`) is the wider list and is not reachable
 * from this ring.
 */
export const SECRET_ENV_VALUE_PREFIXES = ['sk-ant-', 'wkr_'] as const;

/** A path inside one skill's directory: relative, `/`-separated, no `.`/`..` segment. */
const skillFilePathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/,
    'expected a relative file path',
  )
  .refine(
    (path) => !path.split('/').some((segment) => segment === '..' || segment === '.'),
    'no dot segments',
  );

/** The digest `skillSetVersionOf` folds into `prompt_version`: `skills@<16 hex>` or `skills@none`. */
export const skillSetDigestSchema = z
  .string()
  .regex(/^skills@(?:none|[0-9a-f]{16})$/, 'expected skills@<16 hex> or skills@none');

/** A platform skill's declared version (`PLATFORM_SKILL_VERSIONS`): what the set's digest folds in. */
const skillVersionSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/, 'expected a declared skill version');

/**
 * The one file of a skill the set's digest covers: `skillSetVersionOf` folds each skill's name, its
 * declared version and its `SKILL.md` — nothing else — so a skill carries that file and no other
 * (WP-279): a second file would reach the run with no digest that says which bytes it was.
 */
export const SKILL_FILE = 'SKILL.md';

/**
 * The skills' **content** (TD-031 §4): name → relative path → text, with the set's digest — and,
 * since WP-279, each skill's declared version, because the digest is `skillSetVersionOf`'s over
 * `(name, version, SKILL.md)` and a receiver cannot recompute it without the version. The launcher
 * recomputes it and refuses a mismatch (`workspace/skills.ts`); this schema holds the shape.
 */
export const runSkillsSchema = z.strictObject({
  digest: skillSetDigestSchema,
  files: z.record(
    platformSkillNameSchema,
    z.record(skillFilePathSchema, z.string().max(256 * 1024)),
  ),
  versions: z.record(platformSkillNameSchema, skillVersionSchema),
});
export type RunSkills = z.infer<typeof runSkillsSchema>;

/**
 * Why a skills block does not fit the skill names it travels with — one message per refusal, empty
 * when it fits (WP-279). The run package and the launcher's create request apply the same rules: the
 * content of **exactly** the named skills, a version for exactly those, and each skill's one
 * {@link SKILL_FILE}. Whether the digest is right is the receiver's to recompute (`@platform/domain`).
 */
export const runSkillsIssues = (skills: RunSkills, names: readonly string[]): string[] => {
  const issues: string[] = [];
  const named = [...names].sort();
  const same = (keys: string[]): boolean =>
    keys.length === named.length && keys.every((name, index) => name === named[index]);
  if (!same(Object.keys(skills.files).sort())) {
    issues.push('the skills carried are exactly the skills the WorkspaceSpec names');
  }
  if (!same(Object.keys(skills.versions).sort())) {
    issues.push('a version is carried for exactly the skills the WorkspaceSpec names');
  }
  for (const [name, files] of Object.entries(skills.files)) {
    const paths = Object.keys(files);
    if (paths.length !== 1 || paths[0] !== SKILL_FILE) {
      issues.push(
        `skill ${name} carries ${SKILL_FILE} and nothing else: the set's digest covers no other file (WP-279)`,
      );
    }
  }
  if ((skills.digest === 'skills@none') !== (named.length === 0)) {
    issues.push('skills@none is the digest of the empty set, and only of it');
  }
  return issues;
};

/** The run and egress images by digest (TD-031 §4; the launcher never pulls at create). */
export const runImagesSchema = z.strictObject({
  run: imageDigestSchema,
  egress: imageDigestSchema,
});
export type RunImages = z.infer<typeof runImagesSchema>;

/**
 * What the worker's local page names a run by (WP-292, protocol 2): the project's key, the ticket's
 * key and the ticket's title — from the core's **redacted** ticket snapshot (WP-15f), so the title
 * is untrusted text that has already passed the platform's redaction and is rendered as text
 * (BD-022). `title` is `null` for a task with no snapshot. Sent only to a worker at protocol ≥ 2.
 */
export const runDisplaySchema = z.strictObject({
  projectKey: nonEmptyStringSchema.max(64),
  ticketKey: nonEmptyStringSchema.max(256),
  title: z.string().max(500).nullable(),
});
export type RunDisplay = z.infer<typeof runDisplaySchema>;

const textEncoder = new TextEncoder();

/**
 * One run, as the core decided it and a worker executes it (TD-031 §4).
 *
 * - `run` is the `RunSpec` **minus every secret value**: `secretEnvNames` is empty, no model
 *   credential is named in `env`, and no value carries the run credential, the run token or a
 *   {@link SECRET_ENV_VALUE_PREFIXES} prefix. `workspacePath` and `claudeCodePath` are the core's
 *   values and the worker's own provisioning answers them locally, as the server's runner does.
 * - `workspace` is the launcher's `WorkspaceSpec`, and `credential` the run credential, held to the
 *   launcher's own credential rules ({@link runCredentialIssues}, the rules `createRunRequestSchema`
 *   applies) **except** that a deploy key never travels: a package for an SSH run carries no
 *   credential and the worker forwards `ssh.sign` to the core (TD-031 §5).
 * - `skills` is the content of exactly the skills `workspace.skills` names ({@link runSkillsIssues}).
 * - `runId`, `epoch`, `runToken`: the fence and the authentication of every run-scoped call.
 *
 * Bounded at {@link WORKER_PACKAGE_MAX_BYTES} of JSON, refused past it.
 */
export const runPackageSchema = z
  .strictObject({
    runId: idSchema,
    epoch: leaseEpochSchema,
    runToken: runTokenSchema,
    run: runSpecSchema,
    workspace: workspaceSpecSchema,
    credential: runCredentialSchema.nullable(),
    skills: runSkillsSchema,
    images: runImagesSchema,
    limits: z.strictObject({
      /** The lease the claim granted; TD-031 §9's 10 minutes for a remote claimant. */
      leaseTtlMs: z
        .int()
        .positive()
        .max(60 * 60_000),
    }),
    /** The local page's names for the run — protocol ≥ 2 only ({@link runDisplaySchema}). */
    display: runDisplaySchema.optional(),
  })
  .superRefine((pkg, context) => {
    const refuse = (path: (string | number)[], message: string): void => {
      context.addIssue({ code: 'custom', message, path });
    };
    if (pkg.run.runId !== pkg.runId || pkg.workspace.runId !== pkg.runId) {
      refuse(['runId'], 'the package, its RunSpec and its WorkspaceSpec name one run');
    }
    if (pkg.run.projectId !== pkg.workspace.projectId) {
      refuse(['workspace', 'projectId'], 'the RunSpec and the WorkspaceSpec name one project');
    }
    if (pkg.run.secretEnvNames.length > 0) {
      refuse(
        ['run', 'secretEnvNames'],
        'a run package carries no secret value, so it names no secret environment variable (TD-031 §4)',
      );
    }
    // What this schema cannot check, stated (review round 2): the prose fields — `userPrompt`,
    // `systemPromptAppend`, `agents[*].prompt`, `contextPack[*].reason`, `commandPolicy` — are
    // platform-assembled and redacted before a package is built (TD-012); a schema cannot tell a
    // secret from prose, so their safety is the planner's redaction, not this refinement.
    // `mcpServers` is opaque per-provider configuration (an `env`, a `headers.Authorization`), so no
    // shape check can tell a secret in it from a setting: a package carries none (review round 1).
    // No planner fills it today; an MCP server for a remote run needs a decision on how its
    // credential reaches the worker before this refusal is relaxed.
    if (Object.keys(pkg.run.mcpServers).length > 0) {
      refuse(
        ['run', 'mcpServers'],
        'a run package carries no MCP server configuration: it is opaque and may hold a credential (TD-031 §4)',
      );
    }
    // A repository URL can carry a credential in its userinfo (`https://oauth2:<token>@host/…`);
    // `projects.repo_url` accepts one, and in a package it would reach a remote machine (review
    // round 2). A password is refused in any scheme, and a username on http(s); `ssh://git@host/…`
    // names the SSH user, and the scp-like `git@host:path` form is not a URL and carries no password.
    const repoUrl = pkg.workspace.repo?.url;
    if (repoUrl !== undefined) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(repoUrl);
      } catch {
        parsed = null;
      }
      const web = parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
      if (parsed !== null && (parsed.password !== '' || (web && parsed.username !== ''))) {
        refuse(
          ['workspace', 'repo', 'url'],
          'a run package carries no credential in the repository URL (TD-031 §4)',
        );
      }
    }
    const environments: Array<{
      path: (string | number)[];
      env: Readonly<Record<string, string>>;
    }> = [
      { path: ['run', 'env'], env: pkg.run.env },
      { path: ['workspace', 'env'], env: pkg.workspace.env },
    ];
    for (const { path, env } of environments) {
      for (const name of MODEL_CREDENTIAL_ENV_NAMES) {
        if (name in env) {
          refuse(
            [...path, name],
            'the core never puts a model credential in a package (TD-031 §4)',
          );
        }
      }
      for (const [name, value] of Object.entries(env)) {
        if (SECRET_ENV_VALUE_PREFIXES.some((prefix) => value.includes(prefix))) {
          refuse([...path, name], 'a package environment value looks like a credential');
        }
      }
    }
    const envs = environments.map((entry) => entry.env);
    if (pkg.credential !== null && secretInEnvironment(pkg.credential.password, envs)) {
      refuse(
        ['credential'],
        'the credential appears in the package’s environment, which the agent can read',
      );
    }
    if (secretInEnvironment(pkg.runToken, envs)) {
      refuse(
        ['runToken'],
        'the run token appears in the package’s environment; it never enters the container (TD-031 §7)',
      );
    }
    for (const message of runCredentialIssues(pkg.workspace, pkg.credential, 'signed_by_core')) {
      refuse(['credential'], message);
    }
    for (const message of runSkillsIssues(pkg.skills, pkg.workspace.skills)) {
      refuse(['skills'], message);
    }
    if (textEncoder.encode(JSON.stringify(pkg)).length > WORKER_PACKAGE_MAX_BYTES) {
      refuse(
        [],
        `a run package is at most ${WORKER_PACKAGE_MAX_BYTES} bytes of JSON; it is refused, not truncated (TD-031 §4)`,
      );
    }
  });
export type RunPackage = z.infer<typeof runPackageSchema>;

// ── Error bodies (TD-031 §9) ─────────────────────────────────────────────────

/**
 * `426 upgrade_required`: the request's `X-Worker-Protocol` is outside {@link ACCEPTED_WORKER_PROTOCOLS}
 * (or absent). The envelope of every non-2xx answer, plus TD-031 §9's `accepted`, `compose_url` and
 * `digests`; the worker stops claiming and finishes nothing it has not started (TD-032 decision 5).
 */
export const workerUpgradeRequiredBodySchema = z.strictObject({
  error: apiErrorSchema.shape.error.extend({ code: z.literal('upgrade_required') }),
  accepted: z.array(z.int().positive()).min(1).max(2),
  compose_url: httpUrlSchema,
  /**
   * The core's four digests, or `null` while the core cannot name them (`digests_unresolved`,
   * WP-281): the refusal still reaches the worker, which stops claiming either way (TD-032 §5).
   */
  digests: coreImageDigestsSchema.nullable(),
});
export type WorkerUpgradeRequiredBody = z.infer<typeof workerUpgradeRequiredBodySchema>;

/**
 * `409 lease_lost`: the call's epoch is not the run's current one, or its lease is gone (TD-031 §2,
 * §12). The worker stops the session and destroys the workspace at once; a `401` on a run-scoped call
 * means the same (TD-031 §7).
 */
export const workerLeaseLostBodySchema = z.strictObject({
  error: apiErrorSchema.shape.error.extend({ code: z.literal('lease_lost') }),
});
export type WorkerLeaseLostBody = z.infer<typeof workerLeaseLostBodySchema>;

// ── Device flow (TD-031 §10c, RFC 8628's shape) ──────────────────────────────

/**
 * The user code's alphabet: 20 consonants, so no vowel spells a word and no `0/O`, `1/I` pair is
 * confusable — RFC 8628 §6.1's example alphabet (`BCDFGHJKLMNPQRSTVWXZ`).
 */
export const WORKER_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

/** `XXXX-XXXX` over {@link WORKER_USER_CODE_ALPHABET} (TD-031 §10c). */
export const workerUserCodeSchema = z
  .string()
  .regex(
    new RegExp(`^[${WORKER_USER_CODE_ALPHABET}]{4}-[${WORKER_USER_CODE_ALPHABET}]{4}$`),
    'expected XXXX-XXXX over the user-code alphabet',
  );

/** `POST device` takes no field: the machine is named by the person who approves it. */
export const workerDeviceRequestSchema = z.strictObject({});

/** `POST device` → RFC 8628 §3.2's response; `interval` 5 and `expires_in` 600 (TD-031 §10c). */
export const workerDeviceResponseSchema = z.strictObject({
  device_code: random32Schema,
  user_code: workerUserCodeSchema,
  verification_uri: httpUrlSchema,
  interval: z.int().positive(),
  expires_in: z.int().positive(),
});
export type WorkerDeviceResponse = z.infer<typeof workerDeviceResponseSchema>;

/** `POST device/token`: the worker's poll. */
export const workerDeviceTokenRequestSchema = z.strictObject({ device_code: random32Schema });

/** `POST device/token` → the worker credential, answered **once** (TD-031 §7, §10c). */
export const workerDeviceTokenResponseSchema = z.strictObject({
  worker_id: idSchema,
  credential: workerCredentialSchema,
});
export type WorkerDeviceTokenResponse = z.infer<typeof workerDeviceTokenResponseSchema>;

/** RFC 8628 §3.5's four outcomes of a poll that yields no credential. */
export const workerDeviceTokenErrorCodeSchema = z.enum([
  'authorization_pending',
  'slow_down',
  'access_denied',
  'expired_token',
]);

/** RFC 8628's error body (RFC 6749 §5.2) — the one worker answer that is not the API envelope. */
export const workerDeviceTokenErrorSchema = z.strictObject({
  error: workerDeviceTokenErrorCodeSchema,
  error_description: z.string().max(500).optional(),
});

// ── The claim policy (S-26.4, protocol 4) ────────────────────────────────────

/**
 * **What a worker's automatic claims take** (S-26.4, TD-031's 2026-11-06 amendment item 6, BD-032's
 * 2026-11-06 amendment 2) — `workers.claim_policy`, migration 0108, set by the worker's owner only:
 *
 * - `everything` — any task of the projects it may take (what a worker connected before the policy
 *   keeps, unless it was *pick only*);
 * - `mine_and_unassigned` — the tasks its user owns, and the tasks nobody owns that are not held
 *   elsewhere (the default for a new worker);
 * - `mine` — only the tasks its user owns; an ask is its user's when they asked it;
 * - `pick_only` — nothing by itself: a run starts only when its owner picks it.
 *
 * Orthogonal to the claim scope (`claim_project_ids`), which stays the project axis and narrows
 * each of them.
 */
export const WORKER_CLAIM_POLICIES = [
  'everything',
  'mine_and_unassigned',
  'mine',
  'pick_only',
] as const;
export const workerClaimPolicySchema = z.enum(WORKER_CLAIM_POLICIES);
export type WorkerClaimPolicy = z.infer<typeof workerClaimPolicySchema>;

/**
 * Open offers the worker's eligibility and claim scope admit and its **policy** refuses — what a
 * `mine` machine is idle by choice over (TD-031's amendment item 6: not a blocker). `null`: not
 * counted (the core could not name its images).
 */
export const policySkippedOffersSchema = z.int().nonnegative().nullable();

// ── Handshake, claim, pause ──────────────────────────────────────────────────

/** `POST handshake`: what the worker holds and which build it is. */
export const workerHandshakeRequestSchema = z.strictObject({
  image_digests: heldDigestsSchema,
  /** The worker's own build commit, or `null` for a build that does not know it (`pnpm dev`). */
  commit: shaSchema.nullable(),
});

/** Why a worker is paused. `usage_limited` is TD-031 §11's; a further reason is an expansion. */
export const workerPauseReasonSchema = z.enum(['usage_limited']);

/** The worker's settings as the core holds them (TD-031 §7's `workers` row). */
export const workerSettingsSchema = z.strictObject({
  id: idSchema,
  name: nonEmptyStringSchema.max(200),
  concurrency: z.int().positive().max(64),
  paused_until: isoDateTimeSchema.nullable(),
  paused_reason: workerPauseReasonSchema.nullable(),
  /**
   * When the worker's owner paused claiming from the local page (WP-292), `null` while not paused.
   * **Absent** at protocol 1: the core sends it only when `X-Worker-Protocol ≥ 2` (TD-031's
   * worker-UI amendment §5).
   */
  manually_paused_at: isoDateTimeSchema.nullable().optional(),
  /**
   * The worker's claim scope (WP-293): `null` every project, otherwise those projects. **Absent**
   * below protocol 3: the core sends it only when `X-Worker-Protocol ≥ 3` (TD-031's 2026-11-05
   * claim-scope amendment, decision 6). Since S-26.4 a version-3 worker is sent `[]` — its *pick
   * only* — for a worker whose policy reads `pick_only`. A version-4 worker is sent the list as
   * stored: `[]` only for a legacy row no write has touched since migration 0108, whose `null`
   * policy then reads `pick_only` and whose `[]` narrows no project.
   */
  claim_project_ids: z.array(idSchema).max(WORKER_CLAIM_SCOPE_MAX_PROJECTS).nullable().optional(),
  /**
   * The worker's claim policy as it reads (S-26.4): the stored value, or what a `null` reads as.
   * **Absent** below protocol 4 ({@link WORKER_PROTOCOL_CLAIM_POLICY}).
   */
  claim_policy: workerClaimPolicySchema.optional(),
});

/**
 * `POST handshake` → the protocol range, the core's digests, the compose bundle's digest, the
 * worker's settings and the server time (TD-031 §9).
 */
export const workerHandshakeResponseSchema = z.strictObject({
  protocol: workerProtocolRangeSchema,
  digests: coreImageDigestsSchema,
  compose_bundle_digest: sha256HexSchema,
  worker: workerSettingsSchema,
  server_time: isoDateTimeSchema,
});
export type WorkerHandshakeResponse = z.infer<typeof workerHandshakeResponseSchema>;

/**
 * `POST claims` (held ≤ {@link WORKER_CLAIM_HOLD_MS}): free slots, digests held, paused state. Answers
 * `200` with a {@link runPackageSchema} or `204` with no body.
 */
export const workerClaimRequestSchema = z.strictObject({
  free_slots: z.int().positive().max(64),
  image_digests: heldDigestsSchema,
  paused: z.boolean(),
});

/**
 * `POST pause` → `{ until, reason, estimated? }` (TD-031 §11, WP-285): the worker hit its usage limit
 * and claims nothing before `until`. `estimated: true` when the limit named no reset time and `until`
 * is the worker's `APP_WORKER_USAGE_PAUSE_DEFAULT` — the UI then says *until about*. Absent is
 * `false`. Answers `204`; a repeat stores the same pause. A person's *Pause* is a different column
 * (`manual-pause`) and is never touched by this verb or by the pause running out.
 */
export const workerPauseRequestSchema = z.strictObject({
  until: isoDateTimeSchema,
  reason: workerPauseReasonSchema,
  estimated: z.boolean().optional(),
});

/**
 * `POST manual-pause` `{ paused, via }` — a **state assertion** (WP-292): the owner's hold on claiming,
 * stored in `workers.manually_paused_at`. Worker credential, protocol ≥ 2. Runs in flight continue.
 */
export const workerManualPauseRequestSchema = z.strictObject({
  paused: z.boolean(),
  /**
   * Who asked, copied into the audit row's `params.via` (TD-031's 2026-11-05 amendment, decision
   * 3): the page’s *Pause* and *Resume* (`worker_ui`), the page's *Drain* (`worker_ui_drain`),
   * `POST /internal/drain` — the updater's or an operator's (`worker_internal_drain`) — and the
   * start-time clear of a drain's pause (`worker_start`).
   */
  via: z.enum(['worker_ui', 'worker_ui_drain', 'worker_internal_drain', 'worker_start']),
});
export type WorkerManualPauseVia = z.infer<typeof workerManualPauseRequestSchema>['via'];

/**
 * `POST manual-pause` → the stored state and whether this call changed it: a repeat of the stored
 * state is `performed: false` and writes nothing (no second `human_actions` row).
 */
export const workerManualPauseResponseSchema = z.strictObject({
  manually_paused_at: isoDateTimeSchema.nullable(),
  performed: z.boolean(),
});
export type WorkerManualPauseResponse = z.infer<typeof workerManualPauseResponseSchema>;

// ── Claim scope and *take this one* (WP-293, protocol 3) ─────────────────────

/**
 * A worker's claim scope (TD-031's 2026-11-05 claim-scope amendment, decision 2): `null` — every
 * project its eligibility admits (the default); otherwise those projects. A conjunct of an
 * **automatic** claim only, and it only narrows. `[]` was *pick only* before the claim policy
 * (S-26.4): a version-3 worker still sends it, and it is stored as the policy `pick_only` over
 * every project; at protocol 4 it is refused.
 */
export const workerClaimScopeSchema = z
  .array(idSchema)
  .max(WORKER_CLAIM_SCOPE_MAX_PROJECTS)
  .nullable();
export type WorkerClaimScope = z.infer<typeof workerClaimScopeSchema>;

/** A project the worker's user may take a run of (`member`+, effective role) — the chooser's entry. */
export const workerScopeProjectSchema = z.strictObject({
  id: idSchema,
  key: nonEmptyStringSchema.max(64),
  name: z.string().max(200),
});
export type WorkerScopeProject = z.infer<typeof workerScopeProjectSchema>;

/**
 * `GET claim-scope` → the stored scope and the projects it may name: those where the worker's user's
 * effective role is `member` or above now, by key. Worker credential, protocol ≥ 3.
 */
export const workerClaimScopeResponseSchema = z.strictObject({
  claim_project_ids: workerClaimScopeSchema,
  projects: z.array(workerScopeProjectSchema).max(WORKER_SCOPE_PROJECTS_MAX),
  /** The policy as it reads (S-26.4). **Absent** below protocol 4. */
  claim_policy: workerClaimPolicySchema.optional(),
  /** Open offers its policy leaves for others (S-26.4). **Absent** below protocol 4. */
  policy_skipped_offers: policySkippedOffersSchema.optional(),
});
export type WorkerClaimScopeResponse = z.infer<typeof workerClaimScopeResponseSchema>;

/**
 * `PUT claim-scope` `{ claim_project_ids }` — a **state assertion** by the worker's owner. An id that
 * is not a project where the user is `member`+ at the write is `422` (decision 2: it keeps the value
 * meaningful; it is not a security check — the claim re-asks the role).
 */
export const workerClaimScopeRequestSchema = z.strictObject({
  claim_project_ids: workerClaimScopeSchema,
  /**
   * The policy to store (S-26.4, protocol 4); absent leaves it as it was. At protocol 4 a
   * `claim_project_ids` of `[]` is `422 claim_scope_empty` — *pick only* is `claim_policy:
   * 'pick_only'` — while a version-3 worker's `[]` is stored as `pick_only` over every project.
   */
  claim_policy: workerClaimPolicySchema.optional(),
});

/**
 * `PUT claim-scope` → the stored scope (ids distinct and sorted) and whether this call changed it: a repeat of the
 * stored value — as a set — is `performed: false` and writes no `human_actions` row.
 */
export const workerClaimScopeSetResponseSchema = z.strictObject({
  claim_project_ids: workerClaimScopeSchema,
  /** The policy as stored now (S-26.4). **Absent** below protocol 4. */
  claim_policy: workerClaimPolicySchema.optional(),
  performed: z.boolean(),
});
export type WorkerClaimScopeSetResponse = z.infer<typeof workerClaimScopeSetResponseSchema>;

/**
 * One open offer this worker could claim **now** (decision 4) — the claim's own eligibility, its
 * scope ignored. `automatic` says whether the scope takes it by itself. The ticket key and the title
 * are untrusted text from the core's **redacted** ticket snapshot, bounded as the package's display
 * block is (BD-022); an `ask` carries its task and stage, **never the question's text**.
 */
export const workerOfferSchema = z.strictObject({
  run_id: idSchema,
  kind: z.enum(['stage', 'ask']),
  /** `null` when the core could not read the run's display names (the package's rule). */
  project_key: z.string().max(64).nullable(),
  ticket_key: z.string().max(256).nullable(),
  title: z.string().max(500).nullable(),
  stage: z.string().max(128).nullable(),
  role: agentRoleSchema,
  offered_at: isoDateTimeSchema,
  /** The worker's claim scope **and** policy take it by themselves (the policy since S-26.4). */
  automatic: z.boolean(),
  /**
   * The task's owner (S-26.4), `null` for nobody — whatever the offer's kind. **Absent** below
   * protocol 4. A pick of a **stage** offer whose task another person owns is refused, so the page
   * offers none; an ask is never refused for its task's owner, and a pick of one assigns nothing.
   */
  owner: taskOwnerViewSchema.nullable().optional(),
  /**
   * The run is this worker's user's (TD-031's amendment item 6): a stage offer of a task they own,
   * or an ask they asked — an ask's "mine" is its asker, never the task's owner. Absent below 4.
   */
  mine: z.boolean().optional(),
  /**
   * The task's tracker assignee is a person the platform cannot match to a member of the project
   * (S-26.1's *held elsewhere*: unlinked, or linked to a non-member), so a pick claims it **without**
   * assigning (TD-031's amendment item 7). Sent only when the worker asks for it —
   * `GET offers?fields=held_elsewhere` ({@link WORKER_OFFERS_HELD_ELSEWHERE_QUERY}, S-26.7) — so a
   * worker built before the field, whose strict parse refuses an unknown key, is never sent it, and
   * a worker that asks an older core gets no field: **absent is unknown**, and the page then promises
   * no assignment.
   */
  held_elsewhere: z.boolean().optional(),
});
export type WorkerOffer = z.infer<typeof workerOfferSchema>;

/**
 * The query a worker adds to `GET offers` to be sent each entry's `held_elsewhere` (S-26.7): an
 * opt-in rather than a protocol bump, because the field is an answer's — the worker asks for it by
 * name, an older worker never asks, and an older core ignores a query it does not read.
 */
export const WORKER_OFFERS_HELD_ELSEWHERE_QUERY = 'fields=held_elsewhere';

/** `GET offers` → at most {@link WORKER_OFFERS_LIST_MAX}, oldest first. */
export const workerOffersResponseSchema = z.strictObject({
  offers: z.array(workerOfferSchema).max(WORKER_OFFERS_LIST_MAX),
  /**
   * The instant the list was read (S-26.4) — what the pick body carries back, so a refusal can tell
   * *taken a moment ago* from *already someone's*. **Absent** below protocol 4.
   */
  as_of: isoDateTimeSchema.optional(),
  /** Open offers its policy leaves for others (S-26.4). **Absent** below protocol 4. */
  policy_skipped_offers: policySkippedOffersSchema.optional(),
});
export type WorkerOffersResponse = z.infer<typeof workerOffersResponseSchema>;

/**
 * `POST offers/:id/claim` `{ image_digests }` — *take this one*: the one claim with its run named,
 * not held. `200` with the run package exactly as `claims` answers it, or `409 offer_not_claimable`
 * for every reason it claimed nothing (taken, withdrawn, not yet this worker's, ineligible).
 */
export const workerOfferClaimRequestSchema = z.strictObject({
  image_digests: heldDigestsSchema,
  /**
   * The list's `as_of` (S-26.4, protocol 4). A task another person owns is refused `409
   * task_taken_by_another` when its owner changed after it, and `409 task_owned_by_another`
   * otherwise (absent included); both name the owner. A version-3 worker is answered
   * `offer_not_claimable` for either.
   */
  as_of: isoDateTimeSchema.optional(),
});

// ── Run-scoped calls (authenticated by the run token) ────────────────────────

/** A `run_commands` refusal a worker may report — the existing four only (TD-031 §14). */
export const runCommandRefusalReasonSchema = z.enum([
  'run_ended',
  'register_miss',
  'delivery_failed',
  'undecodable',
]);

/** One ack of a delivered command: applied, or refused with one of the existing reasons. */
export const workerCommandAckSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ command_id: idSchema, outcome: z.literal('applied') }),
  z.strictObject({
    command_id: idSchema,
    outcome: z.literal('refused'),
    refused_reason: runCommandRefusalReasonSchema,
  }),
]);

/** `POST runs/:id/heartbeat` (held ≤ {@link WORKER_HEARTBEAT_HOLD_MS}): the epoch and the acks. */
export const workerHeartbeatRequestSchema = z.strictObject({
  epoch: leaseEpochSchema,
  acks: z.array(workerCommandAckSchema).max(256),
});

/** A pending `run_commands` row as it is delivered: its kind and its stored, redacted payload. */
export const workerRunCommandSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(['steer', 'take_over', 'cancel']),
  payload: jsonObjectSchema,
});

/** A tool approval a human decided, delivered on the heartbeat (TD-031 §9). */
export const workerApprovalDecisionSchema = z.strictObject({
  approval_id: idSchema,
  decision: z.enum(['allow', 'deny']),
  reason: z.string().max(4_096),
  question_id: idSchema.nullable(),
});

/** `POST runs/:id/heartbeat` → the renewed lease, pending commands and decided approvals. */
export const workerHeartbeatResponseSchema = z.strictObject({
  lease_expires_at: isoDateTimeSchema,
  commands: z.array(workerRunCommandSchema).max(256),
  approvals: z.array(workerApprovalDecisionSchema).max(256),
});
export type WorkerHeartbeatResponse = z.infer<typeof workerHeartbeatResponseSchema>;

/**
 * `POST runs/:id/transcript`: a batch of `{ seq, event }`, at most
 * {@link WORKER_TRANSCRIPT_BATCH_MAX_BYTES} on the wire. `event` is an object and no more here: the
 * core validates each entry against `transcriptEventSchema` and stores an undecodable one as a typed
 * `ingest_refused` row naming its seq, never dropping it (TD-031 §10a), which a schema that refused
 * the whole batch could not do.
 */
export const workerTranscriptRequestSchema = z.strictObject({
  epoch: leaseEpochSchema,
  entries: z
    .array(z.strictObject({ seq: sequenceSchema, event: jsonObjectSchema }))
    .min(1)
    .max(1_000),
});

/** `POST runs/:id/transcript` → how many entries were stored and which seqs were refused. */
export const workerTranscriptResponseSchema = z.strictObject({
  stored: z.int().nonnegative(),
  refused_seqs: z.array(sequenceSchema),
});

/** A tool call's id as the SDK writes it — the idempotency key of `tools/:name` with the run id. */
const toolUseIdSchema = nonEmptyStringSchema.max(256);

/** `POST runs/:id/tools/:name`: one platform tool call (TD-031 §10b), deduplicated on `tool_use_id`. */
export const workerToolCallRequestSchema = z.strictObject({
  epoch: leaseEpochSchema,
  tool_use_id: toolUseIdSchema,
  /** Model-written and untrusted (BD-022); validated by the tool's own schema at the route. */
  input: jsonObjectSchema,
});

/** `POST runs/:id/tools/:name` → the tool's answer to the model. */
export const workerToolCallResponseSchema = z.strictObject({
  result: jsonValueSchema,
  is_error: z.boolean(),
});

/** `POST runs/:id/approvals`: opens a tool approval (`ToolApprovalRequest` without its ids). */
export const workerApprovalRequestSchema = z.strictObject({
  epoch: leaseEpochSchema,
  tool_use_id: toolUseIdSchema,
  tool_name: nonEmptyStringSchema.max(256),
  detail: z.string().max(16_384),
  input: jsonObjectSchema,
  reason: z.string().max(4_096),
});

/** `POST runs/:id/approvals` → the approval's id; its decision arrives on a heartbeat. */
export const workerApprovalResponseSchema = z.strictObject({ approval_id: idSchema });

/**
 * `POST runs/:id/session`: the SDK session mirror (TD-007), redacted on ingest. The lines are the
 * session file's JSONL lines from `from_line` on, so a retried upload is idempotent by position.
 */
export const workerSessionRequestSchema = z.strictObject({
  epoch: leaseEpochSchema,
  session_id: nonEmptyStringSchema.max(256),
  from_line: z.int().nonnegative(),
  lines: z.array(z.string().max(1024 * 1024)).max(10_000),
});

/** Non-empty standard base64 of at most `max` characters (the runlet frames' SSH fields). */
const base64Schema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'expected base64');

/** `POST runs/:id/ssh-sign`: the runlet's `ssh.sign` frame, forwarded (TD-031 §5). */
export const workerSshSignRequestSchema = z.strictObject({
  epoch: leaseEpochSchema,
  key_blob: base64Schema(1_024),
  data: base64Schema(16_384),
  flags: z.int().min(0).max(0xffff_ffff),
});

/** `POST runs/:id/ssh-sign` → the signature, or `null` refused — `ssh.sign.reply`'s field. */
export const workerSshSignResponseSchema = z.strictObject({
  signature: base64Schema(1_024).nullable(),
});

/** TD-031 §6's four reasons a run is handed back unspent before `run.started`. */
export const workerReleaseReasonSchema = z.enum([
  'usage_limited',
  'image_missing',
  'provision_failed',
  'shutdown',
]);

/**
 * `POST runs/:id/release` `{ epoch, reason }`, with `resets_at` for `usage_limited` when the limit
 * said when it resets (TD-031 §6, §11; absent means the default pause). Answers `204`; `409
 * run_started` after `run.started`.
 */
export const workerRunReleaseRequestSchema = z
  .strictObject({
    epoch: leaseEpochSchema,
    reason: workerReleaseReasonSchema,
    resets_at: isoDateTimeSchema.optional(),
  })
  .refine((body) => body.resets_at === undefined || body.reason === 'usage_limited', {
    message: 'resets_at belongs to a usage_limited release only',
    path: ['resets_at'],
  });

/** The terminal statuses a run may end in — `TerminalRunStatus` of the runner port. */
export const terminalRunStatusSchema = z.enum([
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
  'stalled',
]);

/**
 * **Why the platform stopped a run** — the closed vocabulary of the `run_stopped` transcript row's
 * `data.reason`: the runner's own stops beside a holder's (`cancelled`, `taken_over`, `shutdown`).
 * `settleRun`'s request carries it as `stopReason` (TD-031's 2026-11-04 amendment §1), so a
 * worker's stop register crosses as a closed word, validated here (WP-281); `@platform/application`
 * re-exports it from `ports/runner.ts`, its one definition.
 */
export const RUN_STOPPED_REASONS = [
  'stalled',
  'timed_out',
  'budget_exceeded',
  'cost_unreported',
  'cancelled',
  'taken_over',
  'shutdown',
] as const;
export const runStoppedReasonSchema = z.enum(RUN_STOPPED_REASONS);

/**
 * `POST runs/:id/cancel` (WP-292, protocol 2): a person's cancel from the worker's local page. The
 * body is the task page's (`cancelRunRequestSchema`) and so is the answer: the core performs the
 * **same** application command as `POST /api/runs/:run_id/cancel`, as the worker's user, under the
 * same `run.cancel` permission, and pauses the task. Requires an `Idempotency-Key`.
 */
export const workerRunCancelRequestSchema = cancelRunRequestSchema;
export const workerRunCancelResponseSchema = cancelRunResponseSchema;

/** `POST runs/:id/spawn`: the CLI spawn marker, under the claim's epoch (WP-281). */
export const workerSpawnRequestSchema = z.strictObject({ epoch: leaseEpochSchema });

/**
 * `POST runs/:id/spawn` → the marker's instant. The worker sends **no** `spawn` frame before this
 * `200` (TD-031's 2026-11-04 amendment §4); a replay under the same claim answers the same instant.
 */
export const workerSpawnResponseSchema = z.strictObject({ started_at: isoDateTimeSchema });

/** The run's `RunOutcome`, snake_case — a run that started (or a stop before its marker). */
export const workerRanOutcomeSchema = z.strictObject({
  kind: z.literal('ran'),
  status: terminalRunStatusSchema,
  terminal_reason: runTerminalReasonSchema,
  session_id: nonEmptyStringSchema.max(256).nullable(),
  num_turns: z.int().nonnegative(),
  usage: tokenUsageSchema,
  model_usage: z.array(modelUsageSchema).max(64),
  /**
   * `null` exactly when nothing measured the run (`costUnmeasured`, rule 16) — never a zero standing
   * in for an unknown.
   */
  cost: runCostSchema.nullable(),
  wall_ms: z.int().nonnegative(),
  structured_output: jsonValueSchema.nullable(),
  error: z.string().max(16_384).nullable(),
  redaction_count: tokenCountSchema,
  saved_work: runSavedWorkSchema.optional(),
  start_failure: runStartFailureSchema.optional(),
});

/**
 * A run that **never started** (`NotStartedReport`, TD-031's 2026-11-04 amendment §3): the
 * claimant classifies and quotes; the core redacts, bounds and decides whether the stage goes again.
 */
export const workerNotStartedSchema = z.strictObject({
  kind: z.literal('not_started'),
  /** The closed-vocabulary diagnosis (`describeStartFailure`). */
  failure: nonEmptyStringSchema.max(2_000),
  /** The launcher's own words, unredacted — the core redacts them with the run's redactor. */
  detail: z.string().max(16_000).nullable(),
  detail_truncated: z.boolean(),
  transient: z.boolean(),
  /** WP-150's marker: the run may have reached its CLI. */
  spawn_requested: z.boolean(),
});

/**
 * `POST runs/:id/finish`: `settleRun`'s four-field request (TD-031's 2026-11-04 amendment §1) —
 * the epoch (the fence's owner is the authenticated worker, never the body), what happened, and the
 * worker's stop register. Idempotent on `(run_id, epoch)` (TD-031 §3).
 */
export const workerFinishRequestSchema = z.strictObject({
  epoch: leaseEpochSchema,
  stop_reason: runStoppedReasonSchema.nullable(),
  outcome: z.discriminatedUnion('kind', [workerRanOutcomeSchema, workerNotStartedSchema]),
});

/**
 * `POST runs/:id/finish` → whether this call wrote the run's ending (`settled`) or found it already
 * written at this epoch (`already_settled`), and the ending as the row stores it. A run whose task was
 * deleted answers `410 run_gone`, which a worker treats as terminal.
 */
export const workerFinishResponseSchema = z.strictObject({
  outcome: z.enum(['settled', 'already_settled']),
  ending: z.strictObject({
    status: terminalRunStatusSchema,
    terminal_reason: runTerminalReasonSchema.nullable(),
    epoch: leaseEpochSchema,
  }),
});

/**
 * `POST runs/:id/late-cost`: what a run burned after its row was ended by another writer (Q70 (b),
 * `cost/late.ts`) — accepted while the run token authenticates, terminal plus
 * {@link WORKER_RUN_TOKEN_AFTER_END_MS}.
 */
export const workerLateCostRequestSchema = z.strictObject({
  epoch: leaseEpochSchema,
  session_id: nonEmptyStringSchema.max(256).nullable(),
  num_turns: z.int().nonnegative(),
  wall_ms: z.int().nonnegative(),
  cost: runCostSchema,
  usage: tokenUsageSchema,
  model_usage: z.array(modelUsageSchema).max(64),
});

/**
 * `POST runs/:id/late-cost` → whether the figure was written. `false` is not a refusal: the row
 * already carries a figure or the ledger already charged the run, so a repeat writes nothing.
 */
export const workerLateCostResponseSchema = z.strictObject({ recorded: z.boolean() });

// ── Release and updates (TD-032 decisions 3, 4) ──────────────────────────────

/** `GET release` → the digests and the protocol range, no compose file (TD-032 decision 3). */
export const workerReleaseResponseSchema = z.strictObject({
  protocol: workerProtocolRangeSchema,
  digests: coreImageDigestsSchema,
});

/**
 * How a worker's update ended (TD-032 decision 6): applied and checked; applied, unhealthy and put
 * back; or not applied — refused (an attestation that does not verify, a downgrade, no verifier) or
 * failed and not put back. The updater's `detail` says which.
 */
export const workerUpdateResultSchema = z.enum(['succeeded', 'rolled_back', 'failed']);
export type WorkerUpdateResult = z.infer<typeof workerUpdateResultSchema>;

/** `POST update-report`: how a worker's update ended (TD-032 decision 6). Answers `204`. */
export const workerUpdateReportRequestSchema = z.strictObject({
  from: coreImageDigestsSchema,
  to: coreImageDigestsSchema,
  result: workerUpdateResultSchema,
  detail: z.string().max(4_096).nullable(),
});
