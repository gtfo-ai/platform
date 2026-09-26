/**
 * The launcher control plane's wire format — **TD-028's new half**, defined once for both ends.
 *
 * TD-028 splits the transport in two. The **data plane** is unchanged: the runner keeps TD-025 §2's
 * static mount of the whole `ctl` volume and opens the per-run Unix socket itself, so no stdio, no
 * `stdin`/`stdout` and no credential-helper round trip crosses HTTP. The **control plane** is this:
 * a small request/response surface for the operations that are request/response — create a
 * workspace, end a run, report health.
 *
 * ## It lives here rather than in `apps/launcher` because both ends must read the same bytes
 *
 * The server is `apps/launcher/src/control-plane.ts` and the client is `./client.ts`; a copy in each
 * would be two statements of one format (standing rule 63). `packages/infrastructure` is the ring
 * both can import — `apps/launcher` depends on it, and the client is an adapter behind
 * `WorkspaceProvider`, which is the shape TD-028 decision 1 asks for.
 *
 * ## The wire is camelCase here, and that is a stated deviation
 *
 * `CLAUDE.md`'s snake_case rule governs config YAML, event payloads, artifact data, API DTOs and
 * transcript rows. This is none of those: it is a process-to-process RPC whose whole vocabulary is
 * the `WorkspaceSpec`, `WorkspaceHandle` and `WorkspaceAttachment` that `packages/application/src/
 * ports/workspace.ts` already defines — in camelCase, and with the sentence *"a `WorkspaceSpec` is
 * built inside the process from effective config and **never appears on a wire**"*. That sentence is
 * now false and is corrected there. Re-spelling the spec in snake_case for this hop would be a
 * second schema for one structure, which is the drift `workspaceSpecSchema` exists to prevent, and
 * it would put a mapping between the platform and the daemon that nothing else needs.
 *
 * The **envelope** — the fields this module adds — is camelCase for the same reason: one document,
 * one convention.
 *
 * ## Failure is typed, not HTTP status text
 *
 * TD-028 decision 7: control-plane errors map onto the existing {@link WorkspaceErrorCode} values,
 * so `classifyProvisionFailure` (`runner/workspace-runner.ts`) keeps deciding retryability from the
 * same four codes it always has, and the stage executor's existing ending applies unchanged (Q59).
 * {@link CONTROL_PLANE_STATUS_BY_CODE} and {@link controlPlaneCodeOfStatus} are the two directions
 * of that map, and `protocol.test.ts` holds them to each other — a status the client cannot read
 * back is a `WorkspaceError` that arrives as `internal`.
 */
import type {
  WorkspaceAttachment,
  WorkspaceErrorCode,
  WorkspaceExport,
  WorkspaceHandle,
} from '@platform/application';
import { workspaceSpecSchema } from '@platform/application';
import { isoDateTimeSchema, nonEmptyStringSchema } from '@platform/contracts';
import * as z from 'zod';

/** Every path this surface answers, so a router and a client cannot disagree about one. */
export const CONTROL_PLANE_PATHS = {
  /** `POST` — create the workspace of one run. Idempotent on `spec.runId` (TD-028 decision 4). */
  runs: '/v1/runs',
  /** `POST /v1/runs/<run-id>/end` — export, revoke, stop and remove. */
  end: 'end',
  /** `GET` — liveness plus what this launcher is configured with. Unauthenticated is refused. */
  health: '/v1/health',
} as const;

/** The header the shared secret travels in (TD-028 decision 3, `APP_LAUNCHER_TOKEN`). */
export const CONTROL_PLANE_AUTH_HEADER = 'authorization';

/**
 * The largest request body the control plane reads.
 *
 * A `WorkspaceSpec` is bounded by its own schema — 256 egress hosts, a 2 KiB URL, a `env` record —
 * and the largest one this platform builds is a few kilobytes. 256 KiB is two orders of magnitude
 * above that and three below the launcher's memory, so a caller that streams for ever is cut off
 * long before it costs anything. Bounded *here* rather than at the reverse proxy, because there is
 * no reverse proxy on an `internal: true` compose network (standing rule 31: the bound that is
 * optional is the bound that is absent).
 */
export const CONTROL_PLANE_MAX_BODY_BYTES = 256 * 1024;

// ── The structures the port already owns, as schemas ─────────────────────────

