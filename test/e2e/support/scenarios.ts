/**
 * The structured outputs the scripted stages return, shared by every pipeline e2e.
 *
 * They live beside the harness rather than inside one test file because two files now drive the
 * same templates — the happy path and the uncomposed-instance handover — and a second copy would
 * be a second thing to keep validating against the published artifact schemas. `FakeClaudeRunner`
 * refuses a scenario whose structured output does not validate (its divergence 3), so these are
 * held to the contracts by every run that uses them.
 */
import { PLANTED_MODEL_KEY } from './agent-workspace.js';
import type { SeededWorld } from './pipeline.js';

const REFINED_SPEC = {
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
};

const ROOT_CAUSE = {
  reproduction: { kind: 'reproduced', steps: ['open an invoice'], evidence: ['sentry: TOTALS-1'] },
  root_cause: 'The footer sums the visible rows rather than all of them.',
  confidence: 'high',
  affected_scope: ['invoices'],
  fix_direction: 'Sum the model, not the view.',
  regression_test_idea: 'A three-line invoice with one row hidden.',
  questions: [],
};

const PLAN = {
  approach: 'Sum the invoice model in the renderer.',
  alternatives_considered: [{ option: 'sum in SQL', why_not: 'the view already has the model' }],
  affected_modules: ['invoices'],
  files_to_change: [{ path: 'src/totals.ts', change: 'sum the model' }],
  data_changes: [],
  api_changes: [],
  validation_contract: [{ criterion_id: 'ac1', check: { kind: 'test', value: 'totals.test.ts' } }],
  test_plan: ['totals.test.ts'],
  rollout_notes: 'no flag needed',
  risks: [],
  estimated_size: 'M',
  decisions_to_record: [],
  protected_path_changes: [],
};

/** The developer reports the merge request the provider gave it (`world.mr`). */
const notesFor = (world: SeededWorld) => ({
  summary: 'Summed the invoice model in the footer.',
  deviations_from_plan: [],
  tests_added: ['totals.test.ts'],
  commands_run: [{ command: 'npm test', exit_code: 0, summary: '12 passed' }],
  known_gaps: [],
  followup_tickets: [],
  mr: {
    url: world.mr.url,
    iid: world.mr.iid,
    head_sha: world.mr.headSha,
    branch: world.branch,
  },
});

const REVIEW = {
  verdict: 'approve',
  findings: [],
  summary: 'Matches the plan; the test covers the criterion.',
  protected_path_changes_confirmed: [],
};

const ACCEPTANCE = {
  verdict: 'approve',
  criteria: [{ id: 'ac1', status: 'met', evidence: 'totals.test.ts passes on the head commit' }],
  scope_creep: [],
  missing: [],
  ux_notes: [],
};

const RETRO = {
  what_went_well: ['the plan held'],
  returns: [],
  human_corrections: [],
  cost_summary: {
    total_usd: 2,
    is_estimate: false,
    by_stage: [{ stage: 'implementation', usd: 0.4 }],
  },
  proposals: [],
};

/**
 * The Librarian's curation of what the retrospective proposed (WP-18b).
 *
 * Four proposals, chosen so that one scenario exercises every branch of BD-018's policy **and** the
 * two refusals that have nothing to do with significance:
 *
 *  - `L-2026-09-12-totals.md` sits **inside** the band (0.4) and is what `auto_apply` decides on. Its
 *    body repeats this run's own model credential, the way a model quoting its environment would —
 *    planted so the redaction assertion has something to look for (standing rule 45), and **not**
 *    redacted by the runner, which passes `structuredOutput` through untouched;
 *  - `L-2026-09-12-noise.md` is **below** `discard_below` (0.05): recorded, never applied;
 *  - `L-2026-09-12-rounding.md` is **above** `proposal_above` (0.9): always a maintainer's decision,
 *    whatever `auto_apply` says;
 *  - the fourth aims at `.github/workflows/ci.yml` through a `..`, which BD-025 refuses whatever its
 *    significance is.
 */
