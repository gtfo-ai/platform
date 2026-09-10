/**
 * The data the fake backend serves, parsed by the schemas `@platform/contracts` publishes.
 *
 * Every fixture goes through its own schema at module load, so a fixture that drifts from the
 * contract fails the suite where it is defined rather than as a blank screen three files later.
 * That is the same rule the client applies to a live response (`api/http.ts`), pointed at the test
 * corpus — and it means the Playwright suite cannot pass against a shape the real server could
 * never send.
 *
 * ### The hostile strings are the point
 *
 * BD-022 says every string an integration produced is untrusted, and a UI is where that becomes an
 * XSS surface. So the corpus carries the payloads on purpose — a `<script>` tag, an `<img onerror>`,
 * a `javascript:` URL, a markdown link pointing at one, and a Trojan-source bidi override — in the
 * fields an attacker actually controls: an agent's question text, a tool result, a model's text
 * and a project name. `xss.spec.ts` then asserts against the **rendered DOM** in a real browser
 * that none of them became markup. Asserting against an escaped *string* is what WP-10 did, and
 * WP-10's escape was undone by its own link converter one function later.
 *
 * Every value here is obviously fake (BD-002): `example.invalid` hosts, zero-filled uuids, a
 * password nobody could mistake for a credential.
 */

import type { TranscriptEvent } from '@platform/contracts';
import {
  agentsResponseSchema,
  budgetsResponseSchema,
  contextPackRecordSchema,
  effectiveConfigResponseSchema,
  inboxResponseSchema,
  integrationSummarySchema,
  kbProposalsResponseSchema,
  kbTreeResponseSchema,
  orgAuditResponseSchema,
  orgUsersResponseSchema,
  projectSummarySchema,
  runMessagesResponseSchema,
  runPromptResponseSchema,
  runRecordSchema,
  setupGuideResponseSchema,
  taskDetailResponseSchema,
  taskRecordSchema,
  transcriptEventSchema,
  versionResponseSchema,
} from '@platform/contracts';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const IDS = {
  user: id(1),
  session: id(2),
  project: id(10),
  taskFeature: id(20),
  taskBug: id(21),
  question: id(30),
  approval: id(31),
  run: id(40),
  integration: id(50),
  proposal: id(60),
  budget: id(70),
  audit: id(80),
} as const;

export const PROJECT_KEY = 'demo_service';

/** The credentials the sign-in test uses. Obviously fake, and only this fake server knows them. */
export const CREDENTIALS = {
  email: 'operator@example.invalid',
  password: 'not-a-real-password',
} as const;

// ── The hostile corpus ───────────────────────────────────────────────────────

export const HOSTILE = {
  /** Two classic injections plus an entity that must survive as literal text. */
  script: '<script>window.__pwned = true;</script>',
  image: '<img src=x onerror="window.__pwned = true">',
  /** A bare URL with a scheme the linkifier must never turn into an href. */
  javascriptUrl: 'javascript:window.__pwned=true',
  /** Markdown link syntax around one: not interpreted at all. */
  markdownLink: '[click me](javascript:window.__pwned=true)',
  /** Trojan Source (CVE-2021-42574): U+202E reverses the display of what follows. */
  bidi: 'if (admin) {\u202E // } yretsam si nrettap eht',
  /** A legitimate link, so the "no anchors at all" reading of the assertions is excluded. */
  safeUrl: 'https://tickets.example.invalid/browse/DEMO-1',

  // ── Hostile schemes **in DTO fields**, not in prose ──────────────────────────
  //
  // `urlSchema` is `z.url()`, and `z.url()` accepts every one of these: the contract fixes the
  // syntax of a URL, not the schemes a browser may be handed. Until round 2 of this work package
  // the board and the task screen put these fields straight into `href`, and the only thing
  // stopping them was React 19.3 — which rewrites `javascript:` and passes `data:`, `vbscript:`
  // and `file:` through **verbatim**. So the corpus carries one of each, in the three DTO fields a
  // screen turns into a link (`ticket.url`, `mr_ref.url`, `artifacts[].url`), and `xss.spec.ts`
  // asserts against the rendered DOM that none of them became an `href`.
  /** A ticket whose provider gave it a `javascript:` URL — the one React would have caught. */
  ticketUrlJavascript: 'javascript:window.__pwned=true',
  /** An MR URL React does **not** touch. Top-level `data:` navigation is what this would be. */
  mrUrlData: 'data:text/html,<script>window.__pwned=true</script>',
  /** An artifact URL React does not touch either. */
  artifactUrlVbscript: 'vbscript:msgbox(1)',
  /**
   * And a `file:` URL, which reads the operator's own disk rather than the attacker's.
   *
   * It is carried by a **second artifact** on the task screen rather than sitting here unused.
   * Until this change it was declared and never referenced, so the `file:` arm of
   * `assertNoHostileHref` passed against a corpus that contained no `file:` URL — a vacuous pass
   * wearing a green tick (standing rule 4), on the one scheme the React measurement says the
   * framework does **not** rewrite.
   */
  fileUrl: 'file:///etc/passwd',
} as const;

