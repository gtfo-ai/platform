/**
 * **A `remote-worker` beside a pipeline e2e instance** — WP-283 (4)'s fake worker.
 *
 * What is real: `startRemoteWorker` (the production composition — the credential file, the
 * handshake, the claim loop, the run session over `createWorkspaceClaudeRunner` and
 * `createClaudeRunner`, the HTTP sink, tool port and approvals, the helper agent socket), the HTTP
 * between it and the core (a real socket to a real `apps/server` instance), and **its launcher**:
 * `apps/launcher`'s own `LauncherService` behind its own control plane, applying the `relayed`
 * carriage and parsing every create with `relayedCreateRunRequestSchema`, over the **fake
 * workspace provider** — which, with `relayedSigning`, asks the helper agent socket for a
 * signature per mirror update and export as a helper's `ssh` does.
 *
 * What is a double: the provider's containers (the fake's divergence register) and the CLI — the
 * fake provider's control socket has nothing listening (its divergence 2), so the worker's
 * `spawnFor` seam hands the runner the scripted CLI the pipeline e2e uses (`agent-workspace.ts`).
 * A developer run's `open_mr` is asked of the core **over the worker protocol** before the CLI plays,
 * as the model would ask it through the platform tools (the scripted CLI calls no MCP tool).
 *
 * The worker is registered as the device flow would leave it — a `workers` row with the hashed
 * credential and the credential file in its state directory — because the flow itself is the unit
 * and contract tiers' (`runtime.test.ts`, `test/contract/worker/`).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JsonObject, RunPackage } from '@platform/contracts';
import {
  launcher as launcherAdapters,
  runner as runnerAdapters,
  workspace as workspaceAdapters,
} from '@platform/infrastructure';
import { startControlPlane } from '../../../apps/launcher/src/control-plane.js';
import { LauncherService } from '../../../apps/launcher/src/service.js';
import {
  type CoreFetch,
  createCoreClient,
} from '../../../apps/server/src/remote-worker/core-client.js';
import { CREDENTIAL_FILE } from '../../../apps/server/src/remote-worker/credential.js';
import {
  type RemoteWorkerRuntime,
  startRemoteWorker,
} from '../../../apps/server/src/remote-worker/runtime.js';
import { mintWorkerCredential } from '../../../apps/server/src/workers/secrets.js';
import { fakeCliScriptFor, interruptedResultFor } from './agent-workspace.js';
import type { PipelineE2E, ScenarioSpec } from './pipeline.js';

/** Obviously fake, in no shape a pattern rule knows (rule 93): only the worker's own redactor catches it. */
export const WORKER_CLAUDE_TOKEN = 'FAKE-claude-oauth-token-e2e-worker-not-real-0001';

const digest = (char: string): string => `sha256:${char.repeat(64)}`;
/** The core's four images, as `APP_WORKER_IMAGE_DIGESTS` pins them on the core under test. */
export const CORE_DIGESTS = {
  platform: digest('1'),
  platform_launcher: digest('2'),
  platform_runtime: digest('3'),
  platform_egress: digest('4'),
} as const;
export const CORE_DIGESTS_ENV = Object.entries(CORE_DIGESTS)
  .map(([name, value]) => `${name}=${value}`)
  .join(',');

