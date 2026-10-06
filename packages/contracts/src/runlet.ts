/**
 * The `agentic-runlet` control-frame protocol (TD-025, technical/05 § "Control channel").
 *
 * Two of our own processes speak this: the **shim** inside the run container (`apps/runlet`) and
 * the **runner** on the platform side (`packages/infrastructure/src/runlet`). It is a wire format,
 * so it lives here for the same reason event payloads and API DTOs do — one definition, validated
 * by both ends, impossible to drift.
 *
 * ## Trust
 *
 * **Every frame is data, never an instruction** (BD-022). The producer on the other end of the
 * control socket is a binary the platform ships and does not control, and the producer on the
 * *credential* socket is the agent itself. So:
 *
 *  - every header is parsed by {@link runletFrameSchema} — a strict discriminated union, so an
 *    unknown key, an unknown `type` or a missing field is a protocol error rather than a default;
 *  - **a missing field is never zero** (standing rule 16). `exit.code` is `int | null` and
 *    *required*: a frame without it does not parse, and nothing anywhere reads `?? 0`. Same for
 *    `cred.reply.credential`, which is `null` or a credential and never absent;
 *  - each side keeps its own accept-list per state (`shim.ts`, `spawn-adapter.ts`): parsing says
 *    the frame is well-formed, not that it may be acted on. A `spawn` arriving at the runner, or a
 *    `stdout` arriving at the shim, is a protocol error even though both parse.
 *
 * ## Framing
 *
 * `spawn`, `signal`, `exit`, … carry JSON only. `stdin`, `stdout` and `stderr` carry **raw bytes**
 * beside the JSON header, because base64 in JSON would inflate a 100 MB tool output by a third and
 * force the whole thing through `JSON.parse`. Hence the eight-byte fixed prefix in
 * `packages/infrastructure/src/runlet/framing.ts`: two big-endian `u32` lengths, header then
 * payload. A fixed-width binary prefix is also the reason "a missing length" cannot mean zero here
 * — there is no field to omit, only bytes that have not arrived yet.
 *
 * ## Names
 *
 * TD-025 names the frames `hello`, `spawn`, `stdin`, `stdout`, `stderr`, `signal`, `exit`,
 * `cred.get`, `cred.reply`, `ping`, `pong`; those spellings are kept verbatim. `ssh.sign` and
 * `ssh.sign.reply` are TD-028 decision 13b's pair (WP-146). Four more are additions
 * the decision implies but does not name: `hello.ok` and `spawn.ok` (the acknowledgements TD-025's
 * "accepts exactly one authenticated control connection" needs in order to *be* an authenticated
 * connection), `stdin.end` (the SDK closes the CLI's stdin to trigger its graceful exit — without a
 * frame for it the CLI never sees EOF) and `fatal` (a refusal that says why, so a runner does not
 * have to infer policy from a closed socket).
 */
import * as z from 'zod';

/**
 * Bumped when a frame changes shape. `hello` carries it and a mismatch is refused on both sides.
 *
 * 2 (backlog 481, 2026-10-06): `cred.get` carries the repository `path`, so a run image and a
 * runner from either side of that change refuse each other by name rather than one dropping a field
 * the other decides on.
 *
 * 3 (WP-151, TD-025's M9 amendment, backlog 489): `protocol_mismatch` joins the fatal reasons and its
 * `fatal` frame carries both versions. A protocol-3 shim answers a `hello` for any other protocol
 * with it, before it reads the token; a protocol-2 shim still answers a protocol-3 runner
 * `auth_failed`, which the runner reads, on the first frame of a handshake, as a refused handshake
 * that a rebuild of both sides may explain (`spawn-adapter.ts`).
 *
 * **The run image declares this number** as the label `com.agentic.runlet-protocol`, written by
 * `docker/runtime.Dockerfile` from this line at build time and never by hand
 * (`scripts/runlet-protocol.test.ts` holds the two together), and the launcher refuses a create
 * whose image declares another number than the requesting runner's, or none (`provider.ts`).
 */
export const RUNLET_PROTOCOL_VERSION = 3;

/**
 * The run image's label declaring the protocol its shim speaks (WP-151): `docker/runtime.Dockerfile`
 * writes {@link RUNLET_PROTOCOL_VERSION} into it at build time, and the launcher reads it at image
 * inspection (`packages/infrastructure/src/workspace/provider.ts`).
 */
export const RUNLET_PROTOCOL_IMAGE_LABEL = 'com.agentic.runlet-protocol';

/**
 * Signals the shim will relay to the child.
 *
 * An allow-list rather than `string`: `kill(2)` also takes numbers and names like `SIGSTOP`, and a
 * relay that forwards whatever it is handed lets one side of the socket park the other side's
 * process for ever. These seven are what the SDK teardown path, the stall detector and the
 * wall-clock timeout need (technical/04 § "Streaming and steering").
 */
export const runletSignalSchema = z.enum([
  'SIGTERM',
  'SIGKILL',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
  'SIGUSR1',
  'SIGUSR2',
]);
export type RunletSignal = z.infer<typeof runletSignalSchema>;

