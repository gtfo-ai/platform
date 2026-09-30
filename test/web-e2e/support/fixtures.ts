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
  autonomyResponseSchema,
  budgetsResponseSchema,
  contextPackRecordSchema,
  deadLettersResponseSchema,
  effectiveConfigResponseSchema,
  identityMappingListSchema,
  inboxResponseSchema,
  integrationSummarySchema,
  kbHealthResponseSchema,
  kbProposalsResponseSchema,
  kbTreeResponseSchema,
  orgAuditResponseSchema,
  orgSettingsResponseSchema,
  orgStatsResponseSchema,
  orgUsersResponseSchema,
  projectAuditResponseSchema,
  projectSummarySchema,
  rediscoveryGateResponseSchema,
  runCommandsResponseSchema,
  runMessagesResponseSchema,
  runPromptResponseSchema,
  runRecordSchema,
  setupGuideResponseSchema,
  taskBreakdownSchema,
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
  orgBudget: id(71),
  audit: id(80),
  // WP-44: a task a human holds, and an epic split with a breakdown queue.
  taskTaken: id(22),
  taskEpic: id(23),
  childA: id(90),
  childB: id(91),
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
  // WP-95 (Q48): the card's title, from the ticket snapshot. `null` on the base — the platform has
  // not read the ticket — and a hostile one on DEMO-1, so the board renders provider text as text.
  ticket_title: null,
  risk_classes: ['payments'],
  // WP-39: a measured delta, with a **branch name a repository chose** as its base — so the line
  // the panel prints under the metric is provider text going through `UntrustedText`, like every
  // other string on that screen (BD-022).
  coverage: {
    head_sha: 'b'.repeat(40),
    head_pct: 81.5,
    base_branch: 'main',
    base_sha: 'a'.repeat(40),
    base_pct: 79,
    delta_pct: 2.5,
    measured_at: now,
  },
  /**
   * WP-38: a gate that ran, found a package and is waiting for an answer — with a **package name
   * and a licence a registry published**, which is third-party text on the one screen a maintainer
   * merges from (BD-022). The hostile string is in the name rather than in a comment, so the
   * Playwright assertion about it is about this application rather than about a fixture nobody
   * renders (standing rule 4, the `file:` lesson above).
   */
  dependencies: {
    head_sha: 'b'.repeat(40),
    decision: 'ask',
    added: [
      {
        ecosystem: 'npm',
        name: 'left-pad',
        from: 'manifest',
        path: 'package.json',
        policy: 'ask',
        allowlisted: false,
        metadata: {
          status: 'checked',
          license: `MIT ${HOSTILE.image}`,
          last_published_at: now,
          deprecated: true,
          source_url: HOSTILE.mrUrlData,
        },
      },
    ],
    unread: [{ ecosystem: 'maven', path: 'services/pom.xml' }],
    truncated: false,
    question_id: IDS.question,
    checked_at: now,
  },
  /** …and a `CODEOWNERS` handle nobody could resolve, which is the case the audit cannot record. */
  required_reviewers: {
    source: 'codeowners',
    handles: [`@ana ${HOSTILE.script}`, '@billing-team'],
    assigned: ['4242'],
    unresolved: ['@billing-team'],
    truncated: false,
    routed_at: now,
  },
  /** WP-46: the review window's reading of the merge request's human threads. */
  review_threads: { open: 2, resolved: 1, checked_at: now },
  /**
   * WP-41, PROGRESS backlog 63: the board's conflict badge, with a peer ticket key that carries a
   * script tag — the key is provider text (BD-022) and the badge renders it *and* puts it in a
   * `title`, which is a second sink the browser tier is here to watch.
   */
  conflict: {
    other_task_id: IDS.taskBug,
    other_ticket_key: `DEMO-98 ${HOSTILE.script}`,
    path_count: 3,
    truncated: false,
    warned_at: now,
  },
  cost_actual_usd: 4.25,
  cost_estimated_usd: 6,
  // WP-28: the refinement estimate and its provenance. Deliberately **not** equal to
  // `cost_actual_usd`, so the accuracy the page renders is a ratio a constant could not produce.
  estimate_usd: 12,
  estimate_basis: 'project_history',
  estimate_samples: 7,
  estimate_accuracy: 4.25 / 12,
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
  ticket_title: `Checkout ${HOSTILE.script}`,
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
  // The other half of WP-39's panel item: a task nothing has measured. The two tasks together are
  // what keep *"not measured"* and a real delta from collapsing into one rendering.
  coverage: null,
  // …and the same both-ways rule for WP-38's two: a task whose gate has not run and whose merge
  // request has not been routed, so *"not checked"* and *"not routed"* are rendered somewhere.
  dependencies: null,
  required_reviewers: null,
  review_threads: null,
  // …and the same both-ways rule for WP-41's field: this task was never compared, so its card
  // carries no badge. Since WP-59 a warned *pair* carries one on both cards (PROGRESS backlog 65),
  // so a card with none is a task no gate has compared against an overlapping one.
  conflict: null,
});