/**
 * {@link WorkspaceHandle} on the wire.
 *
 * Annotated `z.ZodType<WorkspaceHandle>` rather than left to inference, so a field added to the
 * interface and not to this schema is a **type** error in this file rather than a field silently
 * dropped by a `strictObject` parse on the other side.
 */
export const workspaceHandleSchema: z.ZodType<WorkspaceHandle> = z.strictObject({
  runId: nonEmptyStringSchema.max(64),
  projectId: nonEmptyStringSchema.max(64),
  containerId: nonEmptyStringSchema.max(128),
  sidecarContainerId: nonEmptyStringSchema.max(128).nullable(),
  networkId: nonEmptyStringSchema.max(128),
  volumeName: nonEmptyStringSchema.max(255),
  // `null` for a workspace with no checkout (WP-74); the interface moved with it, and the
  // `z.ZodType<WorkspaceHandle>` annotation is what made the two move together.
  cacheKey: nonEmptyStringSchema.max(64).nullable(),
  controlSubPath: nonEmptyStringSchema.max(255),
  keepUntil: isoDateTimeSchema,
});

/**
 * {@link WorkspaceAttachment} on the wire — **including the run token**, which is a decision.
 *
 * The alternative was to return only the socket path and let the runner read
 * `<ctl>/<run-id>/token` off the volume it has mounted. That is rejected: the file's name and
 * layout are TD-025 §2's, `DockerWorkspaceProvider.#readToken` already implements the read, and a
 * second reader in the runner would be a second statement of the layout (standing rule 63) that
 * drifts the first time the layout moves.
 *
 * What it costs is stated rather than implied: the run token crosses an HTTP hop. The hop is an
 * `internal: true` compose network with no published port that only the launcher and the runner
 * join, it is authenticated on every request (TD-028 decision 3), and the token's whole life is the
 * one run it names — it is revoked by `destroy` and the directory is removed with it. The token is
 * never logged by either end: `client.ts` logs the socket path and not the body.
 */
export const workspaceAttachmentSchema: z.ZodType<WorkspaceAttachment> = z.strictObject({
  socketPath: nonEmptyStringSchema.max(4_096),
  token: nonEmptyStringSchema.max(512),
  workdir: nonEmptyStringSchema.max(4_096),
});

const workspaceExportSchema: z.ZodType<WorkspaceExport> = z.strictObject({
  branch: nonEmptyStringSchema.max(255),
  pushed: z.boolean(),
  commitSha: nonEmptyStringSchema.max(64).nullable(),
  tarballPath: nonEmptyStringSchema.max(4_096).nullable(),
  tarballBytes: z.int().min(0),
  droppedLinks: z.int().min(0),
});

// ── Requests ─────────────────────────────────────────────────────────────────

/**
 * The run's git credential, **minted by the runner and carried to the launcher** — TD-028's WP-76
 * amendment (2026-09-25), decision 3.
 *
 * This read *"The launcher **mints** through its own `RunCredentialSource`; the caller says what to
 * mint for"* until WP-76, and the launcher could not: it holds no binding, no `APP_SECRET_KEY` and
 * no database (TD-021), so its source refused and every writing run failed terminally at
 * `startRun` (PROGRESS backlog 133). The second clause survives — **the scope is still decided
 * platform-side**, by the spec's `readOnly` — and the first is reversed: the runner mints through
 * `IntegrationActionExecutor` (one audit row per mint and per revoke, keyed by the git binding) and
 * sends the material here.
 *
 * What that costs, stated rather than implied: **the runner holds the token for the life of the
 * run**, not of one request — it answers the workspace's `cred.get` from its own copy and revokes
 * after `endRun` returns — and the token crosses this hop, the same `internal: true`, authenticated
 * network the run token already crosses the other way (`workspaceAttachmentSchema`). No `revokeId`
 * travels: the launcher cannot use one. Neither end logs a body.
 */
export const runCredentialSchema = z.strictObject({
  /** The git host the credential is for. Lowercase, no port — {@link egressHostSchema}'s form. */
  host: nonEmptyStringSchema.max(253),
  username: nonEmptyStringSchema.max(255),
  /** The secret. Standing rule 18: `nonEmptyStringSchema` refuses empty and blank. */
  password: nonEmptyStringSchema.max(4_096),
  scope: z.enum(['read', 'push']),
  expiresAt: isoDateTimeSchema,
});
export type RunCredentialPayload = z.infer<typeof runCredentialSchema>;

