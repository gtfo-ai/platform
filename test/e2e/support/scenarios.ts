/**
 * The structured outputs the scripted stages return, shared by every pipeline e2e.
 *
 * They live beside the harness rather than inside one test file because two files now drive the
 * same templates — the happy path and the uncomposed-instance handover — and a second copy would
 * be a second thing to keep validating against the published artifact schemas. `FakeClaudeRunner`
 * refuses a scenario whose structured output does not validate (its divergence 3), so these are
 * held to the contracts by every run that uses them.
 */
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

export const featureScenarios = (world: SeededWorld) => ({
  refinement: { structuredOutput: REFINED_SPEC },
  architecture: { structuredOutput: PLAN },
  implementation: { structuredOutput: notesFor(world) },
  code_review: { structuredOutput: REVIEW },
  business_review: { structuredOutput: ACCEPTANCE },
  retrospective: { structuredOutput: RETRO },
});

export const bugScenarios = (world: SeededWorld) => ({
  ...featureScenarios(world),
  investigation: { structuredOutput: ROOT_CAUSE },
});

/** The tickets the fake provider knows; the workpad is a comment on one of them. */
export const TICKETS = [
  { key: 'ACME-1', title: 'Show the totals in the invoice footer', issueType: 'Story' },
  { key: 'ACME-2', title: 'Show the totals in the invoice footer', issueType: 'Story' },
  { key: 'ACME-9', title: 'The invoice footer sums the wrong rows', issueType: 'Bug' },
];
