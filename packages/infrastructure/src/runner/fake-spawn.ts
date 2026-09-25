/**
 * `fakeSpawnClaudeCodeProcess` — a scripted Claude Code CLI on the SDK's own transport (TD-025).
 *
 * `Options.spawnClaudeCodeProcess` is the documented seam "to run Claude Code in VMs, containers, or
 * remote environments"; WP-13's `agentic-runlet` is the production implementation. This is the test
 * one: it returns a {@link SpawnedProcess} whose `stdout` replays a scripted NDJSON stream and whose
 * `stdin` is read for the SDK's control protocol, so **the real SDK runs against it** — the real
 * `query()`, the real hook dispatch, the real `canUseTool` round trip, the real result parsing.
 * technical/10 names exactly this ("fake `spawnClaudeCodeProcess` replaying recorded NDJSON
 * transcripts") and it is why the adapter's golden fixtures mean something: nothing in the path from
 * the fixture to the `TranscriptEvent` is stubbed except the model.
 *
 * The protocol it implements — verified against the installed 0.3.267 declarations and confirmed by
 * running the real `query()` against it:
 *
 *  1. the SDK writes `{type:'control_request', request_id, request:{subtype:'initialize', hooks}}`;
 *  2. the fake answers `{type:'control_response', response:{subtype:'success', request_id, response:{}}}`
 *     and remembers the `hookCallbackIds` per event and matcher;
 *  3. the SDK writes the prompt as `{type:'user', message:{…}}` lines;
 *  4. the fake plays its script: stdout messages, `hook_callback` and `can_use_tool` control
 *     requests back to the SDK (whose responses it records), stderr, a stall, an exit.
 *
 * ## Divergence register — a fake may be stricter than the real thing, never kinder
 *
 * | # | Divergence | Direction | Why it is safe |
 * |---|---|---|---|
 * | 1 | A stdin frame before `initialize` throws. The real CLI accepts frames in any order. | **stricter** | The adapter always initialises first; a change that stopped doing so would silently lose the hook registration. Asserted by `rejects a stdin frame that arrives before initialize`. |
 * | 2 | A `hook` step naming an event with no registered callback throws. The real CLI would simply never call it. | **stricter** | Turns "the adapter stopped registering `PostToolUse`" from a silently passing fixture into a failure. Asserted by `throws when the script fires a hook the runner did not register`. |
 * | 3 | A script that ends without `exit` or `stall` throws. A real process can just die. | **stricter** | A fixture that runs off the end is a malformed fixture, and the failure it would otherwise produce (`crash`) looks exactly like a legitimate scenario. |
 * | 4 | A `hook` step does not *act* on its verdict: a `deny` from `PreToolUse` is recorded, not enforced, and the script continues as written. **The `bash` step does** (WP-54): it runs the command only when the platform allowed it — directly, or through `canUseTool` after an `ask` — exactly as the CLI does, and a denied command is never executed. | **different** (the `hook` step) | For the `hook` step the subject under test is the platform's verdict, and the recorded verdicts are asserted positively (`records the deny the command policy returned`). The `bash` step exists because a fake that runs nothing is how PROGRESS backlog 49 survived every tier: its effect is something the *command* produced (a file, an exit status), never the verdict string. |
 * | 7 | The `bash` step runs the command with `/bin/sh -c` in a **host** directory standing in for the container's `/work/repo`, with the test process's `PATH`. The CLI runs it in the run container. | **different** | What this seam can prove is that the platform's policy lets a declared command through and stops an undeclared one, and that the command's own output reaches the transcript. The container, its user and its egress are `test/e2e/workspace/docker-workspace.e2e.test.ts`'s. A script with a `bash` step and no `workdir` throws (**stricter**) rather than running in the test's own directory. |
 * | 5 | `kill(signal)` records the signal and resolves `exit` with it; it does not terminate anything. | **different** | There is no process. `killed`, `exitCode` and the `exit` event follow the `SpawnedProcess` contract, which is what the SDK reads. |
 * | 6 | No stdout backpressure: every scripted line is written immediately. | **kinder** | A real CLI writing 100 MB of tool output would block on the pipe. Nothing in the adapter reads `stdout` directly — the SDK owns that stream — so there is no platform behaviour behind this. The size limit that *is* the platform's (`toolOutputMaxChars`) is tested through the `PostToolUse` hook, in `truncates tool output past the cap`, which does not need backpressure to be reached. |
 *
 * Entry 6 is the kindest, so it carries the positive assertion the standing rule asks for rather
 * than a warning: `truncation.test.ts` proves the cap fires on a 400 000-character body, and
 * `hooks.test.ts` proves the hook rewrites the model's copy of it.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod';

// ── the script ───────────────────────────────────────────────────────────────

const jsonObject = z.record(z.string(), z.unknown());

export const fakeCliStepSchema = z.discriminatedUnion('step', [
  /** Write one line to stdout — an `SDKMessage`, verbatim. */
  z.strictObject({ step: z.literal('emit'), message: jsonObject }),
  /** Wait until the SDK sends a user message (the prompt, or a steer). */
  z.strictObject({ step: z.literal('await_user') }),
  /** Fire one registered hook and wait for the platform's answer. */
  z.strictObject({
    step: z.literal('hook'),
    event: z.string(),
    /** Chooses the matcher, as the CLI does; omit for the first matcher of the event. */
    tool_name: z.string().optional(),
    input: jsonObject,
    tool_use_id: z.string().optional(),
  }),
  /** Ask the platform's `canUseTool` and wait. */
  z.strictObject({
    step: z.literal('can_use_tool'),
    tool_name: z.string(),
    input: jsonObject,
    tool_use_id: z.string(),
    decision_reason: z.string().optional(),
  }),
  /**
   * One `Bash` tool call, played the way the CLI plays it (WP-54): the assistant's `tool_use`, the
   * `PreToolUse(Bash)` hook, `canUseTool` if the hook said `ask`, **the command itself** when — and
   * only when — the platform allowed it, `PostToolUse`, and the `tool_result` the model reads.
   */
  z.strictObject({ step: z.literal('bash'), command: z.string(), tool_use_id: z.string() }),
  z.strictObject({ step: z.literal('stderr'), text: z.string() }),
  /** Stop producing output and never exit — what a hung CLI looks like from outside. */
  z.strictObject({ step: z.literal('stall') }),
  z.strictObject({ step: z.literal('exit'), code: z.int(), signal: z.string().nullable() }),
]);