/**
 * `POST /v1/runs`.
 *
 * The **spec is built by the caller**, which is the platform side: it is derived from
 * `projects.repo_url`, the run's own tool policy and instance configuration, none of which the
 * launcher has (`compose.yml`'s launcher service joins neither the default network nor `db`).
 * `buildWorkspaceSpec` is the derivation and this is its first production consumer.
 *
 * The credential rules are TD-028's WP-76 amendment (decisions 3 and 6), refused here — on both
 * ends, because both parse this schema — rather than reconciled:
 *
 *  - **no repository, no credential** (WP-74): a run with no checkout makes no mirror fetch and no
 *    push;
 *  - **a writing spec must carry one**: a binding that cannot mint refuses the run in the runner,
 *    before this request exists, and never substitutes its own token;
 *  - **a read-only spec carries a `read` credential or none** — none is an anonymous fetch, right
 *    for a public repository — and a **`push` credential on a read-only spec is refused** (BD-021);
 *  - **the credential names the spec's git host**, one of `spec.egress.hosts`, so the host the
 *    workspace's `cred.get` is answered for is a host the run may reach at all;
 *  - **the password is in no `spec.env` value** — the one carrier into the run container's
 *    environment a caller controls. `#gitCredentialEnv` keeps the helpers' copy out of the run
 *    container; this keeps the spec's.
 */
export const createRunRequestSchema = z
  .strictObject({
    spec: workspaceSpecSchema,
    credential: runCredentialSchema.nullable(),
  })
  .superRefine((request, context) => {
    const { spec, credential } = request;
    const refuse = (message: string): void => {
      context.addIssue({ code: 'custom', message, path: ['credential'] });
    };
    if (spec.repo === null) {
      if (credential !== null) {
        refuse('a spec with no repository carries no credential: nothing will fetch or push');
      }
      return;
    }
    if (credential === null) {
      if (!spec.readOnly) {
        refuse(
          'a spec that writes must carry a run credential; a binding that cannot mint refuses the run before it is created',
        );
      }
      return;
    }
    if (spec.readOnly && credential.scope === 'push') {
      refuse('a read-only spec may carry a read credential or none, never a push one (BD-021)');
    }
    if (!spec.egress.hosts.includes(credential.host)) {
      refuse('the credential names a host that is not one of the spec’s egress hosts');
    }
    if (Object.values(spec.env).some((value) => value.includes(credential.password))) {
      refuse(
        'the credential appears in the spec’s container environment, which the agent can read',
      );
    }
  });
export type CreateRunRequestPayload = z.infer<typeof createRunRequestSchema>;

/**
 * `POST /v1/runs/<run-id>/end`.
 *
 * The **handle travels back**, rather than being looked up in the launcher's memory, so that a
 * launcher which restarted between the create and the end can still stop the container. The
 * in-memory map exists for idempotent *creates* (TD-028 decision 4); it is not the record of what
 * is running, because a process's memory is not a record.
 */
export const endRunRequestSchema = z.strictObject({
  handle: workspaceHandleSchema,
  export: z
    .strictObject({
      branch: nonEmptyStringSchema.max(255),
      commitMessage: nonEmptyStringSchema.max(1_000),
      tarball: z.boolean(),
      keepUntil: isoDateTimeSchema.optional(),
    })
    .nullable(),
});
export type EndRunRequestPayload = z.infer<typeof endRunRequestSchema>;

// ── Responses ────────────────────────────────────────────────────────────────

export const createRunResponseSchema = z.strictObject({
  handle: workspaceHandleSchema,
  attachment: workspaceAttachmentSchema,
  /**
   * Where the `claude` binary is **inside the run image** — PROGRESS backlog **34**.
   *
   * The SDK computes `pathToClaudeCodeExecutable` on the *platform* side and the shim execs it in
   * the container, so a platform-resolved path is a path that is not there. The launcher is the one
   * process that knows which image a run is created from, so it is the one that answers; the runner
   * puts it on the spec (`workspace-runner.ts` substitutes it beside `workspacePath`).
   */
  claudeCodePath: nonEmptyStringSchema.max(4_096),
  /**
   * The scope of the run credential the launcher **holds** for this run, or `null` when it holds
   * none — a repo-less run, or a read-only one that fetches anonymously. It minted nothing: the
   * runner did, and sent it (WP-76). Never the credential.
   */
  credentialScope: z.enum(['read', 'push']).nullable(),
  /** `true` when this create answered a handle it had already made (TD-028 decision 4). */
  replayed: z.boolean(),
});
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;

