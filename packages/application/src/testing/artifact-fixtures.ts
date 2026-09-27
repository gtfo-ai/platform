/**
 * Artifact payloads a test can script a run with, **valid** against the schema the real runner
 * parses the model's answer with (WP-69, PROGRESS backlog 77).
 *
 * The pipeline harness now refuses a scripted artifact that does not parse
 * (`ScriptedRunRefusedError`), which is how the sweep this module came out of was found: eleven
 * files scripted a `RefinedSpec` or an `ImplementationPlan` that was only the two or three fields
 * the test happened to read — `{ decision: 'ask', questions: [...] }` — and so proved the
 * pipeline's behaviour on data no model could have produced. A test that needs a *different* field
 * spreads over these rather than writing a partial one, so the rest of the payload stays a payload
 * production would accept.
 *
 * Typed with the contract's own inferred types, so a field the schema adds is a compile error here
 * rather than a refusal in forty tests.
 */
import type {
  ArtifactQuestion,
  ImplementationPlanData,
  RefinedSpecData,
} from '@platform/contracts';

/** A refinement that proceeds: nothing to ask, nothing out of the documented direction. */
export const PROCEEDING_REFINED_SPEC: RefinedSpecData = {
  goal: 'Show the totals in the invoice footer.',
  user_value: 'Finance can read the invoice without a calculator.',
  in_scope: ['the footer'],
  out_of_scope: [],
  acceptance_criteria: [],
  non_functional: [],
  dependencies: [],
  size: 'M',
  drift: { flag: false, justification: 'in the documented direction' },
  assumptions: [],
  questions: [],
  decision: 'proceed',
  kb_citations: [],
};

/** One blocking question, which is what makes a refinement stop and wait for a human. */
export const blockingQuestion = (text: string, id = 'q1'): ArtifactQuestion => ({
  id,
  text,
  blocking: true,
});

/** A refinement that asks: `decision: 'ask'` with the questions given, everything else valid. */
export const askingRefinedSpec = (
  questions: readonly ArtifactQuestion[] = [blockingQuestion('Which currency?')],
  overrides: Partial<RefinedSpecData> = {},
): RefinedSpecData => ({
  ...PROCEEDING_REFINED_SPEC,
  decision: 'ask',
  questions: [...questions],
  ...overrides,
});

/** A plan with one file to change and nothing else the architecture stage would flag. */
export const IMPLEMENTATION_PLAN: ImplementationPlanData = {
  approach: 'Sum the lines in the renderer.',
  alternatives_considered: [],
  affected_modules: ['invoices'],
  files_to_change: [{ path: 'src/totals.ts', change: 'add the sum' }],
  data_changes: [],
  api_changes: [],
  validation_contract: [],
  test_plan: [],
  rollout_notes: 'none',
  risks: [],
  estimated_size: 'M',
  decisions_to_record: [],
  protected_path_changes: [],
};