export const fakeCliScriptSchema = z.array(fakeCliStepSchema);

export type FakeCliStep = z.infer<typeof fakeCliStepSchema>;
export type FakeCliScript = z.infer<typeof fakeCliScriptSchema>;

/** A `bash` step as it happened: what the platform decided, and what the command did if it ran. */
export interface FakeCliExecution {
  readonly toolUseId: string;
  readonly command: string;
  /** The `PreToolUse(Bash)` verdict, then `canUseTool`'s when that one was `ask`. */
  readonly decision: 'allow' | 'deny';
  readonly ran: boolean;
  /** `null` when the command did not run. */
  readonly exitCode: number | null;
  readonly output: string;
}

export interface FakeCliOptions {
  /**
   * The host directory a `bash` step runs in, standing in for the container's `/work/repo`.
   * Required by a script with a `bash` step: running in the test process's own directory would be
   * a command nobody chose the directory for.
   */
  readonly workdir?: string;
  /** Bound on one command's wall clock. */
  readonly commandTimeoutMs?: number;
}

/** What the platform answered, so a test can assert the verdict rather than only its effect. */
export interface RecordedCallback {
  readonly kind: 'hook' | 'can_use_tool';
  readonly event: string;
  readonly toolName: string | null;
  readonly response: unknown;
}

export interface FakeCli {
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  /** The `SpawnOptions` the SDK passed, once it has spawned. */
  readonly spawnOptions: SpawnOptions | null;
  /** Every frame the SDK wrote to stdin, parsed. */
  readonly stdin: readonly Record<string, unknown>[];
  /** Every hook / `canUseTool` answer the platform gave, in order. */
  readonly callbacks: readonly RecordedCallback[];
  /** Signals `kill()` was called with. */
  readonly signals: readonly string[];
  /** Every `bash` step, in order: the decision and, when it ran, the command's own result. */
  readonly executions: readonly FakeCliExecution[];
  /** Resolves when the script has finished (or thrown). */
  readonly finished: Promise<void>;
}

