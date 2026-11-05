/**
 * **The worker protocol's run-scoped calls besides the claim** — WP-282, TD-031 decisions 5, 10a and
 * 10b and §9's table:
 *
 *   POST /api/worker/v1/runs/:id/transcript     run token — a batch ≤ 256 KiB, re-redacted, once per seq
 *   POST /api/worker/v1/runs/:id/tools/:name    run token — a platform tool, deduplicated on tool_use_id
 *   POST /api/worker/v1/runs/:id/approvals      run token — opens a tool approval; decided on a heartbeat
 *   POST /api/worker/v1/runs/:id/session        run token — the SDK session mirror, redacted
 *   POST /api/worker/v1/runs/:id/ssh-sign       run token — WP-146's oracle, one cap per run
 *
 * Registered by `registerWorkerProtocolRoutes` (`protocol.ts`), which hands this module its
 * `preValidation` authentication, so every verb here is behind the protocol check (`426` first) and
 * the run token (`401` whatever the body), exactly as the WP-281 verbs are. Each body names an epoch
 * and nothing else of the claim; the owner is the authenticated worker. The commands are
 * `@platform/application`'s `RemoteRunCalls`; this module only maps their answers to HTTP.
 */
import type { RemoteRunCalls, RunTokenSubject } from '@platform/application';
import { MAX_TRANSCRIPT_SEQ } from '@platform/application';
import {
  apiErrorSchema,
  type Id,
  platformToolNameSchema,
  WORKER_PATHS,
  WORKER_SESSION_BATCH_MAX_BYTES,
  WORKER_TRANSCRIPT_BATCH_MAX_BYTES,
  workerApprovalRequestSchema,
  workerApprovalResponseSchema,
  workerLeaseLostBodySchema,
  workerSessionRequestSchema,
  workerSshSignRequestSchema,
  workerSshSignResponseSchema,
  workerToolCallRequestSchema,
  workerToolCallResponseSchema,
  workerTranscriptRequestSchema,
  workerTranscriptResponseSchema,
  workerUpgradeRequiredBodySchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { HttpError } from '../../errors.js';

export interface WorkerRunCallRoutesOptions {
  /** The commands, or `null` in a process that composed none: `503` by name after authentication. */
  readonly runCalls: RemoteRunCalls | null;
  readonly path: (verb: string) => string;
  /** `protocol.ts`'s run-token authentication (`preValidation`). */
  readonly authenticateRun: (request: FastifyRequest) => Promise<void>;
  /** The run the token authenticated. */
  readonly runHolder: (request: FastifyRequest) => RunTokenSubject;
  readonly leaseLost: (runId: string) => HttpError;
}

const runParamsSchema = z.strictObject({ id: z.uuid() });
const toolParamsSchema = z.strictObject({ id: z.uuid(), name: platformToolNameSchema });

const runErrors = {
  401: apiErrorSchema,
  409: z.union([workerLeaseLostBodySchema, apiErrorSchema]),
  426: workerUpgradeRequiredBodySchema,
  503: apiErrorSchema,
} as const;

const runGone = (runId: string): HttpError =>
  new HttpError(410, 'run_gone', `run ${runId} no longer exists — destroy the workspace`);

const unavailable = (): never => {
  throw new HttpError(
    503,
    'worker_protocol_unavailable',
    'this process composed no worker protocol (it holds no integration stack); ask another API replica',
  );
};

export const registerWorkerRunCallRoutes = (
  app: FastifyInstance,
  options: WorkerRunCallRoutesOptions,
): void => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const calls = (): RemoteRunCalls => options.runCalls ?? unavailable();
  const refused = (runId: string, answer: { readonly kind: 'lease_lost' | 'run_gone' }): never => {
    throw answer.kind === 'run_gone' ? runGone(runId) : options.leaseLost(runId);
  };

  typed.post(
    options.path(WORKER_PATHS.transcript),
    {
      preValidation: options.authenticateRun,
      // TD-031 §9: a batch is at most 256 KiB on the wire; past it Fastify answers 413.
      bodyLimit: WORKER_TRANSCRIPT_BATCH_MAX_BYTES,
      schema: {
        summary: 'Upload transcript entries — re-redacted, stored once per seq (TD-031 §10a)',
        description:
          'Run token. A batch of `{ seq, event }` of at most 256 KiB, for a run held under this epoch (live, or ended within the token’s fifteen minutes). Each entry is validated against `transcriptEventSchema`, **re-redacted** by the run’s full TD-012 redactor (the project’s binding secrets, the platform’s pattern rules and recorded minted-credential shapes, this process’s run-scoped credentials) and stored once per `(run_id, seq)` — a repeat is skipped. An undecodable entry, one naming another run or `seq`, or one dated outside the store’s window is stored at its `seq` as a `system` entry with subtype `ingest_refused` naming paths and messages only, and listed in `refused_seqs`. The `run:<id>` stream is announced as for any run. A run holds at most 100 000 entries: a batch that would pass it is `409 transcript_full` and stores nothing (backlog 754). `409 lease_lost` for another claim; `410 run_gone` (WP-282).',
        tags: ['worker'],
        params: runParamsSchema,
        body: workerTranscriptRequestSchema,
        response: {
          200: workerTranscriptResponseSchema,
          400: apiErrorSchema,
          410: apiErrorSchema,
          ...runErrors,
        },
      },
    },
    async (request): Promise<z.output<typeof workerTranscriptResponseSchema>> => {
      const runId = request.params.id;
      const subject = options.runHolder(request);
      const outOfRange = request.body.entries.find((entry) => entry.seq > MAX_TRANSCRIPT_SEQ);
      if (outOfRange !== undefined) {
        throw new HttpError(
          400,
          'seq_out_of_range',
          `seq ${outOfRange.seq} is past ${MAX_TRANSCRIPT_SEQ}, the largest a transcript row can carry`,
        );
      }
      const answer = await calls().transcript({
        runId: runId as Id,
        workerId: subject.workerId,
        epoch: request.body.epoch,
        entries: request.body.entries,
      });
      if (answer.kind === 'full') {
        throw new HttpError(
          409,
          'transcript_full',
          `run ${runId}'s transcript holds at most ${answer.limit} entries; the batch was not stored`,
        );
      }
      if (answer.kind !== 'stored') return refused(runId, answer);
      return { stored: answer.stored, refused_seqs: [...answer.refusedSeqs] };
    },
  );

  typed.post(
    options.path(WORKER_PATHS.tool),
    {
      preValidation: options.authenticateRun,
      schema: {
        summary: 'Call a platform tool through the core (TD-031 §10b)',
        description:
          'Run token, live run. Runs the production `PlatformToolPort` with a context rebuilt from the run’s stored plan (project, task, mode, what the prompt holds, the run’s redactor). Only a tool the run’s role was given is answered — another is `403 tool_not_granted`, never performed (BD-021). The input is re-parsed by the tool’s strict schema; an invalid one is answered `is_error: true` with the paths, as the in-process MCP server answers the model. A mutating tool is deduplicated on `(run_id, tool_use_id)`: a repeat answers the stored answer and performs nothing, `409 tool_call_in_flight` while the first is performing, `409 tool_use_id_reused` for another tool or input. The answer is redacted. `409 lease_lost` for another claim or an ended run (WP-282).',
        tags: ['worker'],
        params: toolParamsSchema,
        body: workerToolCallRequestSchema,
        response: {
          200: workerToolCallResponseSchema,
          403: apiErrorSchema,
          410: apiErrorSchema,
          ...runErrors,
        },
      },
    },
    async (request, reply): Promise<z.output<typeof workerToolCallResponseSchema>> => {
      const runId = request.params.id;
      const subject = options.runHolder(request);
      // A worker that goes away mid-call aborts the tool's provider calls with it.
      const aborted = new AbortController();
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) aborted.abort();
      });
      const answer = await calls().tool({
        runId: runId as Id,
        workerId: subject.workerId,
        epoch: request.body.epoch,
        name: request.params.name,
        toolUseId: request.body.tool_use_id,
        input: request.body.input,
        signal: aborted.signal,
      });
      switch (answer.kind) {
        case 'answered':
          return { result: answer.result, is_error: answer.isError };
        case 'not_granted':
          throw new HttpError(
            403,
            'tool_not_granted',
            `run ${runId} was not given ${request.params.name}: a tool its role may not use is absent, never performed (BD-021)`,
          );
        case 'in_flight':
          throw new HttpError(
            409,
            'tool_call_in_flight',
            `this tool_use_id of run ${runId} is being performed; ask again for its answer`,
          );
        case 'reused':
          throw new HttpError(
            409,
            'tool_use_id_reused',
            `this tool_use_id of run ${runId} was used for another tool or another input`,
          );
        default:
          return refused(runId, answer);
      }
    },
  );

  typed.post(
    options.path(WORKER_PATHS.approvals),
    {
      preValidation: options.authenticateRun,
      schema: {
        summary: 'Open a tool approval; its decision arrives on a heartbeat (TD-031 §9)',
        description:
          'Run token, live run. Opens one approval per `(run_id, tool_use_id)` — a repeat answers the same id — and asks the platform’s `ToolApprovalPort` after the commit (this build’s is BD-025’s unattended default: deny, with a reason the model can act on). The decision is delivered once, on the run’s next heartbeat (`approvals`). The request’s text is redacted before the port sees it and is not stored. `409 lease_lost` for another claim or an ended run (WP-282).',
        tags: ['worker'],
        params: runParamsSchema,
        body: workerApprovalRequestSchema,
        response: { 200: workerApprovalResponseSchema, 410: apiErrorSchema, ...runErrors },
      },
    },
    async (request): Promise<z.output<typeof workerApprovalResponseSchema>> => {
      const runId = request.params.id;
      const subject = options.runHolder(request);
      const answer = await calls().openApproval({
        runId: runId as Id,
        workerId: subject.workerId,
        epoch: request.body.epoch,
        toolUseId: request.body.tool_use_id,
        toolName: request.body.tool_name,
        detail: request.body.detail,
        input: request.body.input,
        reason: request.body.reason,
      });
      if (answer.kind !== 'opened') return refused(runId, answer);
      return { approval_id: answer.approvalId };
    },
  );

  typed.post(
    options.path(WORKER_PATHS.session),
    {
      preValidation: options.authenticateRun,
      bodyLimit: WORKER_SESSION_BATCH_MAX_BYTES,
      schema: {
        summary: 'Mirror the SDK session — redacted on ingest (TD-007, TD-031 §9)',
        description:
          'Run token, a run held under this epoch (live, or ended within the token’s fifteen minutes). The session file’s JSONL lines from `from_line` on, each redacted by the run’s redactor and stored once per position — a retried upload writes nothing twice. At most 4 MiB per batch and 200 000 lines per run (`409 session_mirror_full` past it). `204`. `409 lease_lost` for another claim (WP-282).',
        tags: ['worker'],
        params: runParamsSchema,
        body: workerSessionRequestSchema,
        response: { 204: z.null(), 410: apiErrorSchema, ...runErrors },
      },
    },
    async (request, reply) => {
      const runId = request.params.id;
      const subject = options.runHolder(request);
      const answer = await calls().session({
        runId: runId as Id,
        workerId: subject.workerId,
        epoch: request.body.epoch,
        sessionId: request.body.session_id,
        fromLine: request.body.from_line,
        lines: request.body.lines,
      });
      if (answer.kind === 'full') {
        throw new HttpError(
          409,
          'session_mirror_full',
          `run ${runId}'s session mirror holds at most ${answer.limit} lines`,
        );
      }
      if (answer.kind !== 'stored') return refused(runId, answer);
      return reply.code(204).send(null);
    },
  );

  typed.post(
    options.path(WORKER_PATHS.sshSign),
    {
      preValidation: options.authenticateRun,
      schema: {
        summary: 'Sign an SSH user-authentication for the run’s deploy key (TD-031 decision 5)',
        description:
          'Run token, a run that is **live at the presented epoch** — a sign after the terminal write, or under an older epoch, is `409 lease_lost`, so a worker exports everything it owes before `finish`. WP-146’s oracle unchanged: only the run’s own key, only an RFC 4252 §7 user-authentication request for user `git`, bounded data; a request it refuses is answered `signature: null` and counts nothing. Every signature is counted against `MAX_DEPLOY_KEY_SIGNATURES` in `run_offers.ssh_signatures`, in the statement that checks the epoch — one cap per run whichever replica or caller (the runlet relay, the helpers’ relayed socket) asked; past it, `null`. A run given no deploy key is answered `null` (WP-282).',
        tags: ['worker'],
        params: runParamsSchema,
        body: workerSshSignRequestSchema,
        response: { 200: workerSshSignResponseSchema, 410: apiErrorSchema, ...runErrors },
      },
    },
    async (request): Promise<z.output<typeof workerSshSignResponseSchema>> => {
      const runId = request.params.id;
      const subject = options.runHolder(request);
      const answer = await calls().sshSign({
        runId: runId as Id,
        workerId: subject.workerId,
        epoch: request.body.epoch,
        request: {
          keyBlob: Buffer.from(request.body.key_blob, 'base64'),
          data: Buffer.from(request.body.data, 'base64'),
          flags: request.body.flags,
        },
      });
      switch (answer.kind) {
        case 'signed':
          return { signature: answer.signature.toString('base64') };
        case 'refused':
          return { signature: null };
        default:
          return refused(runId, answer);
      }
    },
  );
};