const now = '2026-09-10T09:00:00.000Z';

// ── Records ──────────────────────────────────────────────────────────────────

export const version = versionResponseSchema.parse({
  version: '0.0.0-fake',
  commit: 'deadbee',
  built_at: now,
});

export const orgUsers = orgUsersResponseSchema.parse({
  items: [
    {
      id: IDS.user,
      email: CREDENTIALS.email,
      name: 'Fake Operator',
      role: 'admin',
      status: 'active',
    },
  ],
});

export const project = projectSummarySchema.parse({
  id: IDS.project,
  key: PROJECT_KEY,
  // A project name is operator-supplied, so it is on the untrusted side of the boundary too.
  name: `Demo service ${HOSTILE.image}`,
  repo_url: 'https://git.example.invalid/demo/service',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 3,
  status: 'active',
  created_at: now,
  updated_at: now,
  open_tasks: 2,
  spent_usd_30d: 12.5,
});

const emptyUsage = {
  input_tokens: 1200,
  output_tokens: 340,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 8800,
};

const baseTask = {
  project_id: IDS.project,
  template: 'feature',
  mode: 'normal',
  size: 'M',
  branch: 'agentic/demo-1',
  mr_ref: null,
  workpad_ref: null,
  iteration_counters: { review: 1 },
  risk_classes: ['payments'],
  cost_actual_usd: 4.25,
  cost_estimated_usd: 6,
  requested_by_user_id: IDS.user,
  requested_by_identity: null,
  created_at: now,
  updated_at: now,
  completed_at: null,
} as const;

export const featureTask = taskRecordSchema.parse({
  ...baseTask,
  id: IDS.taskFeature,
  ticket: { provider: 'jira', key: 'DEMO-1', url: HOSTILE.safeUrl },
  // A merge request whose URL is a `data:` document. `taskRecordSchema` accepts it — which is the
  // point — and React would render it unchanged, so whatever refuses it is the application's own.
  mr_ref: { provider: 'gitlab', project_path: 'demo/service', iid: 7, url: HOSTILE.mrUrlData },
  state: 'active',
  current_stage: 'implementation',
});

export const bugTask = taskRecordSchema.parse({
  ...baseTask,
  id: IDS.taskBug,
  // A ticket URL with a `javascript:` scheme: the one scheme React 19.3 happens to rewrite, so the
  // assertion about it is about this application only when read together with the `data:` one.
  ticket: { provider: 'jira', key: 'DEMO-2', url: HOSTILE.ticketUrlJavascript },
  template: 'bug',
  state: 'waiting_answers',
  current_stage: 'investigation',
  iteration_counters: {},
  risk_classes: [],
});

export const question = {
  id: IDS.question,
  task_id: IDS.taskFeature,
  stage: 'implementation',
  run_id: IDS.run,
  // Written by an agent from a ticket it read: the least trustworthy string a human is shown.
  text: `Should the retry budget be 3 or 5? ${HOSTILE.script} ${HOSTILE.markdownLink}`,
  options: ['three', 'five'],
  blocking: true,
  status: 'open',
  asked_at: now,
  deadline_at: null,
  reminders_sent: 0,
  answer: null,
  answered_by_user_id: null,
  answered_via: null,
  answered_at: null,
} as const;

export const approval = {
  id: IDS.approval,
  task_id: IDS.taskFeature,
  kind: 'plan',
  status: 'pending',
  requested_at: now,
  deadline_at: null,
  decided_by_user_id: null,
  decided_at: null,
  reason: null,
} as const;