/**
 * The signal an `exit` frame *reports*, which is a wider set than the one the runner may *send*.
 *
 * A child can die of `SIGSEGV`, `SIGABRT` or `SIGBUS`, none of which anything is allowed to relay,
 * and reporting those as `null` would turn a crash into an ordinary exit. So the report is any
 * `SIG…` name the operating system produced, validated by shape rather than by an allow-list, and
 * still required — `signal` absent does not parse (standing rule 16).
 */
export const runletExitSignalSchema = z
  .string()
  .max(20)
  .regex(/^SIG[A-Z0-9]+$/);

/** Why a connection was refused or torn down. Carried by `fatal`, and by thrown protocol errors. */
export const runletFatalReasonSchema = z.enum([
  /** The header did not parse, or a byte frame arrived with no bytes / too many. */
  'protocol_error',
  /** `hello` was absent, malformed, or carried the wrong token — including an empty one. */
  'auth_failed',
  /**
   * `hello` named a protocol this shim does not speak (WP-151). Checked **before** the token, and
   * its `fatal` frame carries both versions as integers ({@link runletProtocolsSchema}), so the
   * runner names them without reading a message. Until protocol 3 this was `auth_failed`.
   */
  'protocol_mismatch',
  /** A second connection arrived while one was authenticated, or after one had been. */
  'connection_taken',
  /** A well-formed frame arrived in a state that does not accept it. */
  'unexpected_frame',
  /** `hello` did not arrive inside the handshake window. */
  'handshake_timeout',
  /** The spawn was refused by policy (relative command, root child, second spawn). */
  'spawn_refused',
  /** A credential request was refused by policy (rate limit, no run, unknown request id). */
  'credential_refused',
  /** The shim is shutting down: the control connection dropped, or the child exited. */
  'shutting_down',
]);
export type RunletFatalReason = z.infer<typeof runletFatalReasonSchema>;

/**
 * The two protocol versions a `protocol_mismatch` names (WP-151): what the `hello` said the runner
 * speaks, and what the shim speaks. Integers, never prose, so neither end parses a message.
 */
export const runletProtocolsSchema = z.strictObject({
  runner: z.int(),
  shim: z.int(),
});
export type RunletProtocols = z.infer<typeof runletProtocolsSchema>;

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/'), { message: 'must be an absolute path' })
  .refine((value) => !value.includes('\0'), { message: 'must not contain a NUL byte' });

/**
 * An environment variable name.
 *
 * Narrower than POSIX allows on purpose: the shim passes this map to `execve` with `shell: false`,
 * and a name carrying `=` or a NUL is how a value smuggles a second variable past the map.
 */
const environmentKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const environmentValueSchema = z
  .string()
  .max(131072)
  .refine((value) => !value.includes('\0'), { message: 'must not contain a NUL byte' });

/** One DNS label: 1–63 chars, lowercase alphanumeric and `-`, not starting or ending with `-`. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The host a credential is asked for.
 *
 * Lowercase is **required**, not applied: the caller that knows the source of the string (the git
 * credential helper, `credential-helper.ts`) normalises it, and the wire refuses anything else, so
 * two spellings of one host can never reach the runner's allow-list as two different strings. No
 * port, no userinfo, no path, no wildcard — the surface a compromised child gets to describe is
 * one hostname and nothing else.
 */
export const runletHostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine((value) => value.split('.').every((label) => HOST_LABEL.test(label)), {
    message: 'must be a lowercase DNS host name',
  });

/**
 * The repository path a credential is asked for — git's own `path` field, which git sends only
 * because the workspace sets `credential.useHttpPath` (backlog 481).
 *
 * **Carried, not judged.** git has already percent-decoded it, removed dot segments and trimmed its
 * slashes; whether it names the project's repository is the runner's question
 * (`RunCredentialBroker.answer`), on the platform side of the volume, like the host's. The wire
 * only bounds it — a length, and no control character, so it stays one line of git's protocol —
 * and the helper sends `null` for anything outside that, which the runner refuses like a missing
 * one.
 */
export const runletCredentialPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      ![...value].some((char) => {
        const code = char.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      }),
    { message: 'must not contain a control character' },
  );

/** Correlates a `cred.get` with its `cred.reply`. Generated by the shim, never by the workspace. */
const requestIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Non-empty standard base64 of at most `max` characters — the two SSH byte fields above. */
const base64Schema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'expected base64');

/**
 * Every frame, both directions.
 *
 * Direction and state are enforced by the two endpoints rather than by the type: one union means
 * one parser and one place to look, and "which frames may I act on right now" is a property of a
 * connection's state machine, not of a schema.
 */
