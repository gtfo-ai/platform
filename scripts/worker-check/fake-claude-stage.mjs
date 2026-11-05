#!/usr/bin/env node
/**
 * A **stage-aware** stand-in for the Claude Code CLI (S-22.14, backlog 761), baked into the check's
 * derived run image as `/usr/local/bin/claude` by `scripts/worker-compose-check.mjs` — never into a
 * product image. The shim `execve`s it exactly as it would the real CLI, so everything between the
 * worker and this process (the launcher, the run container, the shim's socket, the SDK's stream-json
 * protocol, the platform MCP server in the worker) is production.
 *
 * It speaks the least of the SDK protocol a run needs (`test/fixtures/runlet/fake-claude-cli` is the
 * shape): every `control_request` the SDK sends is answered `success`; on the first user turn it emits
 * `system/init`, one assistant message and a `result` whose `structured_output` is the artifact of
 * the stage — chosen off the `--json-schema` the SDK passes, by the artifact's own required keys
 * (`goal` → RefinedSpec, `approach` → ImplementationPlan, …), so the platform's own validator decides
 * whether it is acceptable. An unknown schema ends the run `error_during_execution`, naming its keys.
 *
 * **The developer stage** writes `src/totals.ts` in its working tree, asks the platform's `open_mr`
 * tool **through the SDK** — a `control_request` with subtype `mcp_message` to the `platform` server,
 * as the real CLI calls an SDK MCP tool — then commits and `git push`es the task's branch from the run
 * container (the egress proxy, the credential helper or the SSH route), and reports the merge request.
 * **The refinement stage** probes the worker's local page from the run container (`probe`).
 *
 * Everything it emits is fixed text with obviously fake numbers.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SESSION = 'fake-session-worker-check';
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
};
let schema = {};
try {
  schema = JSON.parse(flag('--json-schema') ?? '{}');
} catch {
  schema = {};
}
const required = new Set(Array.isArray(schema.required) ? schema.required : []);
const model = flag('--model') ?? 'claude-opus-5';

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const ARTIFACTS = [
  [
    'goal',
    () => ({
      goal: 'Show the totals in the invoice footer.',
      user_value: 'Finance can read an invoice without a calculator.',
      in_scope: ['the invoice footer'],
      out_of_scope: ['the PDF export'],
      acceptance_criteria: [
        {
          id: 'ac1',
          given: 'an invoice with three lines',
          when: 'it is rendered',
          // biome-ignore lint/suspicious/noThenProperty: the published acceptance-criterion field name
          then: 'the footer shows the sum of the lines',
          validation: { kind: 'test', value: 'totals.test.ts' },
        },
      ],
      non_functional: [],
      dependencies: [],
      size: 'M',
      drift: { flag: false, justification: 'in the documented direction' },
      assumptions: [],
      questions: [],
      decision: 'proceed',
      kb_citations: [],
    }),
  ],
  [
    'approach',
    () => ({
      approach: 'Sum the invoice model in the renderer.',
      alternatives_considered: [
        { option: 'sum in SQL', why_not: 'the view already has the model' },
      ],
      affected_modules: ['invoices'],
      files_to_change: [{ path: 'src/totals.ts', change: 'sum the model' }],
      data_changes: [],
      api_changes: [],
      validation_contract: [
        { criterion_id: 'ac1', check: { kind: 'test', value: 'totals.test.ts' } },
      ],
      test_plan: ['totals.test.ts'],
      rollout_notes: 'no flag needed',
      risks: [],
      estimated_size: 'M',
      decisions_to_record: [],
      protected_path_changes: [],
    }),
  ],
  [
    'deviations_from_plan',
    (mr) => ({
      summary: 'Summed the invoice model in the footer.',
      deviations_from_plan: [],
      tests_added: ['totals.test.ts'],
      commands_run: [{ command: 'npm test', exit_code: 0, summary: '12 passed' }],
      known_gaps: [],
      followup_tickets: [],
      mr: { iid: mr.iid, url: mr.url, branch: mr.source_branch ?? null, head_sha: null },
    }),
  ],
  [
    'protected_path_changes_confirmed',
    () => ({
      verdict: 'approve',
      findings: [],
      summary: 'Matches the plan; the test covers the criterion.',
      protected_path_changes_confirmed: [],
    }),
  ],
  [
    'scope_creep',
    () => ({
      verdict: 'approve',
      criteria: [
        { id: 'ac1', status: 'met', evidence: 'totals.test.ts passes on the head commit' },
      ],
      scope_creep: [],
      missing: [],
      ux_notes: [],
    }),
  ],
  [
    'what_went_well',
    () => ({
      what_went_well: ['the plan held'],
      returns: [],
      human_corrections: [],
      cost_summary: { total_usd: 0.1, is_estimate: false, by_stage: [] },
      proposals: [],
    }),
  ],
  ['health', () => ({ proposals: [], health: [], summary: 'Nothing to add.' })],
];

/** Requests this process sent the SDK, answered by `control_response`. */
const pending = new Map();
let nextRequest = 0;
const askSdk = (request) =>
  new Promise((resolve, reject) => {
    nextRequest += 1;
    const id = `wcc-${String(nextRequest)}`;
    pending.set(id, { resolve, reject });
    write({ type: 'control_request', request_id: id, request });
  });