export const run = runRecordSchema.parse({
  id: IDS.run,
  task_id: IDS.taskFeature,
  project_id: IDS.project,
  stage: 'implementation',
  role: 'developer',
  mode: 'normal',
  attempt: 1,
  session_id: 'fake-session',
  model: 'claude-opus-5',
  effort: 'high',
  provider_mode: 'api',
  prompt_version: 'developer@1.0.0',
  status: 'running',
  terminal_reason: null,
  started_at: now,
  ended_at: null,
  last_output_at: now,
  num_turns: 4,
  usage: emptyUsage,
  model_usage: [{ ...emptyUsage, model: 'claude-opus-5', usd: 4.25 }],
  cost: { usd: 4.25, is_estimate: false, price_list_id: null },
  wall_ms: 61_000,
  redaction_count: 0,
});

export const taskDetail = taskDetailResponseSchema.parse({
  task: featureTask,
  stages: [
    {
      stage: 'refinement',
      attempt: 1,
      state: 'completed',
      entered_at: now,
      exited_at: now,
      outcome: 'spec accepted',
    },
    {
      stage: 'implementation',
      attempt: 1,
      state: 'running',
      entered_at: now,
      exited_at: null,
      outcome: null,
    },
  ],
  artifacts: [
    // One safe URL and two hostile ones, so "no anchor" cannot pass by the screen linking nothing.
    { id: id(90), artifact_type: 'RefinedSpec', version: 1, url: HOSTILE.safeUrl },
    {
      id: id(91),
      artifact_type: 'ImplementationPlan',
      version: 2,
      url: HOSTILE.artifactUrlVbscript,
    },
    // `file:` is the scheme React passes through *and* the one that reads the operator's own
    // disk. An artifact is where a provider would plausibly hand one over: a path on the runner.
    { id: id(92), artifact_type: 'ReviewVerdict', version: 1, url: HOSTILE.fileUrl },
  ],
  questions: [question],
  approvals: [approval],
  runs: [run],
});

export const bugTaskDetail = taskDetailResponseSchema.parse({
  task: bugTask,
  stages: [],
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [],
});

// ── Transcript ───────────────────────────────────────────────────────────────

const transcriptEnvelope = {
  run_id: IDS.run,
  created_at: now,
  parent_tool_use_id: null,
  redaction_count: 0,
} as const;

/** The page `GET /api/runs/:id/messages` returns, hostile strings included. */
export const transcriptPage: TranscriptEvent[] = [
  {
    ...transcriptEnvelope,
    kind: 'system',
    seq: 1,
    subtype: 'init',
    session_id: 'fake-session',
    model: 'claude-opus-5',
    data: { cwd: '/workspace' },
  },
  {
    ...transcriptEnvelope,
    kind: 'assistant',
    seq: 2,
    model: 'claude-opus-5',
    content: [
      {
        type: 'text',
        // Model output: markdown that must render as text, a fenced block that must render as a
        // code block, and a URL that may become a link.
        text: `Reading the retry helper. ${HOSTILE.image}\n\n\`\`\`ts\nconst limit = 3; ${HOSTILE.script}\n\`\`\`\n\nSee ${HOSTILE.safeUrl} and ${HOSTILE.javascriptUrl}`,
      },
      {
        type: 'tool_use',
        tool_use_id: 'toolu_read_1',
        tool_name: 'Read',
        input: { file_path: 'src/retry.ts' },
      },
    ],
  },
  {
    ...transcriptEnvelope,
    kind: 'user',
    seq: 3,
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_read_1',
        is_error: false,
        // Tool output: whatever was in a file in the agent's workspace.
        content: `export const retries = 3; ${HOSTILE.bidi}`,
      },
    ],
  },
  {
    ...transcriptEnvelope,
    kind: 'assistant',
    seq: 4,
    model: 'claude-opus-5',
    content: [
      {
        type: 'tool_use',
        tool_use_id: 'toolu_bash_1',
        tool_name: 'Bash',
        input: { command: 'pnpm test' },
      },
    ],
  },
  {
    ...transcriptEnvelope,
    kind: 'user',
    seq: 5,
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_bash_1',
        is_error: false,
        // ANSI colours, which the terminal renderer strips rather than interprets.
        content: '\u001B[32m\u2713\u001B[0m 12 passed\n',
      },
    ],
  },
];

transcriptPage.forEach((event) => {
  transcriptEventSchema.parse(event);
});

/** Delivered over SSE by the test, never in the REST page: proof the stream is what rendered it. */
export const liveTranscriptEvent: TranscriptEvent = transcriptEventSchema.parse({
  ...transcriptEnvelope,
  kind: 'assistant',
  seq: 6,
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'Streamed after the page was fetched.' }],
});