const librarianFor = (world: SeededWorld) => ({
  proposals: [
    {
      action: 'add',
      kind: 'technical',
      type: 'lesson',
      target_path: 'lessons/L-2026-09-12-totals.md',
      delta: `---\ntype: lesson\nconfidence: proposed\n---\n\nSum the invoice model, not the view.\n\nThe run was given ${PLANTED_MODEL_KEY} and repeated it here.\n`,
      evidence: [world.mr.url],
      significance: 0.4,
      reason: 'nothing in the vault covers where the totals are summed',
    },
    {
      action: 'add',
      kind: 'process',
      type: 'doc-update',
      target_path: 'lessons/L-2026-09-12-noise.md',
      delta: '---\ntype: lesson\n---\n\nA typo was fixed.\n',
      evidence: [world.mr.url],
      significance: 0.05,
      reason: 'barely worth saying',
    },
    {
      action: 'add',
      kind: 'technical',
      type: 'rule',
      target_path: 'lessons/L-2026-09-12-rounding.md',
      delta: '---\ntype: pitfall\n---\n\nRound once, at the edge.\n',
      evidence: [world.mr.url],
      significance: 0.9,
      reason: 'a new rule always goes to a maintainer',
    },
    {
      action: 'update',
      kind: 'process',
      type: 'doc-update',
      target_path: '../../.github/workflows/ci.yml',
      delta: 'on: [push]\n',
      evidence: [world.mr.url],
      significance: 0.95,
      reason: 'the pipeline should run on push',
    },
  ],
  health: [
    {
      kind: 'expired',
      path: 'lessons/L-2025-01-01-old.md',
      detail: 'expires: 2025-06-01 has passed',
    },
  ],
  summary: 'One page to add, one rule for a human, one drop and one refusal.',
});

export const featureScenarios = (world: SeededWorld) => ({
  refinement: { structuredOutput: REFINED_SPEC },
  architecture: { structuredOutput: PLAN },
  implementation: { structuredOutput: notesFor(world) },
  code_review: { structuredOutput: REVIEW },
  business_review: { structuredOutput: ACCEPTANCE },
  retrospective: { structuredOutput: RETRO },
  librarian: { structuredOutput: librarianFor(world) },
});

export const bugScenarios = (world: SeededWorld) => ({
  ...featureScenarios(world),
  investigation: { structuredOutput: ROOT_CAUSE },
});

/**
 * The tickets the fake provider knows; the workpad is a comment on one of them.
 *
 * `description` is here since WP-15f: the platform reads the ticket once at intake and stores a
 * bounded snapshot on the task, so a ticket with no body would make the e2e assert the *unread*
 * shape rather than the one the work package exists for.
 */
export const TICKETS = [
  {
    key: 'ACME-1',
    title: 'Show the totals in the invoice footer',
    issueType: 'Story',
    /**
     * The trailing token is **planted, obviously fake, and load-bearing** (WP-15f review round 1).
     *
     * It matches the `gitlab-token` rule of TD-012 step 2, so the ingress e2e can assert that the
     * shipped `patternRedactor()` really reaches `tasks.ticket_snapshot` through
     * `apps/server/src/pipeline.ts`'s own composition — the sink this work package created, which
     * the executor's own redactor does *not* cover (it redacts the audit row, not the result).
     * Named for what it is rather than for what it should satisfy (standing rule 45).
     */
    description:
      'The footer sums the visible rows rather than all of them. Reproduce with glpat-notarealtokenatall.',
  },
  { key: 'ACME-2', title: 'Show the totals in the invoice footer', issueType: 'Story' },
  {
    key: 'ACME-9',
    title: 'The invoice footer sums the wrong rows',
    issueType: 'Bug',
    description: 'A three-line invoice with one row hidden shows the wrong total.',
  },
];