interface HookRegistration {
  readonly event: string;
  readonly matcher: string | undefined;
  readonly callbackId: string;
}

class FakeCliError extends Error {
  constructor(message: string) {
    super(`fake claude cli: ${message}`);
    this.name = 'FakeCliError';
  }
}

const matcherMatches = (matcher: string | undefined, toolName: string | undefined): boolean =>
  matcher === undefined
    ? true
    : toolName !== undefined && new RegExp(`^(?:${matcher})$`).test(toolName);

/**
 * Builds the fake.
 *
 * `script` is played once the SDK has initialised. Steps run in order; the two control-request
 * steps wait for the platform's answer before the next step, exactly as the CLI does.
 */
export const fakeSpawnClaudeCodeProcess = (
  rawScript: FakeCliScript,
  options: FakeCliOptions = {},
): FakeCli => {
  const script = fakeCliScriptSchema.parse(rawScript);
  if (script.some((step) => step.step === 'bash') && options.workdir === undefined) {
    throw new FakeCliError('a script with a `bash` step needs a workdir to run the command in');
  }
  const executions: FakeCliExecution[] = [];
  const stdinFrames: Record<string, unknown>[] = [];
  const callbacks: RecordedCallback[] = [];
  const signals: string[] = [];
  const hooks: HookRegistration[] = [];
  const pendingResponses = new Map<string, (response: unknown) => void>();
  const userMessages: (() => void)[] = [];
  let pendingUserMessages = 0;
  let initialised = false;
  let spawnOptions: SpawnOptions | null = null;
  let requestCounter = 0;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  finished.catch(() => undefined);

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  let exitCode: number | null = null;
  let killed = false;

  // What the `bash` step stamps on the messages it writes: the session and the model the script's
  // own `init` announced, so its turns belong to the same session as every other line.
  let sessionId = 'fake-session-bash';
  let model = 'claude-opus-5';
  const write = (message: unknown): void => {
    const fields = message as Record<string, unknown>;
    if (typeof fields['session_id'] === 'string') {
      sessionId = fields['session_id'];
    }
    if (fields['subtype'] === 'init' && typeof fields['model'] === 'string') {
      model = fields['model'];
    }
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  const awaitUserMessage = (): Promise<void> => {
    if (pendingUserMessages > 0) {
      pendingUserMessages -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      userMessages.push(resolve);
    });
  };

  const request = (payload: Record<string, unknown>): Promise<unknown> => {
    requestCounter += 1;
    const requestId = `fake-${requestCounter}`;
    const answer = new Promise<unknown>((resolve) => {
      pendingResponses.set(requestId, resolve);
    });
    write({ type: 'control_request', request_id: requestId, request: payload });
    return answer;
  };

  const hookFor = (event: string, toolName: string | undefined): HookRegistration => {
    const registration = hooks.find(
      (hook) => hook.event === event && matcherMatches(hook.matcher, toolName),
    );
    if (registration === undefined) {
      throw new FakeCliError(
        `the script fires ${event}(${toolName ?? ''}) but the platform registered no callback for it`,
      );
    }
    return registration;
  };

  const fireHook = async (
    event: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
  ): Promise<unknown> => {
    const response = await request({
      subtype: 'hook_callback',
      callback_id: hookFor(event, toolName).callbackId,
      input: { ...input, hook_event_name: event },
      tool_use_id: toolUseId,
    });
    callbacks.push({ kind: 'hook', event, toolName, response });
    return response;
  };

  /** The platform's answer to one Bash call: the hook's verdict, then `canUseTool`'s on `ask`. */
  const decide = async (command: string, toolUseId: string): Promise<'allow' | 'deny'> => {
    const response = (await fireHook(
      'PreToolUse',
      'Bash',
      { tool_name: 'Bash', tool_input: { command }, tool_use_id: toolUseId },
      toolUseId,
    )) as { hookSpecificOutput?: { permissionDecision?: string } } | undefined;
    const verdict = response?.hookSpecificOutput?.permissionDecision;
    if (verdict === 'allow') {
      return 'allow';
    }
    if (verdict !== 'ask') {
      // `deny`, or no verdict at all — which the CLI would take to its own permission prompt and a
      // non-interactive run cannot answer. Stricter: nothing runs.
      return 'deny';
    }
    const answer = (await request({
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command },
      tool_use_id: toolUseId,
    })) as { behavior?: string } | undefined;
    callbacks.push({
      kind: 'can_use_tool',
      event: 'can_use_tool',
      toolName: 'Bash',
      response: answer,
    });
    return answer?.behavior === 'allow' ? 'allow' : 'deny';
  };

  const runCommand = (command: string): Promise<{ exitCode: number; output: string }> =>
    new Promise((resolve) => {
      execFile(
        '/bin/sh',
        ['-c', command],
        {
          cwd: options.workdir,
          // The test's `PATH`, so `npm`/`node` resolve; `HOME` is the workdir, so a tool that writes
          // a cache (npm does) writes it into the fixture copy and not into the host user's home.
          env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: options.workdir ?? '' },
          timeout: options.commandTimeoutMs ?? 60_000,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({ exitCode: code, output: `${stdout}${stderr}` });
        },
      );
    });

  const playBash = async (command: string, toolUseId: string): Promise<FakeCliExecution> => {
    write({
      type: 'assistant',
      message: {
        id: `msg_${toolUseId}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: sessionId,
    });
    const decision = await decide(command, toolUseId);
    const result =
      decision === 'allow' ? await runCommand(command) : { exitCode: null, output: '' };
    let content =
      decision === 'allow'
        ? `exit code ${String(result.exitCode)}\n${result.output}`
        : 'the platform denied this command';
    if (decision === 'allow') {
      const post = (await fireHook(
        'PostToolUse',
        'Bash',
        {
          tool_name: 'Bash',
          tool_input: { command },
          tool_response: { stdout: content, stderr: '', interrupted: false },
          tool_use_id: toolUseId,
        },
        toolUseId,
      )) as { hookSpecificOutput?: { updatedToolOutput?: unknown } } | undefined;
      const updated = post?.hookSpecificOutput?.updatedToolOutput;
      if (typeof updated === 'string') {
        content = updated;
      }
    }
    write({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            is_error: decision !== 'allow' || result.exitCode !== 0,
            content,
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: sessionId,
    });
    return {
      toolUseId,
      command,
      decision,
      ran: decision === 'allow',
      exitCode: result.exitCode,
      output: result.output,
    };
  };

  const play = async (): Promise<void> => {
    for (const step of script) {
      switch (step.step) {
        case 'emit':
          write(step.message);
          break;
        case 'bash':
          executions.push(await playBash(step.command, step.tool_use_id));
          break;
        case 'stderr':
          // The SDK reads stderr from the process it spawned; a custom SpawnedProcess has no
          // stderr stream in the interface, so it is delivered as a `stderr` system line the SDK
          // forwards. Recorded here so the shape is visible even though the SDK ignores it.
          write({ type: 'system', subtype: 'stderr', text: step.text });
          break;
        case 'await_user':
          await awaitUserMessage();
          break;
        case 'hook': {
          const matching = hooks.filter(
            (hook) => hook.event === step.event && matcherMatches(hook.matcher, step.tool_name),
          );
          const registration = matching[0];
          if (registration === undefined) {
            throw new FakeCliError(
              `the script fires ${step.event}${step.tool_name === undefined ? '' : `(${step.tool_name})`} ` +
                'but the platform registered no callback for it',
            );
          }
          const response = await request({
            subtype: 'hook_callback',
            callback_id: registration.callbackId,
            input: { ...step.input, hook_event_name: step.event },
            tool_use_id: step.tool_use_id,
          });
          callbacks.push({
            kind: 'hook',
            event: step.event,
            toolName: step.tool_name ?? null,
            response,
          });
          break;
        }
        case 'can_use_tool': {
          const response = await request({
            subtype: 'can_use_tool',
            tool_name: step.tool_name,
            input: step.input,
            tool_use_id: step.tool_use_id,
            decision_reason: step.decision_reason,
          });
          callbacks.push({
            kind: 'can_use_tool',
            event: 'can_use_tool',
            toolName: step.tool_name,
            response,
          });
          break;
        }
        case 'stall':
          // Deliberately never resolves: the platform's stall detector is the only thing that can
          // end this run, which is the whole point of the scenario.
          await new Promise<never>(() => {});
          break;
        case 'exit':
          exitCode = step.code;
          stdout.end();
          events.emit('exit', step.code, step.signal);
          return;
      }
    }
    throw new FakeCliError('the script ended without an `exit` or a `stall` step');
  };

  const registerHooks = (payload: unknown): void => {
    const table = (payload ?? {}) as Record<
      string,
      { matcher?: string; hookCallbackIds: string[] }[]
    >;
    for (const [event, matchers] of Object.entries(table)) {
      for (const matcher of matchers) {
        for (const callbackId of matcher.hookCallbackIds) {
          hooks.push({ event, matcher: matcher.matcher, callbackId });
        }
      }
    }
  };

  const onFrame = (frame: Record<string, unknown>): void => {
    stdinFrames.push(frame);
    const type = frame['type'];
    if (type === 'control_response') {
      const response = frame['response'] as Record<string, unknown> | undefined;
      const requestId = response?.['request_id'] as string | undefined;
      if (requestId !== undefined) {
        pendingResponses.get(requestId)?.(response?.['response'] ?? response);
        pendingResponses.delete(requestId);
      }
      return;
    }
    if (type === 'control_request') {
      const inner = frame['request'] as Record<string, unknown> | undefined;
      const requestId = frame['request_id'] as string;
      if (inner?.['subtype'] === 'initialize') {
        initialised = true;
        registerHooks(inner['hooks']);
        write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: { hooks_applied: true },
          },
        });
        play().then(finish, (error: Error) => {
          fail(error);
          events.emit('error', error);
        });
        return;
      }
      // Everything else (interrupt, set_model, …) is acknowledged so the SDK's promise settles.
      write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: {} },
      });
      return;
    }
    if (!initialised) {
      const error = new FakeCliError(`a "${String(type)}" frame arrived before initialize`);
      fail(error);
      events.emit('error', error);
      return;
    }
    if (type === 'user') {
      const waiting = userMessages.shift();
      if (waiting === undefined) {
        pendingUserMessages += 1;
      } else {
        waiting();
      }
    }
  };

  let buffer = '';
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      onFrame(JSON.parse(line) as Record<string, unknown>);
    }
  });

  const process_: SpawnedProcess = {
    stdin,
    stdout,
    get killed() {
      return killed;
    },
    get exitCode() {
      return exitCode;
    },
    kill: (signal) => {
      signals.push(signal);
      killed = true;
      exitCode ??= null;
      events.emit('exit', null, signal);
      return true;
    },
    on: (event: 'exit' | 'error', listener: (...args: never[]) => void) => {
      events.on(event, listener as (...args: unknown[]) => void);
    },
    once: (event: 'exit' | 'error', listener: (...args: never[]) => void) => {
      events.once(event, listener as (...args: unknown[]) => void);
    },
    off: (event: 'exit' | 'error', listener: (...args: never[]) => void) => {
      events.off(event, listener as (...args: unknown[]) => void);
    },
  } as SpawnedProcess;

  return {
    finished,
    get spawnOptions() {
      return spawnOptions;
    },
    get stdin() {
      return stdinFrames;
    },
    get callbacks() {
      return callbacks;
    },
    get signals() {
      return signals;
    },
    get executions() {
      return executions;
    },
    spawn: (options: SpawnOptions): SpawnedProcess => {
      if (spawnOptions !== null) {
        throw new FakeCliError('spawn was called twice for one run');
      }
      spawnOptions = options;
      return process_;
    },
  };
};
