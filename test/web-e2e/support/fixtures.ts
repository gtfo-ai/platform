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

import type { PipelineTemplate, TranscriptEvent } from '@platform/contracts';
import {
  agentsResponseSchema,
  autonomyResponseSchema,
  budgetsResponseSchema,
  contextPackRecordSchema,
  deadLettersResponseSchema,
  effectiveConfigResponseSchema,
  failedJobsResponseSchema,
  historyBootstrapsResponseSchema,
  identityCandidateListSchema,
  identityLinkCodeIssuedSchema,
  identityLinkConfirmedSchema,
  identityLinkMatchSchema,
  identityMappingListSchema,
  inboxResponseSchema,
  integrationProvidersResponseSchema,
  integrationSummarySchema,
  kbHealthResponseSchema,
  kbProposalsResponseSchema,
  kbTreeResponseSchema,
  orgAuditResponseSchema,
  orgModelsResponseSchema,
  orgSettingsResponseSchema,
  orgStatsResponseSchema,
  orgUsersResponseSchema,
  ownerCandidatesResponseSchema,
  pipelineGraphSchema,
  projectAuditResponseSchema,
  projectBindingsResponseSchema,
  projectExecutionResponseSchema,
  projectRepositoryResponseSchema,
  projectSpendResponseSchema,
  projectSummarySchema,
  readinessResponseSchema,
  rediscoveryGateResponseSchema,
  runCommandsResponseSchema,
  runMessagesResponseSchema,
  runPromptResponseSchema,
  runReadResponseSchema,
  runRecordSchema,
  setupGuideResponseSchema,
  shadowBatchesResponseSchema,
  taskBreakdownSchema,
  taskDetailResponseSchema,
  taskListItemSchema,
  taskRecordSchema,
  testIntegrationResponseSchema,
  ticketStatusesResponseSchema,
  transcriptEventSchema,
  versionResponseSchema,
  workersResponseSchema,
} from '@platform/contracts';
import { compilePipeline, resolveIterationLimits, SHIPPED_TEMPLATES } from '@platform/domain';
import { SHIPPED_PROVIDERS, toIntegrationProvider } from '@platform/integrations';
import { pipelineGraphOf } from '../../../apps/server/src/queries/pipeline-graph.js';

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
  // S-23.6: the fleet — a run a worker holds, a run waiting for a seat, and two machines.
  runWorker: id(41),
  runQueued: id(42),
  taskFleetWorker: id(24),
  taskFleetQueued: id(25),
  worker: id(100),
  workerPaused: id(101),
  // S-26.8a: a machine of another person, served only after `POST /__test__/workers-others`.
  workerOthers: id(102),
  otherUser: id(103),
  // S-25.11: a task CI sent back that the Developer is fixing, and one whose CI check timed out.
  taskCiFixing: id(26),
  taskCiTimedOut: id(27),
  // S-25.12: AUT-6655 — the CI check waiting on a held manual job, and the same wait timed out.
  taskCiHeld: id(28),
  taskCiHeldTimedOut: id(29),
  // S-26.8b: the person who owns DEMO-1 — not the signed-in operator, so *Take it* asks first.
  ownerVojtech: id(95),
  // S-26.8b's follow-up: a person *Assign…* offers, linked to the tracker.
  ownerPetra: id(96),
  // S-26.8b part 2: tasks whose run waits for a machine nobody has (`waiting`, S-26.5).
  taskWaitingOffline: id(32),
  taskWaitingMine: id(33),
  taskWaitingUnlinked: id(34),
  // S-25.14: AUT-6676 — stopped because its Jira ticket is assigned to somebody else.
  taskHeldElsewhere: id(35),
} as const;

/** S-26.8b: DEMO-1's owner, as the task DTO publishes them. */
export const OWNER_NAME = 'Vojtěch Dvořák';

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

/**
 * S-26.8b: DEMO-2's tracker assignee, whom the platform cannot link to a member (S-26.1's
 * `unlinked_assignee`). Provider text, so the corpus makes it hostile (BD-022).
 */
export const UNLINKED_ASSIGNEE = `Jan Novák ${HOSTILE.script}`;

/** S-26.8b's follow-up: a person *Assign…* offers, whose assignment is written back. */
export const CANDIDATE_NAME = `Petra ${HOSTILE.script}`;

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
  unmeasured_runs: 0,
  budget_cap_usd: 50,
  paused_reason: null,
  paused_budget_scope: null,
  paused_budget_figures: null,
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
  ticket_claim: null,
  qa_stage: false,
  tracker_assignee: null,
  owner: null,
  owner_source: null,
  unlinked_assignee: null,
  owner_writes_back: false,
  waiting: null,
} as const;

export const featureTask = taskRecordSchema.parse({
  ...baseTask,
  id: IDS.taskFeature,
  ticket: { provider: 'jira', key: 'DEMO-1', url: HOSTILE.safeUrl },
  ticket_title: `Checkout ${HOSTILE.script}`,
  // S-26.8b: owned by a person who is not the signed-in operator.
  owner: { user_id: IDS.ownerVojtech, name: OWNER_NAME },
  owner_source: 'tracker',
  unlinked_assignee: null,
  owner_writes_back: false,
  // S-26.8b's follow-up: Jira shows the owner, linked — the person a written-back assignment replaces.
  tracker_assignee: { display_name: OWNER_NAME, user_id: IDS.ownerVojtech },
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
  // S-26.8b: nobody owns it, and the tracker names a person the platform cannot link.
  owner: null,
  owner_source: null,
  unlinked_assignee: { display_name: UNLINKED_ASSIGNEE },
  owner_writes_back: false,
  tracker_assignee: { display_name: UNLINKED_ASSIGNEE, user_id: null },
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
 * Five metrics, chosen for the renderings the screen has to keep apart: a **count** with a value
 * and a trend, an **average count** (`decimal`, *8.0* and not *800.0 %*), a **ratio** with nothing
 * to divide (`null`, and *not* 0.0 %), a figure carrying **caveats**, and one that is **absent**
 * with a reason and an owner. The absent one's reason carries a hostile
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
      definition:
        'Tasks whose merge request merged in the period, counted at the moment of the merge.',
      unit: 'count',
      value: 3,
      samples: 3,
      buckets: [
        { start: '2026-06-02', end: '2026-06-03', value: 1, samples: 1 },
        { start: '2026-06-03', end: '2026-06-04', value: 2, samples: 2 },
      ],
      absent: null,
      caveats: [],
    },
    {
      // S-23.19: an average count, "8.0" — the live page printed it as "800.0%".
      id: 'returns_per_delivered_task',
      label: 'Returns per delivered task',
      definition: 'Average number of stage returns per delivered task.',
      unit: 'decimal',
      value: 8,
      samples: 1,
      buckets: [{ start: '2026-06-03', end: '2026-06-04', value: 8, samples: 1 }],
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
  settings_hash: '5f1c0e5a3d9b7c2e4f6a8b0c1d3e5f7a9b2c4d6e8f0a1b3c5d7e9f1a2b4c6d8e',
  start_failure: null,
  saved_work: null,
  stop_reason: null,
  latest_progress: null,
});