const mcp = async (method, params, id) => {
  const answer = await askSdk({
    subtype: 'mcp_message',
    server_name: 'platform',
    message: { jsonrpc: '2.0', id, method, params },
  });
  return answer?.mcp_response;
};

const openMergeRequest = async () => {
  await mcp(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-claude-stage', version: '0.0.0' },
    },
    1,
  );
  const called = await mcp(
    'tools/call',
    {
      name: 'open_mr',
      arguments: {
        title: 'Sum the invoice footer',
        description: 'Opened by the worker check’s developer stage.',
      },
    },
    2,
  );
  const text = called?.result?.content?.[0]?.text;
  if (called?.result?.isError === true || typeof text !== 'string') {
    throw new Error(
      `open_mr did not answer a merge request: ${JSON.stringify(called).slice(0, 400)}`,
    );
  }
  return JSON.parse(text);
};

/**
 * Commits the working tree and pushes it to the task's branch **from the run container**, as the
 * model's own `git push` would: through the run's egress proxy and the platform's credential helper
 * (a static token) or its SSH route and the helper agent socket (a deploy key). Throws on a failure,
 * so a push the platform's plumbing refused ends the run with git's own words.
 */
const pushBranch = (branch) => {
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=fake-claude-stage', '-c', 'user.email=fake@example.invalid', ...args],
      { cwd: process.cwd(), env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  git('add', '-A');
  git('commit', '-q', '-m', 'Sum the invoice footer');
  git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  return `fake-claude-stage pushed ${branch}`;
};

/**
 * WP-292 (6), asked **from a run container**: can it connect to the worker's local page? The check
 * seeds `.wcc-probe-targets` (the worker's name and addresses) into the repository; each target is
 * tried on the page's port with a three-second bound and reported as one line of this message.
 */
const probe = async () => {
  let targets = [];
  try {
    targets = JSON.parse(readFileSync(path.join(process.cwd(), '.wcc-probe-targets'), 'utf8'));
  } catch {
    return ['wcc-probe none'];
  }
  return Promise.all(
    targets.map((target) =>
      fetch(`http://${target}:7357/`, { signal: AbortSignal.timeout(3_000) }).then(
        (response) => `wcc-probe ${target} reached ${response.status}`,
        () => `wcc-probe ${target} unreachable`,
      ),
    ),
  );
};

const result = (fields) =>
  write({
    type: 'result',
    duration_ms: 1200,
    duration_api_ms: 1000,
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: { input_tokens: 120, output_tokens: 40 },
    modelUsage: {},
    permission_denials: [],
    uuid: '20000003-0000-4000-8000-000000000000',
    session_id: SESSION,
    ...fields,
  });

const run = async () => {
  write({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: '2.1.267',
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [{ name: 'platform', status: 'connected' }],
    model,
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: '20000001-0000-4000-8000-000000000000',
    session_id: SESSION,
  });
  const artifact = ARTIFACTS.find(([key]) => required.has(key));
  if (artifact === undefined) {
    result({
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 1,
      errors: [`fake-claude-stage: no artifact for a schema requiring ${[...required].join(',')}`],
    });
    return;
  }
  let mr = null;
  const said = [`fake-claude-stage answered ${artifact[0]}`];
  if (artifact[0] === 'goal') said.push(...(await probe()));
  if (artifact[0] === 'deviations_from_plan') {
    mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
    writeFileSync(
      path.join(process.cwd(), 'src', 'totals.ts'),
      'export const total = (lines: number[]) => lines.reduce((a, b) => a + b, 0);\n',
    );
    mr = await openMergeRequest();
    said.push(pushBranch(mr.source_branch));
  }
  write({
    type: 'assistant',
    message: {
      id: 'msg_worker_check_0001',
      type: 'message',
      role: 'assistant',
      model,
      content: said.map((text) => ({ type: 'text', text })),
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 40 },
    },
    parent_tool_use_id: null,
    uuid: '20000002-0000-4000-8000-000000000000',
    session_id: SESSION,
  });
  result({
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: `fake-claude-stage answered ${artifact[0]}`,
    structured_output: artifact[1](mr),
  });
};

let buffered = '';
let started = false;
process.stdin.on('data', (chunk) => {
  buffered += chunk.toString('utf8');
  for (;;) {
    const newline = buffered.indexOf('\n');
    if (newline < 0) return;
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line.length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.type === 'control_request') {
      write({
        type: 'control_response',
        response: { subtype: 'success', request_id: frame.request_id, response: {} },
      });
    } else if (frame.type === 'control_response') {
      const waiting = pending.get(frame.response?.request_id);
      if (waiting !== undefined) {
        pending.delete(frame.response.request_id);
        if (frame.response.subtype === 'success') waiting.resolve(frame.response.response);
        else waiting.reject(new Error(String(frame.response.error ?? 'control request refused')));
      }
    } else if (frame.type === 'user' && !started) {
      started = true;
      run().catch((error) => {
        process.stderr.write(`fake-claude-stage: ${String(error)}\n`);
        result({
          subtype: 'error_during_execution',
          is_error: true,
          num_turns: 1,
          errors: [String(error).slice(0, 500)],
        });
      });
    }
  }
});
process.stdin.on('end', () => process.stdout.end());