export const runMessages = runMessagesResponseSchema.parse({
  items: transcriptPage,
  next_seq: null,
});

export const runPrompt = runPromptResponseSchema.parse({
  prompt_version: 'developer@1.0.0',
  system_prompt: 'You are the developer agent.',
  user_prompt: `Implement DEMO-1. ${HOSTILE.script}`,
});

export const runContextPack = contextPackRecordSchema.parse({
  tier0: [{ path: 'technical/architecture.md', tokens: 900 }],
  tier1: [
    {
      path: 'lessons/retries.md',
      reason: 'trigger',
      score: 0.8,
      tokens: 300,
      validated: true,
    },
  ],
  budget_tokens: 8000,
  total_tokens: 1200,
  kb_commit: null,
});

// ── Org-level lists ──────────────────────────────────────────────────────────

export const agents = agentsResponseSchema.parse({
  items: [
    {
      run,
      project_id: IDS.project,
      task_id: IDS.taskFeature,
      role: 'developer',
      last_output_at: now,
    },
  ],
});

export const inbox = inboxResponseSchema.parse({
  questions: [question],
  approvals: [approval],
});

export const audit = orgAuditResponseSchema.parse({
  items: [
    {
      id: IDS.audit,
      entity_type: 'project',
      entity_id: IDS.project,
      user_id: IDS.user,
      diff: { autonomy_level: ['assist', 'supervised'] },
      created_at: now,
    },
  ],
  next_cursor: null,
});

// `GET /api/integrations` has no published envelope (see `apps/web/src/api/endpoints.ts` and Q45),
// so the *item* is parsed by the schema contracts does publish and the page is composed here.
export const integrations = {
  items: [
    integrationSummarySchema.parse({
      id: IDS.integration,
      type: 'task_management',
      provider: 'jira-cloud',
      name: 'Jira (fake)',
      config: { site: 'https://fake.atlassian.invalid' },
      health: { status: 'ok', checked_at: now, detail: null },
    }),
  ],
};

export const setupGuide = setupGuideResponseSchema.parse({
  provider: 'jira-cloud',
  title: 'Connect Jira Cloud',
  markdown: `1. Create an API token.\n\n\`\`\`bash\nexport JIRA_API_TOKEN=fake-token\n\`\`\`\n\n${HOSTILE.script}`,
  webhook_url: 'https://platform.example.invalid/webhooks/jira-cloud/1',
});

export const budgets = budgetsResponseSchema.parse({
  items: [
    {
      id: IDS.budget,
      scope: 'project',
      scope_id: IDS.project,
      window: 'month',
      limit_usd: 100,
      notify_pct: [50, 80],
      spent_usd: 12.5,
      window_start: now,
    },
  ],
});

export const effectiveConfig = effectiveConfigResponseSchema.parse({
  config: { version: 1 },
  sources: { version: 'default' },
  hash: 'fakehash1',
  computed_at: now,
});

export const kbTree = kbTreeResponseSchema.parse({
  commit_sha: 'deadbee',
  entries: [
    { path: 'technical/architecture.md', kind: 'file', tokens: 900, updated_at: now },
    { path: 'lessons/retries.md', kind: 'file', tokens: 300, updated_at: now },
  ],
});

export const kbDoc = {
  path: 'technical/architecture.md',
  commit_sha: 'deadbee',
  frontmatter: { title: 'Architecture' },
  content: `# Architecture\n\n${HOSTILE.script}\n\n\`\`\`mermaid\ngraph TD;\n\`\`\``,
} as const;

export const kbProposals = kbProposalsResponseSchema.parse({
  items: [
    {
      id: IDS.proposal,
      project_id: IDS.project,
      task_id: IDS.taskFeature,
      run_id: IDS.run,
      source: 'run',
      kind: 'technical',
      type: 'lesson',
      target_path: 'lessons/retries.md',
      delta: `+ Retries are capped at 3. ${HOSTILE.script}`,
      evidence: [`run ${IDS.run}`],
      significance: 0.72,
      status: 'queued',
      decided_by_user_id: null,
      decided_at: null,
      applied_commit_sha: null,
      created_at: now,
    },
  ],
  next_cursor: null,
});

export const tasksPage = { items: [featureTask, bugTask], next_cursor: null };

export const projectsPage = { items: [project] };