/** `GET /api/runs/:id` (WP-167): the record plus what an unchanged *Retry run* runs. */
export const runRead = runReadResponseSchema.parse({
  ...run,
  retry_defaults: { model: 'claude-opus-5', effort: 'high' },
});

export const taskDetail = taskDetailResponseSchema.parse({
  task: featureTask,
  // WP-27: a task nobody has taken over. `null` rather than absent — the field is required and
  // nullable, so a client can tell "not taken over" from "this build does not report it".
  taken_over: null,
  can_raise_budget: false,
  can_export: false,
  can_pause: true,
  can_resume: true,
  can_cancel: true,
  can_return: true,
  can_rework: true,
  can_decide_approval: true,
  can_change_limits: false,
  can_retry_run: true,
  can_take_over: true,
  take_writes_back: false,
  // S-26.8b: the operator is an administrator — every owner action the matrix allows.
  can_take: true,
  can_assign: true,
  can_unassign: true,
  gate_feedback: null,
  returns: [],
  stop: null,
  gate_wait: null,
  last_gate_wait: null,
  escalation: null,
  loop_limits: null,
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
  can_raise_budget: false,
  can_export: false,
  can_pause: true,
  can_resume: true,
  can_cancel: true,
  can_return: true,
  can_rework: true,
  can_decide_approval: true,
  can_change_limits: false,
  can_retry_run: true,
  can_take_over: true,
  take_writes_back: false,
  // S-26.8b: nobody owns it, so nothing to unassign; an administrator may take it.
  can_take: true,
  can_assign: true,
  can_unassign: false,
  gate_feedback: null,
  returns: [],
  stop: null,
  gate_wait: null,
  last_gate_wait: null,
  escalation: null,
  loop_limits: null,
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
    // S-26.8b: nobody owns it and the tracker names nobody — *Unassigned*.
    owner: null,
    owner_source: null,
    unlinked_assignee: null,
    tracker_assignee: null,
    mr_ref: null,
    state: 'needs_human',
    current_stage: 'implementation',
  },
  can_raise_budget: false,
  can_export: false,
  can_pause: true,
  can_resume: true,
  can_cancel: true,
  can_return: true,
  can_rework: true,
  can_decide_approval: true,
  can_change_limits: false,
  can_retry_run: true,
  can_take_over: true,
  can_take: false,
  can_assign: false,
  can_unassign: false,
  take_writes_back: false,
  gate_feedback: null,
  returns: [],
  stop: null,
  gate_wait: null,
  last_gate_wait: null,
  escalation: null,
  loop_limits: null,
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

/**
 * S-25.11: a task CI sent back — attempt 2 of the CI check failed with the job `unit`, and the
 * Developer is on implementation attempt 3, round 2 of 3. The page says why it went back, who acts
 * and the round, with no action; the timeline's returned attempt says where it went and why.
 */
export const ciFixingTaskDetail = taskDetailResponseSchema.parse({
  ...bugTaskDetail,
  task: {
    ...featureTask,
    id: IDS.taskCiFixing,
    ticket: { provider: 'jira', key: 'DEMO-6', url: HOSTILE.safeUrl },
    ticket_title: 'Round VAT once',
    mr_ref: {
      provider: 'gitlab',
      project_path: 'demo/service',
      iid: 9,
      url: HOSTILE.safeUrl,
    },
    state: 'active',
    current_stage: 'implementation',
    iteration_counters: { ci_fix: 2 },
  },
  loop_limits: resolveIterationLimits(),
  gate_wait: null,
  returns: [
    {
      from_stage: 'ci_gate',
      attempt: 2,
      to_stage: 'implementation',
      to_role: 'developer',
      at: '2026-06-01T10:40:00.000Z',
      outcome: 'returned',
      reason_recorded: true,
      ci_failure: { status: 'failed', jobs: 'unit' },
      loop: 'ci_fix',
    },
  ],
  stages: [
    {
      stage: 'implementation',
      attempt: 2,
      state: 'completed',
      entered_at: '2026-06-01T10:00:00.000Z',
      exited_at: '2026-06-01T10:20:00.000Z',
      outcome: null,
    },
    {
      stage: 'ci_gate',
      attempt: 2,
      state: 'returned',
      entered_at: '2026-06-01T10:20:00.000Z',
      exited_at: '2026-06-01T10:40:00.000Z',
      outcome: 'returned',
    },
    {
      stage: 'implementation',
      attempt: 3,
      state: 'running',
      entered_at: '2026-06-01T10:40:00.200Z',
      exited_at: null,
      outcome: null,
    },
  ],
});

/**
 * S-25.11, AUT-6655's shape: GitLab held the pipeline at a manual job, the CI check waited its 60
 * minutes and stopped. The row is `failed`/`undecided` with the sentence the platform wrote; the
 * page says the check did not finish — never that it failed — and quotes what it saw last.
 */
export const ciTimedOutTaskDetail = taskDetailResponseSchema.parse({
  ...ciFixingTaskDetail,
  task: {
    ...ciFixingTaskDetail.task,
    id: IDS.taskCiTimedOut,
    ticket: { provider: 'jira', key: 'DEMO-7', url: HOSTILE.safeUrl },
    ticket_title: 'Release notes',
    state: 'needs_human',
    current_stage: 'ci_gate',
    iteration_counters: {},
  },
  returns: [],
  stop: {
    stage: 'ci_gate',
    attempt: 1,
    cause: 'no_answer',
    loop: null,
    ci_failure: null,
    recorded:
      'the CI gate on a poll-only gitlab binding timed out: the merge request was still manual (pipeline 41) after 60 minutes (pipeline.limits.ci_timeout_minutes = 60); the last read: pipeline 41 is held at manual job "sentry-release-commit": nothing runs until somebody starts it on the provider',
    recorded_cut: false,
    // Before the worker session's #89 the row recorded no ending and no read: the page quotes the
    // sentence after "What the platform saw last:" (S-25.12's fallback).
    ci_ending: null,
  },
  stages: [
    {
      stage: 'ci_gate',
      attempt: 1,
      state: 'failed',
      entered_at: '2026-06-01T10:00:00.000Z',
      exited_at: '2026-06-01T11:00:00.000Z',
      outcome: 'undecided',
    },
  ],
});

/**
 * S-25.12, AUT-6655 as the worker session's #89 records it: GitLab holds the draft merge request's
 * pipeline at the manual job `sentry-release-commit`, and the CI check is waiting — its open read
 * is `gate_wait`, 60 minutes allowed, twelve minutes in by the browser's clock. The page says what
 * it waits for, and it is *Needs you* at once.
 */
const AUT_6655_MR = {
  provider: 'gitlab',
  project_path: 'demo/service',
  iid: 11,
  url: 'https://git.example.invalid/demo/service/-/merge_requests/11',
} as const;
export const AUT_6655_JOB_URL = 'https://git.example.invalid/demo/service/-/jobs/9003';
const aut6655Read = (waitingSince: string, checkedAt: string) => ({
  pipeline_id: '3038234623',
  pipeline_url: 'https://git.example.invalid/demo/service/-/pipelines/3038234623',
  status: 'manual',
  held_job: 'sentry-release-commit',
  held_job_url: AUT_6655_JOB_URL,
  draft: true,
  checked_at: checkedAt,
  waiting_since: waitingSince,
  timeout_minutes: 60,
});
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

export const ciHeldTaskDetail = taskDetailResponseSchema.parse({
  ...bugTaskDetail,
  task: {
    ...featureTask,
    id: IDS.taskCiHeld,
    ticket: { provider: 'jira', key: 'DEMO-8', url: HOSTILE.safeUrl },
    ticket_title: 'Release the Sentry commit',
    mr_ref: AUT_6655_MR,
    state: 'active',
    current_stage: 'ci_gate',
    iteration_counters: {},
  },
  returns: [],
  stop: null,
  gate_wait: aut6655Read(minutesAgo(12.5), minutesAgo(0.5)),
  last_gate_wait: null,
  escalation: null,
  stages: [
    {
      stage: 'implementation',
      attempt: 1,
      state: 'completed',
      entered_at: '2026-06-01T09:00:00.000Z',
      exited_at: '2026-06-01T09:28:00.000Z',
      outcome: null,
    },
    {
      stage: 'ci_gate',
      attempt: 1,
      state: 'running',
      entered_at: minutesAgo(12.5),
      exited_at: null,
      outcome: null,
    },
  ],
});

/**
 * S-25.12: the same wait after its 60 minutes — parked at `ci_gate` with the ending `ci_timed_out`
 * and the attempt's last read as `last_gate_wait`. The page words it from the read, never from the
 * recorded sentence, and never as a failure.
 */
export const ciHeldTimedOutTaskDetail = taskDetailResponseSchema.parse({
  ...ciHeldTaskDetail,
  task: {
    ...ciHeldTaskDetail.task,
    id: IDS.taskCiHeldTimedOut,
    ticket: { provider: 'jira', key: 'DEMO-9', url: HOSTILE.safeUrl },
    state: 'needs_human',
  },
  stop: {
    stage: 'ci_gate',
    attempt: 1,
    cause: 'no_answer',
    loop: null,
    ci_failure: null,
    recorded:
      'the CI gate on a poll-only gitlab binding timed out after 60 minutes (pipeline.limits.ci_timeout_minutes = 60)',
    recorded_cut: false,
    ci_ending: 'ci_timed_out',
  },
  gate_wait: null,
  last_gate_wait: aut6655Read('2026-06-01T09:28:00.000Z', '2026-06-01T10:27:30.000Z'),
  escalation: null,
  stages: [
    {
      stage: 'implementation',
      attempt: 1,
      state: 'completed',
      entered_at: '2026-06-01T09:00:00.000Z',
      exited_at: '2026-06-01T09:28:00.000Z',
      outcome: null,
    },
    {
      stage: 'ci_gate',
      attempt: 1,
      state: 'failed',
      entered_at: '2026-06-01T09:28:00.000Z',
      exited_at: '2026-06-01T10:28:00.000Z',
      outcome: 'undecided',
    },
  ],
});

/** An epic-split task with a queue of two proposed children (WP-44, PROGRESS backlog 108). */
/**
 * S-26.8b part 2 (the M26 UX spec § 4): three tasks whose implementation run waits for a machine
 * nobody has — Vojtěch's machine offline, the operator's own machine needing an update, and a
 * tracker assignee the platform cannot link — and the AUT-6655 task as the board's item, held at a
 * manual job. Served once `POST /__test__/waiting` opens them, so no other screen's board changes.
 */
const waitingTask = (
  n: number,
  taskId: string,
  waiting: Record<string, unknown>,
  over: Record<string, unknown> = {},
) => ({
  ...featureTask,
  id: taskId,
  ticket: { provider: 'jira', key: `DEMO-${n}`, url: HOSTILE.safeUrl },
  ticket_title: `Waiting task ${n}`,
  state: 'active',
  current_stage: 'implementation',
  owner: null,
  owner_source: null,
  unlinked_assignee: null,
  tracker_assignee: null,
  waiting: {
    reason: 'owner_worker_offline',
    user: { user_id: IDS.ownerVojtech, name: OWNER_NAME },
    last_seen_at: null,
    assignee_name: null,
    blockers: [],
    ...waiting,
  },
  ...over,
});

const waitingGlance = {
  stages: [
    { stage: 'refinement', attempt: 1, state: 'completed', entered_at: now },
    { stage: 'implementation', attempt: 1, state: 'running', entered_at: now },
  ],
  open_questions: 0,
  pending_approvals: 0,
  loop_limits: null,
  gate_wait: null,
  latest_return: null,
  stop: null,
  escalation_reason: null,
} as const;

export const waitingOfflineTask = taskRecordSchema.parse(
  waitingTask(
    20,
    IDS.taskWaitingOffline,
    { last_seen_at: minutesAgo(120) },
    { owner: { user_id: IDS.ownerVojtech, name: OWNER_NAME }, owner_source: 'platform' },
  ),
);

export const waitingListItems = [
  waitingOfflineTask,
  taskRecordSchema.parse(
    waitingTask(
      21,
      IDS.taskWaitingMine,
      {
        reason: 'owner_worker_cannot_take',
        user: { user_id: IDS.user, name: 'Fake Operator' },
        blockers: ['images_outdated'],
      },
      { owner: { user_id: IDS.user, name: 'Fake Operator' }, owner_source: 'platform' },
    ),
  ),
  taskRecordSchema.parse(
    waitingTask(
      22,
      IDS.taskWaitingUnlinked,
      { reason: 'assignee_not_linked', user: null, assignee_name: UNLINKED_ASSIGNEE },
      {
        unlinked_assignee: { display_name: UNLINKED_ASSIGNEE },
        tracker_assignee: { display_name: UNLINKED_ASSIGNEE, user_id: null },
      },
    ),
  ),
].map((task) => taskListItemSchema.parse({ ...task, ...waitingGlance }));

/** AUT-6655 on the board: active at the CI check, its pipeline held at a manual job. */
export const ciHeldListItem = taskListItemSchema.parse({
  ...ciHeldTaskDetail.task,
  ...waitingGlance,
  stages: [
    { stage: 'implementation', attempt: 1, state: 'completed', entered_at: now },
    { stage: 'ci_gate', attempt: 1, state: 'running', entered_at: now },
  ],
  gate_wait: ciHeldTaskDetail.gate_wait,
});

/** The inbox's `ci_held` row for the same task (backlog 1300). */
export const inboxCiHeld = inboxResponseSchema.shape.ci_held.parse([
  {
    task_id: IDS.taskCiHeld,
    project_id: IDS.project,
    ticket: ciHeldTaskDetail.task.ticket,
    gate_wait: ciHeldTaskDetail.gate_wait,
  },
]);

/** DEMO-20's own read: the task page says why it waits, and offers *Take it*. */
export const waitingOfflineTaskDetail = taskDetailResponseSchema.parse({
  ...bugTaskDetail,
  task: waitingOfflineTask,
  can_take: true,
  can_assign: true,
  returns: [],
  stop: null,
  gate_wait: null,
  last_gate_wait: null,
  stages: [
    {
      stage: 'refinement',
      attempt: 1,
      state: 'completed',
      entered_at: now,
      exited_at: now,
      outcome: null,
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
});

/** S-25.14: the person AUT-6676's Jira ticket is assigned to — not linked to a platform account. */
export const HELD_ELSEWHERE_ASSIGNEE = 'Vojtěch Kaizr';

/** S-25.14: the ticket's own page, which *Open in Jira* links. */
export const AUT_6676_URL = 'https://tickets.example.invalid/browse/AUT-6676';

/**
 * S-25.14 (product/10's Task detail amendment of 2026-11-07), AUT-6676's shape: the first agent
 * stage's claim read the ticket, found it assigned to Vojtěch Kaizr — a person the platform cannot
 * link — and stopped with `ticket_assigned_elsewhere`; no run started. The brief is the claim's own,
 * and names nobody: the callout's sentence comes from `tracker_assignee`. Nobody owns the task, the
 * operator (an administrator) may take or assign it, and their take writes the assignment back.
 */
export const heldElsewhereTaskDetail = taskDetailResponseSchema.parse({
  ...bugTaskDetail,
  task: {
    ...featureTask,
    id: IDS.taskHeldElsewhere,
    ticket: { provider: 'jira', key: 'AUT-6676', url: AUT_6676_URL },
    ticket_title: 'Export invoices as CSV',
    state: 'needs_human',
    current_stage: 'refinement',
    owner: null,
    owner_source: null,
    unlinked_assignee: { display_name: HELD_ELSEWHERE_ASSIGNEE },
    tracker_assignee: { display_name: HELD_ELSEWHERE_ASSIGNEE, user_id: null },
    owner_writes_back: false,
    mr_ref: null,
    waiting: null,
  },
  can_take: true,
  can_assign: true,
  can_unassign: false,
  take_writes_back: true,
  returns: [],
  stop: null,
  gate_wait: null,
  last_gate_wait: null,
  escalation: {
    at: '2026-11-05T13:22:12.114Z',
    reason: 'ticket_assigned_elsewhere',
    brief:
      'The platform did not start the "refinement" stage of AUT-6676: the ticket is assigned to somebody other than the account this project’s tracker binding uses. Unassign the ticket or assign it to the binding’s account, then hand the task back.',
    brief_original_chars: null,
  },
  stages: [
    {
      stage: 'refinement',
      attempt: 1,
      state: 'failed',
      entered_at: now,
      exited_at: now,
      outcome: 'ticket_assigned_elsewhere',
    },
  ],
});

/**
 * S-25.15 part B: AUT-6676 on the board and in the Inbox, served after `POST /__test__/waiting` —
 * stopped with `ticket_assigned_elsewhere`, so the card, Home's *Needs you* and the Inbox's
 * *Stopped* row say "Waiting for: Vojtěch Kaizr’s Jira ticket".
 */
export const heldElsewhereListItem = taskListItemSchema.parse({
  ...heldElsewhereTaskDetail.task,
  stages: [{ stage: 'refinement', attempt: 1, state: 'failed', entered_at: now }],
  open_questions: 0,
  pending_approvals: 0,
  loop_limits: null,
  gate_wait: null,
  latest_return: null,
  stop: null,
  escalation_reason: 'ticket_assigned_elsewhere',
});

/** The Inbox's `escalated` row for the same task (backlog 1360). */
export const inboxEscalated = inboxResponseSchema.shape.escalated.parse([
  {
    task_id: IDS.taskHeldElsewhere,
    project_id: heldElsewhereTaskDetail.task.project_id,
    ticket: heldElsewhereTaskDetail.task.ticket,
    ticket_title: heldElsewhereTaskDetail.task.ticket_title,
    current_stage: 'refinement',
    reason: 'ticket_assigned_elsewhere',
    at: '2026-11-05T13:22:12.114Z',
    tracker_assignee: heldElsewhereTaskDetail.task.tracker_assignee,
    unlinked_assignee: heldElsewhereTaskDetail.task.unlinked_assignee,
  },
]);

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
  // WP-121: nothing of the project's prompt files was withheld from this run.
  prompts_withheld: null,
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

/** WP-159: what *Retry run* offers — the seed's ids, which include the run's own model. */
export const orgModels = orgModelsResponseSchema.parse({
  models: [
    { model_id: 'claude-haiku-4-5' },
    { model_id: 'claude-opus-5' },
    { model_id: 'claude-sonnet-5' },
  ],
});

/**
 * S-23.6: two more tasks for the fleet — DEMO-5, a bug a worker is investigating (its title hostile,
 * so the map, the office and the list render tracker text as text), and DEMO-6, whose refinement
 * waits for a seat. Neither has a question or an approval, so their agents are not "needs you".
 */
export const fleetWorkerTaskDetail = taskDetailResponseSchema.parse({
  ...bugTaskDetail,
  task: {
    ...bugTask,
    id: IDS.taskFleetWorker,
    ticket: { provider: 'jira', key: 'DEMO-5', url: HOSTILE.safeUrl },
    ticket_title: `Flaky retries ${HOSTILE.image}`,
    state: 'active',
    current_stage: 'investigation',
  },
  stages: [
    {
      stage: 'refinement',
      attempt: 1,
      state: 'completed',
      entered_at: now,
      exited_at: now,
      outcome: 'approve',
    },
    {
      stage: 'investigation',
      attempt: 1,
      state: 'running',
      entered_at: now,
      exited_at: null,
      outcome: null,
    },
  ],
  questions: [],
  approvals: [],
  runs: [],
});

export const fleetQueuedTaskDetail = taskDetailResponseSchema.parse({
  ...bugTaskDetail,
  task: {
    ...bugTask,
    id: IDS.taskFleetQueued,
    ticket: { provider: 'jira', key: 'DEMO-6', url: HOSTILE.safeUrl },
    ticket_title: 'Export the invoice as CSV',
    state: 'active',
    current_stage: 'refinement',
  },
  stages: [
    {
      stage: 'refinement',
      attempt: 1,
      state: 'pending',
      entered_at: now,
      exited_at: null,
      outcome: null,
    },
  ],
  questions: [],
  approvals: [],
  runs: [],
});

/** S-23.6: DEMO-5's investigation, held by the worker `jan-mbp`, thinking. */
export const runWorker = runRecordSchema.parse({
  ...run,
  id: IDS.runWorker,
  task_id: IDS.taskFleetWorker,
  stage: 'investigation',
  role: 'investigator',
  model: 'claude-sonnet-5',
  effort: 'medium',
  prompt_version: 'investigator@1.0.0',
  cost: { usd: 0.8, is_estimate: true, price_list_id: null },
  model_usage: [],
});

/** S-23.6: DEMO-6's refinement, offered and not claimed yet — the queue. */
export const runQueued = runRecordSchema.parse({
  ...run,
  id: IDS.runQueued,
  task_id: IDS.taskFleetQueued,
  stage: 'refinement',
  role: 'product_manager',
  status: 'created',
  session_id: null,
  started_at: null,
  last_output_at: null,
  num_turns: 0,
  model_usage: [],
  cost: null,
  wall_ms: 0,
});

/**
 * `GET /api/org/agents` — every run that has not ended, with its seat and newest entry (S-23.15).
 * The fake backend restamps each `activity.at` to the moment it answers (`fake-backend.ts`), so a
 * run reads as working in a browser whose clock is not the fixtures' `now`, rather than as stuck.
 */
export const agents = agentsResponseSchema.parse({
  items: [
    {
      run,
      project_id: IDS.project,
      task_id: IDS.taskFeature,
      role: 'developer',
      last_output_at: now,
      seat: { kind: 'server', worker_id: null, worker_name: null },
      waiting: null,
      activity: { kind: 'tool', tool_name: 'Read', at: now },
    },
    {
      run: runWorker,
      project_id: IDS.project,
      task_id: IDS.taskFleetWorker,
      role: 'investigator',
      last_output_at: now,
      seat: { kind: 'worker', worker_id: IDS.worker, worker_name: 'jan-mbp' },
      waiting: null,
      activity: { kind: 'thinking', tool_name: null, at: now },
    },
    {
      run: runQueued,
      project_id: IDS.project,
      task_id: IDS.taskFleetQueued,
      role: 'product_manager',
      last_output_at: null,
      seat: null,
      waiting: null,
      activity: null,
    },
  ],
});

/** S-23.6: the machines — one with a free slot or two, one paused with a hostile name. */
export const workers = workersResponseSchema.parse({
  items: [
    {
      id: IDS.worker,
      name: 'jan-mbp',
      user: { id: IDS.user, email: 'operator@example.invalid', name: 'Fake Operator' },
      created_at: now,
      last_seen_at: now,
      protocol_version: 1,
      image_digests: [],
      state: 'active',
      revoked_at: null,
      paused_until: null,
      manually_paused_at: null,
      claim_projects: null,
      paused_reason: null,
      paused_until_estimated: false,
      concurrency: 3,
      running: [{ run_id: IDS.runWorker, task_id: IDS.taskFleetWorker, project_id: IDS.project }],
      last_update: null,
      // Last seen at the fixture's `now`, two months before any browser's clock: the server says
      // it is not connected (S-22.19), which the wizard's Ready step reads (S-23.24).
      claim_blockers: ['offline'],
      can_claim: false,
      last_claimed_at: null,
      // S-26.4's fields, which the Workers screen's card reads (S-26.8a).
      claim_policy: 'mine_and_unassigned',
      policy_skipped_offers: 0,
    },
    {
      id: IDS.workerPaused,
      name: `night-owl ${HOSTILE.image}`,
      user: { id: IDS.user, email: 'operator@example.invalid', name: 'Fake Operator' },
      created_at: now,
      last_seen_at: now,
      protocol_version: 1,
      image_digests: [],
      state: 'active',
      revoked_at: null,
      // Far ahead of any browser's clock: paused for the whole run of the suite.
      paused_until: '2099-01-01T00:00:00.000Z',
      manually_paused_at: null,
      claim_projects: null,
      paused_reason: 'usage_limited',
      paused_until_estimated: false,
      concurrency: 2,
      running: [],
      last_update: null,
      claim_blockers: ['usage_limited'],
      can_claim: false,
      last_claimed_at: null,
      claim_policy: 'everything',
      policy_skipped_offers: 0,
    },
  ],
  scope: 'all',
  timezone: 'UTC',
});

/**
 * S-26.8a: the same list with a machine of **another person** in it — what an administrator reads
 * (`scope: all`). Its policy is *Only my tasks*, and it leaves three runs for others. Served only
 * after `POST /__test__/workers-others`, so the Agents map and every other screen that reads the
 * workers keep {@link workers}' two.
 */
export const workersWithOthers = workersResponseSchema.parse({
  ...workers,
  items: [
    ...workers.items,
    {
      ...workers.items[0],
      id: IDS.workerOthers,
      name: 'vojta-mbp',
      user: { id: IDS.otherUser, email: 'vojtech@example.invalid', name: 'Vojtěch' },
      running: [],
      claim_policy: 'mine',
      policy_skipped_offers: 3,
    },
  ],
});

/**
 * S-23.20: the project's execution setting — the platform server runs agent work here, so Home
 * shows no *Connect a worker* step and the Agents page waits for a seat, not for a worker.
 */
export const projectExecution = projectExecutionResponseSchema.parse({
  mode: 'hybrid',
  prefer: 'server',
  fallback_after_seconds: null,
  assignee_window_seconds: 120,
  offer_timeout_seconds: 86_400,
  effective_fallback_after_seconds: 15,
  stored: false,
  server_claimant: 'running',
  others_take_unassigned: false,
  notice: null,
  workers: [],
  waiting: {
    open: 0,
    closed_to_workers: { credential_refused: 0, server_only: 0, server_first: 0 },
  },
});

/**
 * S-26.8a: the same project with no server claimant — served with {@link workersWithOthers}. Asked
 * without a machine it says nobody else takes the project's unassigned tasks; asked `?worker_id=`
 * (the Workers screen's consequence line) the fake computes the answer from the listed machines, as
 * the server does (`fake-backend.ts`'s `executionFor`), so the owner's other machine counts.
 */
export const projectExecutionNoTaker = projectExecutionResponseSchema.parse({
  ...projectExecution,
  server_claimant: 'none',
  others_take_unassigned: false,
});

/** The fleet's two other runs have no transcript yet. */
export const emptyRunMessages = runMessagesResponseSchema.parse({ items: [], next_seq: null });

export const inbox = inboxResponseSchema.parse({
  questions: [question],
  approvals: [approval],
  ci_held: [],
  escalated: [],
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
      config: {
        site_url: 'https://fake.atlassian.invalid',
        user_email: 'operator@example.invalid',
      },
      health: { status: 'ok', checked_at: now, detail: null },
      config_refusal: null,
      retired_at: null,
      credentials_readable: null,
      credentials_consequence: null,
      // S-25.3: health from traffic, and who uses it.
      activity: { last_call: { at: now, ok: true, error: null }, last_delivery_at: null },
      current_health: { status: 'working', basis: 'call', at: now },
      used_by: [
        {
          project_id: IDS.project,
          project_key: PROJECT_KEY,
          project_name: 'Demo service',
          uses: [{ label: 'Tickets from', value: 'DEMO' }],
        },
      ],
    }),
  ],
  // S-23.23: the fake signs in an administrator, who may write integrations.
  can_write: true,
};

/**
 * `GET /api/integrations/providers` — the real catalogue through the server's own projection
 * (WP-100), so the create form this tier drives renders the fields the shipped providers require.
 */
export const integrationProviders = integrationProvidersResponseSchema.parse({
  items: SHIPPED_PROVIDERS.map(toIntegrationProvider),
});

/**
 * `POST /api/integrations/:id/test` — a probe that reached the provider and was refused (WP-155,
 * backlog 451). The detail carries markup on purpose: it is the provider's words (BD-022).
 */
export const failedConnectionTest = testIntegrationResponseSchema.parse({
  ok: false,
  checks: [
    { name: 'reachable', ok: true, detail: 'HTTP 200 from fake.atlassian.invalid' },
    {
      name: 'authenticated',
      ok: false,
      detail: '401 <b>Unauthorized</b>: the API token was refused',
    },
  ],
});

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

// ── Your accounts and the unlinked assignees (S-26.8a) ────────────────────────

/** The operator's Jira account the fake's comment proves — its id and its (hostile) name. */
export const LINK_ACCOUNT = {
  id: '5b10fakeaccount0001',
  name: `Jan Novák ${HOSTILE.image}`,
} as const;

/** `POST /api/me/identity-links` — the code, answered once. */
export const identityLinkIssued = identityLinkCodeIssuedSchema.parse({
  id: id(110),
  code: 'agentic-link-7K3Q9VDM2X',
  expires_at: '2099-01-01T10:30:00.000Z',
});

/**
 * The match the fake records the moment a code is issued — as if the operator's comment had already
 * arrived — so the browser sees the confirmation without waiting for a poll.
 */
export const identityLinkMatch = identityLinkMatchSchema.parse({
  id: id(111),
  provider: 'jira-cloud',
  external_id: LINK_ACCOUNT.id,
  display_name: LINK_ACCOUNT.name,
  integration_id: IDS.integration,
  integration_name: 'Jira (fake)',
  matched_at: now,
  confirmed_at: null,
});

/** `POST …/matches/:id/confirm` — the link, and the two live tasks it made the operator's. */
export const identityLinkConfirmed = identityLinkConfirmedSchema.parse({
  provider: 'jira-cloud',
  external_id: LINK_ACCOUNT.id,
  display_name: LINK_ACCOUNT.name,
  user_id: IDS.user,
  performed: true,
  adopted_task_ids: [IDS.taskFeature, IDS.taskBug],
});

/**
 * `GET /api/org/identities/candidates` — an unlinked tracker assignee of three live tasks (S-26.6,
 * `deliveries: 0`) and an account the platform refused a decision from.
 */
export const identityCandidates = identityCandidateListSchema.parse({
  items: [
    {
      provider: 'jira-cloud',
      external_id: '5b10fakeassignee0002',
      deliveries: 0,
      assigned_tasks: 3,
      display_name: `Eva Malá ${HOSTILE.image}`,
      last_seen_at: now,
    },
    {
      provider: 'slack',
      external_id: 'U0FAKEREFUSED',
      deliveries: 2,
      last_seen_at: now,
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
  last_discovery: {
    task_id: IDS.taskBug,
    state: 'done',
    cost_usd: 0.84,
    findings_unrecorded: null,
    escalation: null,
  },
});

export const orgSettings = orgSettingsResponseSchema.parse({
  settings: {
    commands: { block: ['<img src=x onerror=alert(1)>'] },
    autonomy: { maximum: 'supervised' },
  },
  updated_at: now,
});

/**
 * `GET /api/projects/:id/spend` (S-25.7): the month's booked cost per stage and its top tasks, one
 * of them partly estimated — the Budgets tab's breakdown. The ticket title is hostile on purpose.
 */
export const projectSpend = projectSpendResponseSchema.parse({
  window: 'month',
  window_start: now,
  usd: 12.5,
  estimated_usd: 0.5,
  stages: [
    { stage: 'implementation', usd: 9, estimated_usd: 0.5 },
    { stage: 'refinement', usd: 3.5, estimated_usd: 0 },
  ],
  top_tasks: [
    {
      task_id: IDS.taskFeature,
      ticket_key: 'DEMO-1',
      ticket_title: `Checkout ${HOSTILE.script}`,
      mode: 'normal',
      usd: 12.5,
      estimated_usd: 0.5,
    },
  ],
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
    // WP-113: no reading holds a prompt directory yet.
    prompts: null,
    // WP-121: and none was withheld.
    prompts_withheld: null,
  },
  sources: { version: 'default' },
  hash: 'fakehash1',
  computed_at: now,
  not_applied: [],
  last_export: null,
  // WP-54: the project declares no `commands.allow`, so nothing is ignored.
  ignored_allow_commands: [],
  // WP-113: which prompt file each stage would be given — none.
  stage_prompts: [],
  // WP-181: no lifecycle slot is mapped, so `status_mapping` applies.
  status_mapping_superseded: false,
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

/**
 * `GET /api/org/failed-jobs` (WP-108, PROGRESS backlog 325): one job pg-boss gave up on, so the
 * bundle draws the section's success branch rather than the fake's 404 (backlog 326's lesson).
 */
export const failedJobs = failedJobsResponseSchema.parse({
  items: [
    {
      id: id(62),
      queue: 'pipeline.outbound',
      attempts: 3,
      retry_limit: 2,
      created_at: now,
      failed_at: now,
      // Handler text is untrusted: it is shown as characters.
      error: `outbound ${HOSTILE.script}`,
      error_truncated: false,
      task: null,
      exhaustion: {
        kind: 'relies_on_retries',
        shape: 'per_duty',
        loss: 'one provider call the pipeline decided on',
        recovered_by: 'per duty: the last try of a duty a person waits on escalates its task',
      },
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

/**
 * The board's page items (S-23.9a): the records plus the card's glance, agreeing with the detail
 * reads above — DEMO-1 entered refinement and is in implementation, with the feature detail's open
 * question and pending approval; DEMO-2 entered nothing the board has a row for yet.
 */
export const featureListItem = taskListItemSchema.parse({
  ...featureTask,
  stages: [
    { stage: 'refinement', attempt: 1, state: 'completed', entered_at: now },
    { stage: 'implementation', attempt: 1, state: 'running', entered_at: now },
  ],
  open_questions: 1,
  pending_approvals: 1,
  loop_limits: null,
  gate_wait: null,
  latest_return: null,
  stop: null,
  escalation_reason: null,
});

export const bugListItem = taskListItemSchema.parse({
  ...bugTask,
  stages: [],
  open_questions: 0,
  pending_approvals: 0,
  loop_limits: null,
  gate_wait: null,
  latest_return: null,
  stop: null,
  escalation_reason: null,
});

export const tasksPage = {
  items: [featureListItem, bugListItem],
  next_cursor: null,
  can_start_task: true,
  can_cancel_task: true,
  can_return_to_stage: true,
  can_pause_task: true,
  can_resume_task: true,
};

// S-23.23: the fake signs in an administrator, who may create a project.
export const projectsPage = { items: [project], can_create: true };

/**
 * `GET /api/projects/:id/bindings` (WP-182): the project's one tracker binding, the integration
 * above, with no lifecycle block yet — what the wizard's step 1 maps.
 */
export const projectBindings = projectBindingsResponseSchema.parse({
  items: [
    {
      integration_id: IDS.integration,
      type: 'task_management',
      provider: 'jira-cloud',
      name: 'Jira (fake)',
      config: {},
    },
  ],
});

/**
 * The project's bindings once a git host is bound too (S-25.10b): what `POST /__test__/wizard-open`
 * switches the bindings read to, so the New project wizard's Connect step is done and the steps past
 * it are open rather than drawn as their "not open yet" gate. The git binding is **invented** for
 * this corpus; nothing else reads it.
 */
export const openWizardBindings = projectBindingsResponseSchema.parse({
  items: [
    ...projectBindings.items,
    {
      integration_id: id(51),
      type: 'git',
      provider: 'gitlab',
      name: 'GitLab (fake)',
      config: {},
    },
  ],
});

/**
 * `GET /api/projects/:id/readiness` — an evaluation, served only after `POST /__test__/wizard-open`
 * (the default fake answers 404, the "not evaluated" a project starts with). One criterion is
 * enough for the wizard's Technical discovery step to count as done.
 */
export const readiness = readinessResponseSchema.parse({
  level: 1,
  evaluated_at: now,
  criteria: [
    {
      id: 'R1',
      passed: true,
      evidence: 'npm test exits 0',
      unlocks: 'Agents can check their own work.',
      detected_by: 'agent',
    },
  ],
  source: 'discovery',
  next_improvements: [],
  notices: [],
});

/**
 * `GET /api/projects/:id/repository` (S-25.10b): the stored default branch, no provider read — what
 * the project settings' *Default branch* section draws its form over.
 */
export const projectRepository = projectRepositoryResponseSchema.parse({
  default_branch: 'main',
  provider: null,
  provider_unavailable: null,
  live_tasks: 0,
});

/**
 * `GET /api/projects/:id/history-bootstraps` (S-25.10b): nothing mined yet, and a bootstrap may
 * start — the *History* section's and the wizard step's empty state and start form. The estimate's
 * figures are **invented**.
 */
export const historyBootstraps = historyBootstrapsResponseSchema.parse({
  items: [],
  can_start: true,
  blocked_reason: null,
  estimate: {
    merge_requests: 200,
    batch_size: 20,
    batches: 10,
    estimated_usd: 4,
    cap_usd: 10,
    stops_at_cap: false,
    days: 182,
  },
  max_merge_requests: 1000,
});

/**
 * `GET /api/projects/:id/shadow-batches` (S-25.10b): no trial yet, and one may start — what the
 * Trial page draws its start form for.
 */
export const shadowBatches = shadowBatchesResponseSchema.parse({
  items: [],
  can_start: true,
  blocked_reason: null,
});

/**
 * `GET /api/projects/:id/owner-candidates` (S-26.1's follow-up, S-26.8b's *Assign…*): by name, the
 * operator (not written back), Petra (written back — the name carries the hostile script, since a
 * person's name is their own text) and DEMO-1's owner, who the picker marks and does not offer.
 */
export const ownerCandidates = ownerCandidatesResponseSchema.parse({
  items: [
    { user_id: IDS.user, name: 'Fake Operator', writes_back: false },
    { user_id: IDS.ownerPetra, name: CANDIDATE_NAME, writes_back: true },
    { user_id: IDS.ownerVojtech, name: OWNER_NAME, writes_back: true },
  ],
});

/**
 * `GET /api/projects/:id/ticket-statuses` (WP-182): the tracker's statuses, **invented** for this
 * corpus (BD-031 ruling 1: no status name is assumed anywhere but a fixture).
 */
export const ticketStatuses = ticketStatusesResponseSchema.parse({
  items: [
    { id: '10001', name: 'Doing', category: 'in_progress', raw_category: 'indeterminate' },
    {
      id: '10002',
      name: 'Waiting for review',
      category: 'in_progress',
      raw_category: 'indeterminate',
    },
    { id: '10003', name: 'Testing', category: 'in_progress', raw_category: 'indeterminate' },
    { id: '10004', name: 'Sent back', category: 'todo', raw_category: 'new' },
  ],
});

/**
 * The stage graphs (S-23.5's flow canvas): **the server's own builder** over the shipped templates,
 * not a hand-drawn copy — a fake kinder than the read would let the canvas pass on a graph the
 * server never sends (standing rule 1). The task's graph is the feature template as DEMO-1 froze it,
 * with the implementation stage's model the run ran with.
 */
const graphOf = (template: string, models: Readonly<Record<string, string>>) =>
  pipelineGraphSchema.parse(
    pipelineGraphOf(
      compilePipeline(template, SHIPPED_TEMPLATES[template] as PipelineTemplate, null, false),
      {
        limits: resolveIterationLimits(),
        agentOf: (stage) => ({ model: models[stage] ?? 'claude-sonnet-5', effort: 'high' }),
      },
    ),
  );

export const featurePipeline = graphOf('feature', { implementation: 'claude-opus-5' });

/** `GET /api/tasks/:id/pipeline` per task, by the template each task froze. */
export const taskPipelines: Readonly<Record<string, unknown>> = {
  [IDS.taskFeature]: featurePipeline,
  [IDS.taskBug]: graphOf(bugTask.template, {}),
  [IDS.taskTaken]: featurePipeline,
  [IDS.taskEpic]: graphOf(epicTaskDetail.task.template, {}),
  [IDS.taskFleetWorker]: graphOf('bug', {}),
  [IDS.taskFleetQueued]: graphOf('bug', {}),
  [IDS.taskCiFixing]: featurePipeline,
  [IDS.taskCiTimedOut]: featurePipeline,
  [IDS.taskCiHeld]: featurePipeline,
  [IDS.taskCiHeldTimedOut]: featurePipeline,
  [IDS.taskHeldElsewhere]: featurePipeline,
};

export const projectPipelines = { items: [featurePipeline, graphOf('bug', {})] };