/**
 * `GET /api/org/stats` (WP-41), parsed by the published schema so this fixture cannot drift from
 * the DTO the real server sends.
 *
 * Four metrics, chosen for the four renderings the screen has to keep apart: a **count** with a
 * value, a **ratio** with nothing to divide (`null`, and *not* 0.0 %), a figure carrying **caveats**,
 * and one that is **absent** with a reason and an owner. The absent one's reason carries a hostile
 * string, because it is prose this screen prints and the browser tier is where "prints" is proved
 * to mean "as text".
 */
export const orgStats = orgStatsResponseSchema.parse({
  range: {
    range: '30d',
    bucket: 'day',
    from: '2026-05-09',
    to: '2026-06-07',
    timezone: 'Europe/Prague',
    timezone_substituted: false,
  },
  project_id: null,
  metrics: [
    {
      id: 'tasks_delivered',
      label: 'Tasks delivered',
      definition: 'Tasks whose merge request merged, counted at merge time (product/19 §10).',
      unit: 'count',
      value: 3,
      samples: 3,
      buckets: [{ start: '2026-06-03', end: '2026-06-04', value: 3, samples: 3 }],
      absent: null,
      caveats: [],
    },
    {
      id: 'merge_rate',
      label: 'Merge rate',
      definition: 'Tasks delivered in the period divided by tasks started in the period.',
      unit: 'ratio',
      value: null,
      samples: 0,
      buckets: [{ start: '2026-06-03', end: '2026-06-04', value: null, samples: 0 }],
      absent: null,
      caveats: [],
    },
    {
      id: 'reviewer_minutes_per_delivered_task',
      label: 'Reviewer minutes per delivered task',
      definition: 'Human review minutes in the period divided by the tasks delivered in it.',
      unit: 'minutes',
      value: 45,
      samples: 3,
      buckets: [{ start: '2026-06-03', end: '2026-06-04', value: 45, samples: 3 }],
      absent: null,
      caveats: [
        'Over-counts: a bot that is not this platform opens a review window like a person.',
      ],
    },
    {
      // An absent metric of this build's (WP-61 made `loc_changed`, the one this used to be,
      // computable — backlog 179).
      id: 'queue_wait_minutes',
      label: 'Queue wait',
      definition: 'How long a task waited between being queued and being picked up.',
      unit: 'minutes',
      value: null,
      samples: 0,
      buckets: [],
      absent: {
        reason: `\`task.dequeued\` is declared unconsumed and nothing projects it ${HOSTILE.image}`,
        owner: 'Nobody yet — a row that folds task.queued against task.dequeued owns it.',
      },
      caveats: [],
    },
  ],
  returns_by_stage: [
    { stage: 'code_review', entries: 4, returns: 1, rate: 0.25 },
    { stage: 'ci_gate', entries: 0, returns: 0, rate: null },
  ],
  generated_at: now,
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
  // WP-27: a task nobody has taken over. `null` rather than absent — the field is required and
  // nullable, so a client can tell "not taken over" from "this build does not report it".
  taken_over: null,
  /**
   * WP-29's minutes, with the per-user breakdown **on** — which is not this project's default and
   * is exactly why the corpus carries it: `by_user` is the one place the task screen renders a
   * **provider account id**, and a provider account id is somebody else's text (BD-022). One of the
   * two rows is therefore hostile, so `xss.spec.ts` asserts against the rendered DOM that it stayed
   * a text node. The dollars and the minutes are two fields here as well: nothing in the corpus
   * adds them, because nothing in the platform can (Q73).
   */
  human_time: {
    total_minutes: 142.5,
    by_kind: { review: 127.5, question: 0, approval: 10, steer: 5 },
    by_user: [
      { user_id: id(93), user_name: 'Ada Lovelace', external_author: null, minutes: 137.5 },
      {
        user_id: null,
        user_name: null,
        external_author: `gitlab:${HOSTILE.script}`,
        minutes: 5,
      },
    ],
    entries: 4,
    // WP-44: one approval-touched review window withheld, as the statistics withhold it — the task
    // page says so beneath the figure rather than printing a silently lower number.
    withheld: { entries: 1, minutes: 30 },
  },
  stages: [
    {
      stage: 'refinement',
      attempt: 1,
      state: 'completed',
      entered_at: now,
      exited_at: now,
      // One word of `taskStageOutcomeSchema` (WP-73, backlog 213); the screen says it as a sentence.
      outcome: 'approve',
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
  taken_over: null,
  // Nothing recorded, and the breakdown off — the shipped default (product/18:32). `by_user: null`
  // and an empty list are different answers, and this is the first.
  human_time: {
    total_minutes: 0,
    by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
    by_user: null,
    entries: 0,
    withheld: { entries: 0, minutes: 0 },
  },
  stages: [],
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [],
});

/**
 * A task a human took over, and whose take-over the inactivity timer then escalated (WP-44,
 * PROGRESS backlog 164): `needs_human`, and still held — the page shows the branch, the downloads
 * and the hand-back picker. The stages offered are the compiled pipeline's, as the server sends
 * them; the picker offers exactly these.
 */
export const takenOverTaskDetail = taskDetailResponseSchema.parse({
  ...bugTaskDetail,
  task: {
    ...featureTask,
    id: IDS.taskTaken,
    ticket: { provider: 'jira', key: 'DEMO-3', url: HOSTILE.safeUrl },
    mr_ref: null,
    state: 'needs_human',
    current_stage: 'implementation',
  },
  taken_over: {
    at: now,
    branch: 'agentic/demo-3',
    session_id: 'sess-demo-3',
    stage: 'implementation',
    resume_commands: ['git fetch && git checkout agentic/demo-3', 'claude --resume sess-demo-3'],
    held_by: IDS.user,
    run_id: null,
    run_recorded: false,
    hand_back_stages: ['refinement', 'implementation', 'code_review'],
  },
  runs: [{ ...run, task_id: IDS.taskTaken }],
});

/** An epic-split task with a queue of two proposed children (WP-44, PROGRESS backlog 108). */
export const epicTaskDetail = taskDetailResponseSchema.parse({
  ...bugTaskDetail,
  task: {
    ...featureTask,
    id: IDS.taskEpic,
    ticket: { provider: 'jira', key: 'DEMO-4', url: HOSTILE.safeUrl },
    mr_ref: null,
    template: 'epic_split',
    state: 'active',
    current_stage: 'human_review',
  },
});

const childOf = (itemId: string, position: number, title: string) => ({
  id: itemId,
  task_id: IDS.taskEpic,
  position,
  title,
  description: `What ${title} does. ${HOSTILE.script}`,
  acceptance_criteria: [
    {
      id: `AC-${position}`,
      given: 'a signed-in user',
      when: 'they open the page',
      // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the criterion's own shape (technical/12); a plain object, never awaited.
      then: 'it loads',
      validation: { kind: 'manual', value: 'look at it' },
    },
  ],
  size: 'S',
  rationale: 'Separable.',
  status: 'queued',
  decided_by_user_id: null,
  decided_at: null,
  reason: null,
  ticket_key: null,
  ticket_url: null,
  created_at: now,
});

export const epicBreakdown = taskBreakdownSchema.parse({
  items: [childOf(IDS.childA, 0, 'Child A'), childOf(IDS.childB, 1, 'Child B')],
  can_decide: true,
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

/**
 * WP-85 (TD-028 decision 9): what became of the commands sent to the run — one steer the holder
 * applied, one it could not because the run ended first. The steer text is somebody's own words.
 */
export const runCommandLog = runCommandsResponseSchema.parse({
  items: [
    {
      id: id(45),
      run_id: IDS.run,
      kind: 'steer',
      state: 'refused',
      message: 'and check the rounding',
      author_user_id: IDS.user,
      created_at: '2026-06-01T09:06:00.000Z',
      applied_at: null,
      refused_at: '2026-06-01T09:06:30.000Z',
      refused_reason: 'run_ended',
    },
    {
      id: id(44),
      run_id: IDS.run,
      kind: 'steer',
      state: 'applied',
      message: `use the invoice total ${HOSTILE.script}`,
      author_user_id: IDS.user,
      created_at: '2026-06-01T09:05:00.000Z',
      applied_at: '2026-06-01T09:05:01.000Z',
      refused_at: null,
      refused_reason: null,
    },
  ],
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
    // WP-44 (PROGRESS backlog 168): a page whose `paths:` glob resolved to nothing at the indexed
    // commit — recorded, never shown to the agent, and not counted under "Documents".
    {
      path: 'lessons/legacy-importer.md',
      reason: 'paths',
      score: 1,
      tokens: 250,
      validated: false,
    },
  ],
  budget_tokens: 8000,
  total_tokens: 1200,
  kb_commit: null,
  // WP-44 (PROGRESS backlog 172): what the text step did, in the record.
  text_search: {
    outcome: 'matched',
    kept_terms: ['retries'],
    dropped_terms: ['demo'],
    floor: 'applied',
    matched_documents: 1,
    omitted_terms: 0,
  },
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

/**
 * `GET /api/org/identities` — one Slack account mapped to the operator (WP-43). The display name
 * carries markup on purpose: the screen must render it as text (BD-022).
 */
export const orgIdentities = identityMappingListSchema.parse({
  items: [
    {
      provider: 'slack',
      external_id: 'U0FAKEOPERATOR',
      kind: 'person',
      user_id: IDS.user,
      display_name: '<img src=x onerror=alert(1)>operator',
      created_at: now,
    },
  ],
});

/**
 * The organisation settings document — `GET /api/org`, served since WP-93. The block list carries
 * markup on purpose: it is text an administrator typed, and the screen holds it as a value.
 */
/**
 * `GET /api/projects/:id/rediscovery` (WP-94): the re-evaluate button's gate and its ceiling, with
 * a last discovery whose cost the button's line names.
 */
export const rediscoveryGate = rediscoveryGateResponseSchema.parse({
  can_start: true,
  blocker: null,
  ceiling_usd: 2,
  last_discovery: { task_id: IDS.taskBug, state: 'done', cost_usd: 0.84 },
});

export const orgSettings = orgSettingsResponseSchema.parse({
  settings: {
    commands: { block: ['<img src=x onerror=alert(1)>'] },
    autonomy: { maximum: 'supervised' },
  },
  updated_at: now,
});

/** The organisation's own caps — `GET /api/org/budgets`, served since WP-30. */
export const orgBudgets = budgetsResponseSchema.parse({
  items: [
    {
      id: IDS.orgBudget,
      scope: 'org',
      scope_id: null,
      window: 'day',
      limit_usd: 40,
      notify_pct: [50, 80, 100],
      spent_usd: 3.25,
      window_start: now,
    },
  ],
});

/**
 * `GET /api/projects/:id/autonomy` — a project that has **overridden** a policy, so the settings
 * screen renders the *Custom* branch rather than the quiet one (WP-30, BD-027).
 */
export const autonomy = autonomyResponseSchema.parse({
  level: 'supervised',
  materialised: true,
  preset_version: 1,
  current_preset_version: 1,
  preset_outdated: false,
  applied_at: now,
  applied_by: IDS.user,
  policies: {
    picks_up_new_tickets: true,
    stop_after_stage: null,
    plan_approval: 'above_size',
    plan_approval_size_threshold: 'L',
    plan_approval_for_risk_classes: true,
    probation: true,
    probation_tasks: 2,
    business_review: true,
    question_timeout: '1 working day',
    human_mr_rounds: 3,
    knowledge_auto_apply: false,
    budget_approval_threshold_usd: 50,
    review_only: false,
    shadow_mode: false,
    suggested_readiness_min: 1,
  },
  is_custom: true,
  overrides: [{ policy: 'probationTasks', preset: 5, effective: 2 }],
  readiness_level: 1,
  suggested_cap: 'supervised',
  above_suggested_cap: false,
  organisation_maximum: null,
  level_in_force: 'supervised',
});

/**
 * `GET /api/projects/:id/audit` — product/18:5's *"every toggle records who changed it"*, read.
 *
 * `params` is client-supplied JSON, so it carries a hostile string like everything else the SPA
 * renders (BD-022): `xss.spec.ts` is what holds the app to rendering it as text.
 */
export const projectAudit = projectAuditResponseSchema.parse({
  items: [
    {
      id: IDS.audit,
      action: 'project.autonomy.write',
      user_id: IDS.user,
      user_email: 'operator@example.invalid',
      params: { project_id: IDS.project, before_level: 'observe', after_level: 'supervised' },
      created_at: now,
    },
  ],
});

export const effectiveConfig = effectiveConfigResponseSchema.parse({
  config: { version: 1 },
  // WP-63: the merged document and the repository reading that fed its `repo` layer.
  effective: { version: 1 },
  repository: {
    path: '.agentic/config.yml',
    status: 'unread',
    commit_sha: null,
    read_at: null,
    detail: null,
    not_applied: [],
  },
  sources: { version: 'default' },
  hash: 'fakehash1',
  computed_at: now,
  not_applied: [],
  last_export: null,
  // WP-54: the project declares no `commands.allow`, so nothing is ignored.
  ignored_allow_commands: [],
  // WP-37: the platform's own suggestion, because no discovery run has proposed one here. The
  // project's `policies.risk_classes` is absent above — proposed is not applied.
  risk_class_proposal: {
    source: 'platform',
    classes: {
      data: { paths: ['**/migrations/**'], require: ['plan_approval'] },
      payments: { paths: ['**/billing/**'], require: ['plan_approval', 'checklist:payments'] },
    },
    // WP-45: the list accepting asks the operator to write — the platform ships no items.
    checklists: [
      {
        name: 'payments',
        required_by: ['payments'],
        purpose: 'product/19 §14 asks for a "stricter checklist" on payments (Q83)',
        defined: false,
      },
    ],
  },
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

/**
 * `GET /api/org/dead-letters` and `GET /api/projects/:id/kb/health` (WP-96, PROGRESS backlog 326).
 * Until WP-96 the fake answered both with its documented 404, so the bundle drew only their error
 * notices and no test looked. Parsed by the published schemas, like every fixture here.
 */
export const deadLetters = deadLettersResponseSchema.parse({
  items: [
    {
      position: 4242,
      event_type: 'task.stage.completed',
      stream_type: 'task',
      stream_id: IDS.taskFeature,
      occurred_at: now,
      dead_lettered_at: now,
      handler: 'pipeline.saga',
      attempts: 5,
      // Handler text is untrusted: it is shown as characters.
      error: `boom ${HOSTILE.script}`,
      error_truncated: false,
      task: { id: IDS.taskFeature, ticket_key: 'ACME-1', project_key: PROJECT_KEY },
    },
  ],
  total: 1,
  next_cursor: null,
});

export const kbHealth = kbHealthResponseSchema.parse({
  id: id(61),
  project_id: IDS.project,
  commit_sha: 'fakehealth00000000000000000000000000000000',
  documents: 12,
  findings: [
    { kind: 'dangling', path: 'technical/architecture.md', detail: 'links to runbooks/missing.md' },
  ],
  source: 'hygiene',
  created_at: now,
});

export const tasksPage = { items: [featureTask, bugTask], next_cursor: null };

export const projectsPage = { items: [project] };