export const runletFrameSchema = z.discriminatedUnion('type', [
  // ── runner → shim ────────────────────────────────────────────────────────
  /** The single authenticated connection's first frame. */
  z.strictObject({
    type: z.literal('hello'),
    protocol: z.int(),
    token: z.string(),
  }),
  /** Start the CLI. Once per connection; `command` and `cwd` are absolute, `shell` is never used. */
  z.strictObject({
    type: z.literal('spawn'),
    command: absolutePathSchema,
    args: z.array(z.string().max(131072)).max(1024),
    cwd: absolutePathSchema,
    /** Replaces the shim's own environment; it is never merged (technical/04: `env` replaces). */
    env: z.record(environmentKeySchema, environmentValueSchema),
  }),
  /** Bytes for the child's stdin; the chunk travels as the frame's payload. */
  z.strictObject({ type: z.literal('stdin') }),
  /** Close the child's stdin. The SDK's graceful-exit path starts here. */
  z.strictObject({ type: z.literal('stdin.end') }),
  z.strictObject({ type: z.literal('signal'), name: runletSignalSchema }),
  /** The runner's answer to `cred.get`. `credential: null` means "refused / not found". */
  z.strictObject({
    type: z.literal('cred.reply'),
    request_id: requestIdSchema,
    credential: z.union([
      z.null(),
      z.strictObject({ username: z.string().max(1024), password: z.string().max(8192) }),
    ]),
  }),

  /**
   * The runner's answer to `ssh.sign` (TD-028 decision 13b, WP-146): an SSH signature blob in
   * base64, or `null` — refused (another key, the run's budget spent, no deploy key).
   */
  z.strictObject({
    type: z.literal('ssh.sign.reply'),
    request_id: requestIdSchema,
    signature: base64Schema(1_024).nullable(),
  }),

  // ── shim → runner ────────────────────────────────────────────────────────
  z.strictObject({ type: z.literal('hello.ok'), protocol: z.int() }),
  /**
   * The child started. `pid` is namespace-local — inside a container it names a process the runner
   * cannot see, let alone signal — so it is for logs and nothing else. Kill goes through `signal`.
   */
  z.strictObject({ type: z.literal('spawn.ok'), pid: z.int().positive() }),
  z.strictObject({ type: z.literal('stdout') }),
  z.strictObject({ type: z.literal('stderr') }),
  /**
   * The child is gone. Both fields are required and nullable: a `code` of `null` with a `signal`
   * means it was killed, and a frame carrying neither does not parse — an exit status that failed
   * to arrive must never read as a successful `0` (standing rule 16).
   */
  z.strictObject({
    type: z.literal('exit'),
    code: z.int().nullable(),
    signal: runletExitSignalSchema.nullable(),
  }),
  /**
   * The workspace's git credential helper wants a token for `host` — and, since protocol 2, for
   * the repository at `path` on it (backlog 481). `path` is required and nullable: `null` is "git
   * sent none" (or one {@link runletCredentialPathSchema} refuses), which the runner refuses, and a
   * frame without the key does not parse, so an older shim cannot reach a newer runner's decision
   * with the field silently missing.
   *
   * `protocol` has exactly one value, so cleartext has no representation on this wire at all: a
   * helper invoked for `http://…` cannot produce a frame that parses, which is a stronger statement
   * than a policy branch that refuses one.
   */
  z.strictObject({
    type: z.literal('cred.get'),
    request_id: requestIdSchema,
    host: runletHostSchema,
    path: runletCredentialPathSchema.nullable(),
    protocol: z.literal('https'),
  }),
  /**
   * The run's ssh client asked the agent socket (`/ctl/ssh-agent.sock`) to sign — TD-028 decision 13b
   * item 2, WP-146. The shim speaks the ssh-agent protocol's two requests a git client needs and
   * relays **only** the sign request here, rebuilt from validated fields with its own request id; the
   * key blob and the data are bounded, base64, and the private key stays with the runner.
   */
  z.strictObject({
    type: z.literal('ssh.sign'),
    request_id: requestIdSchema,
    key_blob: base64Schema(1_024),
    data: base64Schema(16_384),
    flags: z.int().min(0).max(0xffff_ffff),
  }),
  /**
   * A refusal that says why. `protocols` is present **exactly** when `reason` is
   * `protocol_mismatch` (WP-151): optional rather than required-and-nullable because a protocol-3
   * runner must still read a protocol-2 shim's `fatal`, which has no such key.
   */
  z
    .strictObject({
      type: z.literal('fatal'),
      reason: runletFatalReasonSchema,
      message: z.string(),
      protocols: runletProtocolsSchema.optional(),
    })
    .refine((frame) => (frame.reason === 'protocol_mismatch') === (frame.protocols !== undefined), {
      message: 'a fatal frame carries protocols exactly when its reason is protocol_mismatch',
      path: ['protocols'],
    }),

  // ── either direction ─────────────────────────────────────────────────────
  z.strictObject({ type: z.literal('ping') }),
  z.strictObject({ type: z.literal('pong') }),
]);

export type RunletFrame = z.infer<typeof runletFrameSchema>;
export type RunletFrameType = RunletFrame['type'];

/**
 * The three frames that carry raw bytes beside their header.
 *
 * The codec holds both directions of this to it: one of these with an empty payload is a protocol
 * error (nothing emits one, so it is either a bug or a probe), and any other frame with a payload
 * is one too.
 */
export const RUNLET_BYTE_FRAME_TYPES = ['stdin', 'stdout', 'stderr'] as const;

export const isRunletByteFrameType = (type: RunletFrameType): boolean =>
  (RUNLET_BYTE_FRAME_TYPES as readonly string[]).includes(type);