export const endRunResponseSchema = z.strictObject({
  exported: workspaceExportSchema.nullable(),
  keepUntil: isoDateTimeSchema.nullable(),
  failures: z.array(z.string().max(2_000)).max(16),
});
export type EndRunResponse = z.infer<typeof endRunResponseSchema>;

export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  controlRoot: nonEmptyStringSchema.max(4_096),
  runtimeImage: nonEmptyStringSchema.max(512),
  claudeCodePath: nonEmptyStringSchema.max(4_096),
  /** How many runs this process holds a create handle for. A gauge, never a record. */
  runs: z.int().min(0),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Codes this surface answers with. The four on the left are {@link WorkspaceErrorCode} verbatim;
 * the three on the right are the ones a *transport* has and a provider does not.
 */
export const CONTROL_PLANE_ERROR_CODES = [
  'invalid_spec',
  'engine_unavailable',
  'workspace_failed',
  'not_found',
  'unauthorized',
  'bad_request',
  'internal',
] as const;
export type ControlPlaneErrorCode = (typeof CONTROL_PLANE_ERROR_CODES)[number];

export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(CONTROL_PLANE_ERROR_CODES),
    message: z.string().max(2_000),
    runId: nonEmptyStringSchema.max(64).nullable(),
    detail: z.string().max(2_000).nullable(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * Code → HTTP status.
 *
 * `engine_unavailable` is **503** and `workspace_failed` **500**, which is the split
 * `classifyProvisionFailure` already makes for retryability; `invalid_spec` is **400** because it is
 * a statement about this request and would be refused identically on every attempt. The status is
 * a courtesy to a human reading a log — the client reads `error.code`, never the status — and the
 * two are kept in agreement by `protocol.test.ts` in both directions.
 */
export const CONTROL_PLANE_STATUS_BY_CODE: Record<ControlPlaneErrorCode, number> = {
  invalid_spec: 400,
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  internal: 500,
  workspace_failed: 500,
  engine_unavailable: 503,
};

/**
 * The transport's own reading of a status, for a response whose body did not parse.
 *
 * It exists because a body is not guaranteed: a proxy, a connection reset mid-body or a launcher
 * that died between the header and the payload all produce a status with nothing behind it, and
 * "the body did not parse" must not become `internal` when the status already said `401`.
 * `engine_unavailable` is the answer for **every** 5xx that is not 500 and for a 502/504, because
 * those are exactly the shapes a proxy in front of an unreachable launcher produces — and
 * `engine_unavailable` is the retryable one, which is the direction an operator wants for a
 * transport fault.
 */
export const controlPlaneCodeOfStatus = (status: number): ControlPlaneErrorCode => {
  if (status === 401 || status === 403) {
    return 'unauthorized';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 400 || status === 413 || status === 415) {
    return 'bad_request';
  }
  if (status >= 500 && status !== 500) {
    return 'engine_unavailable';
  }
  return 'internal';
};

/**
 * The {@link WorkspaceErrorCode} a control-plane code becomes on the runner's side.
 *
 * `unauthorized` and `bad_request` have no `WorkspaceError` of their own and become
 * `invalid_spec` — **terminal**, not retryable — because both are statements about the request the
 * platform sent: a wrong token and a malformed body would be wrong again on the next attempt, and
 * spinning on either hides a configuration error behind a retry loop (standing rule 18).
 * `internal` becomes `workspace_failed`, which *is* retryable, because an unexplained failure
 * inside the launcher is a condition that may pass.
 */
export const workspaceCodeOfControlPlaneCode = (
  code: ControlPlaneErrorCode,
): WorkspaceErrorCode => {
  switch (code) {
    case 'invalid_spec':
    case 'unauthorized':
    case 'bad_request':
      return 'invalid_spec';
    case 'engine_unavailable':
      return 'engine_unavailable';
    case 'not_found':
      return 'not_found';
    default:
      return 'workspace_failed';
  }
};