/** One request the worker made to its core, whole. */
export interface CapturedCoreRequest {
  readonly worker: string;
  readonly verb: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface WorkerUnderTest {
  readonly name: string;
  readonly runtime: RemoteWorkerRuntime;
  readonly workerId: string;
  readonly userId: string;
  readonly provider: workspaceAdapters.FakeWorkspaceProvider;
  /** Every create request this worker's launcher was sent, as it arrived on the control plane. */
  readonly launcherCreates: readonly JsonObject[];
  /** Every end request this worker's launcher was sent (the export it was asked for). */
  readonly launcherEnds: readonly { readonly runId: string; readonly body: JsonObject }[];
  /** Every package this worker claimed, in order. */
  readonly packages: readonly RunPackage[];
  readonly clis: ReadonlyMap<string, runnerAdapters.FakeCli>;
  stop(): Promise<void>;
}

export interface WorkerUnderTestOptions {
  readonly name: string;
  /** Where the worker reaches its core — an instance's `baseUrl`, or a {@link CoreProxy}'s. */
  readonly coreUrl: string;
  /** The worker's user; absent, a new user who is made a `member` of the project. */
  readonly userId?: string;
  /** The scenario of a claimed run; absent, the harness's own scenario for its stage. */
  readonly scenario: (pkg: RunPackage) => ScenarioSpec;
  /** Awaited in the run's provision, before the CLI plays — a test holds a run here. */
  readonly hold?: (pkg: RunPackage) => Promise<void>;
  readonly concurrency?: number;
  /** Every request any worker makes, shared, so one assertion can read them all. */
  readonly captured: CapturedCoreRequest[];
  readonly logs?: string[];
  /**
   * `finish:<run>` and `end:<run>` in the order they left this process — what "every export before
   * `finish`" is asserted on (TD-031's 2026-11-04 amendment §4).
   */
  readonly sequence?: string[];
  /** Words the scripted model also says, in an assistant message of its own (a planted secret). */
  readonly echo?: (pkg: RunPackage) => string | null;
}

/** The scripted CLI's script with one more assistant message, before its `result`. */
const withEcho = (
  script: runnerAdapters.FakeCliScript,
  model: string,
  text: string | null,
): runnerAdapters.FakeCliScript => {
  if (text === null) return script;
  const at = script.findIndex(
    (step) => step.step === 'emit' && (step.message as { type?: unknown }).type === 'result',
  );
  const echo: runnerAdapters.FakeCliScript[number] = {
    step: 'emit',
    message: {
      type: 'assistant',
      message: {
        id: 'msg_echo',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      parent_tool_use_id: null,
      uuid: '00000005-0000-4000-8000-000000000000',
      session_id: 'fake-session-e2e',
    },
  };
  return at < 0 ? [...script, echo] : [...script.slice(0, at), echo, ...script.slice(at)];
};

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/** A fetch that answers what the core answers and records what the worker sent. */
const recordingFetch =
  (worker: string, captured: CapturedCoreRequest[], sequence?: string[]): CoreFetch =>
  async (url, init) => {
    const verb = new URL(url).pathname.replace('/api/worker/v1/', '');
    const finished = /^runs\/([0-9a-f-]{36})\/finish$/.exec(verb);
    if (finished !== null) sequence?.push(`finish:${finished[1]}`);
    captured.push({
      worker,
      verb: verb.replace(/[0-9a-f-]{36}/, ':id'),
      headers: { ...(init.headers as Record<string, string>) },
      body: String(init.body ?? ''),
    });
    return fetch(url, init);
  };

export const startWorkerUnderTest = async (
  pipeline: PipelineE2E,
  options: WorkerUnderTestOptions,
): Promise<WorkerUnderTest> => {
  const scratch = mkdtempSync(path.join(tmpdir(), `e2e-worker-${options.name}-`));
  const controlRoot = path.join(scratch, 'ctl');
  const stateDir = path.join(scratch, 'state');
  const exportDir = path.join(scratch, 'exports');
  for (const directory of [controlRoot, stateDir, exportDir]) {
    mkdirSync(directory, { recursive: true });
  }

  // The worker as the device flow leaves it: a row with the hashed credential, the file beside it.
  const userId =
    options.userId ??
    (
      await pipeline.query<{ id: string }>(
        'insert into users (email, name) values ($1, $2) returning id',
        [`${options.name}@example.test`, options.name],
      )
    )[0]?.id;
  if (userId === undefined) throw new Error('the worker’s user could not be created');
  await pipeline.query(
    `insert into project_members (project_id, user_id, role) values ($1, $2, 'member')
     on conflict do nothing`,
    [pipeline.projectId, userId],
  );
  const minted = mintWorkerCredential();
  await pipeline.query(
    `insert into workers (id, user_id, name, credential_hash, last_seen_at, concurrency)
     values ($1, $2, $3, $4, now(), $5)`,
    [minted.workerId, userId, options.name, minted.credentialHash, options.concurrency ?? 1],
  );
  writeFileSync(path.join(stateDir, CREDENTIAL_FILE), `${minted.credential}\n`, { mode: 0o600 });

  // Its launcher: the production service and control plane, relayed, over the fake provider.
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const provider = new workspaceAdapters.FakeWorkspaceProvider({
    controlRoot,
    relayedSigning: { controlRoot },
  });
  const service = new LauncherService({
    provider,
    broker: new workspaceAdapters.RunCredentialBroker(logger),
    clock: runnerAdapters.systemClock,
    logger,
    exportDir,
    retentionSweepMs: 3_600_000,
  });
  const launcherToken = randomUUID().replaceAll('-', '');
  const controlPlane = await startControlPlane({
    service,
    token: launcherToken,
    host: '127.0.0.1',
    port: 0,
    controlRoot,
    runtimeImage: 'platform-runtime:e2e',
    claudeCodePath: '/usr/local/bin/claude',
    deployKeyCarriage: 'relayed',
    imageDigests: async () => ({
      run: CORE_DIGESTS.platform_runtime,
      egress: CORE_DIGESTS.platform_egress,
    }),
    logger,
  });
  const launcherCreates: JsonObject[] = [];
  const launcherEnds: { runId: string; body: JsonObject }[] = [];
  const launcher = launcherAdapters.createLauncherControlClient({
    baseUrl: `http://127.0.0.1:${controlPlane.port}`,
    token: launcherToken,
    fetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      const body = init.body === undefined ? null : JSON.parse(init.body);
      if (pathname === '/v1/runs' && init.method === 'POST' && body !== null) {
        launcherCreates.push(body as JsonObject);
      }
      const ended = /\/v1\/runs\/([^/]+)\/end$/.exec(pathname);
      if (ended !== null && body !== null) {
        launcherEnds.push({ runId: ended[1] as string, body: body as JsonObject });
        options.sequence?.push(`end:${ended[1]}`);
      }
      return fetch(url, init);
    },
  });

  const packages: RunPackage[] = [];
  const clis = new Map<string, runnerAdapters.FakeCli>();
  const coreFetch = recordingFetch(options.name, options.captured, options.sequence);
  const runtime = await startRemoteWorker({
    config: {
      coreUrl: options.coreUrl,
      claudeToken: WORKER_CLAUDE_TOKEN,
      launcherUrl: `http://127.0.0.1:${controlPlane.port}`,
      launcherToken,
      controlRoot,
      stateDir,
      concurrency: options.concurrency ?? 1,
      imageDigests: [CORE_DIGESTS.platform_runtime, CORE_DIGESTS.platform_egress],
      host: '127.0.0.1',
      port: 0,
      logLevel: options.logs === undefined ? 'silent' : 'debug',
      commit: null,
    },
    coreFetch,
    launcher,
    ...(options.logs === undefined
      ? {}
      : { logDestination: { write: (line: string) => (options.logs as string[]).push(line) } }),
    spawnFor: async ({ pkg }) => {
      packages.push(pkg);
      await options.hold?.(pkg);
      const spec = pkg.run as Parameters<typeof fakeCliScriptFor>[0];
      // A developer run asks the core for its merge request through the platform tool, as the
      // model would — over the worker protocol, under the run token (TD-031 §10b).
      if (spec.platformTools.includes('open_mr') && spec.mode !== 'shadow') {
        const answer = await createCoreClient({ baseUrl: options.coreUrl, fetch: coreFetch })
          .forRun(pkg.runId, pkg.runToken)
          .tool('open_mr', {
            epoch: pkg.epoch,
            tool_use_id: randomUUID(),
            input: {
              title: `${spec.stage ?? 'the run'} change`,
              description: 'Opened by the remote worker of the e2e harness.',
            },
          });
        if (answer.is_error) {
          throw new Error(`open_mr through the worker protocol failed: ${String(answer.result)}`);
        }
      }
      const cli = runnerAdapters.fakeSpawnClaudeCodeProcess(
        withEcho(
          fakeCliScriptFor(spec, options.scenario(pkg)),
          spec.model,
          options.echo?.(pkg) ?? null,
        ),
        { interruptedResult: interruptedResultFor(spec) },
      );
      clis.set(pkg.runId, cli);
      return cli.spawn;
    },
  });
  await runtime.listen();
  return {
    name: options.name,
    runtime,
    workerId: minted.workerId,
    userId,
    provider,
    launcherCreates,
    launcherEnds,
    packages,
    clis,
    stop: async () => {
      await runtime.stop();
      await controlPlane.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
};

/**
 * A forwarding proxy in front of a core — what lets a test **restart the core** under a worker
 * whose `APP_CORE_URL` cannot change: retarget it to `null` (the core is down: every request is a
 * `502`, a transient failure the worker retries) and then to the new process.
 */
export interface CoreProxy {
  readonly url: string;
  retarget(target: string | null): void;
  close(): Promise<void>;
}

export const startCoreProxy = async (target: string): Promise<CoreProxy> => {
  let current: string | null = target;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const upstream = current;
      if (upstream === null) {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { code: 'bad_gateway', message: 'the core is down' } }),
        );
        return;
      }
      const body = await readBody(request);
      const controller = new AbortController();
      request.on('close', () => {
        if (!response.writableFinished) controller.abort();
      });
      try {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (
            typeof value === 'string' &&
            !['host', 'connection', 'content-length'].includes(name)
          ) {
            headers[name] = value;
          }
        }
        const answer = await fetch(`${upstream}${request.url ?? '/'}`, {
          method: request.method ?? 'GET',
          headers,
          ...(body.length === 0 ? {} : { body: new Uint8Array(body) }),
          signal: controller.signal,
          redirect: 'manual',
        });
        const out: Record<string, string> = {};
        answer.headers.forEach((value, name) => {
          if (
            !['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(
              name,
            )
          ) {
            out[name] = value;
          }
        });
        const bytes = Buffer.from(await answer.arrayBuffer());
        response.writeHead(answer.status, out);
        response.end(bytes);
      } catch {
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'application/json' });
        }
        response.end(
          JSON.stringify({ error: { code: 'bad_gateway', message: 'the core went away' } }),
        );
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    retarget: (next) => {
      current = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
