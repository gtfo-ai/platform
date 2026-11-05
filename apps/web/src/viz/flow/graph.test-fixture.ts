/**
 * A feature-shaped stage graph for the flow canvas's unit tests — the published shape
 * (`pipelineGraphSchema`), parsed, so a field the contract adds fails here first. Hand-written
 * rather than compiled: the web app does not import the server's `pipelineGraphOf`; the Playwright
 * corpus does (`test/web-e2e/support/fixtures.ts`), so the browser tier draws the real one.
 *
 * Shape: the main path intake → … → done; `conflict_resolution` entered only by the rebase gate's
 * failure (a return); `qa` disabled; four bounded returns.
 */
import { type PipelineGraph, pipelineGraphSchema } from '@platform/contracts';

const agent = (
  id: string,
  role: PipelineGraph['nodes'][number]['role'],
  produces: PipelineGraph['nodes'][number]['produces'],
  enabled = true,
): PipelineGraph['nodes'][number] => ({
  id,
  kind: 'agent',
  role,
  enabled,
  advisory: false,
  model: 'claude-test',
  effort: 'high',
  produces,
});

const other = (id: string, kind: 'system' | 'gate' | 'human'): PipelineGraph['nodes'][number] => ({
  id,
  kind,
  role: null,
  enabled: true,
  advisory: false,
  model: null,
  effort: null,
  produces: null,
});

const edge = (
  from: string,
  to: string,
  kind: PipelineGraph['edges'][number]['kind'],
  loop: string | null = null,
  limit: number | null = null,
  onEvent: PipelineGraph['edges'][number]['on_event'] = null,
): PipelineGraph['edges'][number] => ({
  from,
  to,
  kind,
  on_event: onEvent,
  loop,
  loop_limit: limit,
});

export const FEATURE_GRAPH: PipelineGraph = pipelineGraphSchema.parse({
  template: 'feature',
  nodes: [
    other('intake', 'system'),
    agent('refinement', 'product_manager', 'RefinedSpec'),
    agent('architecture', 'architect', 'ImplementationPlan'),
    agent('implementation', 'developer', 'ImplementationNotes'),
    agent('conflict_resolution', 'developer', 'ImplementationNotes'),
    other('ci_gate', 'gate'),
    agent('code_review', 'reviewer', 'ReviewVerdict'),
    other('rebase_gate', 'gate'),
    agent('qa', 'acceptance_tester', 'AcceptanceVerdict', false),
    other('ready_for_merge', 'human'),
    other('done', 'system'),
  ],
  edges: [
    edge('intake', 'refinement', 'next'),
    edge('refinement', 'architecture', 'approve'),
    edge('architecture', 'implementation', 'approve'),
    edge('architecture', 'refinement', 'return', 'architecture_revisions', 2),
    edge('implementation', 'ci_gate', 'approve'),
    edge('implementation', 'architecture', 'return', 'architecture_revisions', 2),
    edge('conflict_resolution', 'ci_gate', 'approve'),
    edge('ci_gate', 'code_review', 'pass'),
    edge('ci_gate', 'implementation', 'fail', 'ci_fix', 3),
    edge('code_review', 'rebase_gate', 'approve'),
    edge('code_review', 'implementation', 'return', 'code_review', 3),
    edge('rebase_gate', 'ready_for_merge', 'pass'),
    edge('rebase_gate', 'conflict_resolution', 'fail', 'rebase', 2),
    edge('ready_for_merge', 'done', 'on', null, null, 'mr.merged'),
  ],
});
