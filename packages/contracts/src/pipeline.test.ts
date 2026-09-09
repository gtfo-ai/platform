import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  customStageSchema,
  type PipelineTemplate,
  pipelineFileSchema,
  pipelineGraphIssues,
  stageSchema,
} from './pipeline.js';
import { PROPERTY_TEST_TIMEOUT_MS } from './testing/property.js';

/**
 * The `feature` template from docs/technical/12-configuration-and-schemas.md
 * § ".agentic/pipeline.yml", written out as the nested form the document says real files use.
 */
const FEATURE_TEMPLATE: PipelineTemplate = {
  stages: [
    { id: 'intake', kind: 'system' },
    {
      id: 'refinement',
      kind: 'agent',
      role: 'product_manager',
      produces: 'RefinedSpec',
      requires: [],
    },
    {
      id: 'architecture',
      kind: 'agent',
      role: 'architect',
      produces: 'ImplementationPlan',
      requires: ['RefinedSpec'],
    },
    {
      id: 'implementation',
      kind: 'agent',
      role: 'developer',
      produces: 'ImplementationNotes',
      requires: ['ImplementationPlan'],
    },
    {
      id: 'ci_gate',
      kind: 'gate',
      on: 'ci.pipeline.finished',
      pass_to: 'code_review',
      fail_to: 'implementation',
    },
    {
      id: 'code_review',
      kind: 'agent',
      role: 'reviewer',
      produces: 'ReviewVerdict',
      approve_to: 'business_review',
      return_to: 'implementation',
    },
    {
      id: 'business_review',
      kind: 'agent',
      role: 'acceptance_tester',
      produces: 'AcceptanceVerdict',
      approve_to: 'rebase_gate',
      return_to: 'implementation',
    },
    { id: 'rebase_gate', kind: 'gate', pass_to: 'ready_for_merge' },
    {
      id: 'ready_for_merge',
      kind: 'human',
      on: [
        { on: 'mr.review.comment', to: 'implementation' },
        { on: 'mr.merged', to: 'merged_gate' },
      ],
    },
    { id: 'merged_gate', kind: 'gate', pass_to: 'retrospective' },
    { id: 'retrospective', kind: 'agent', role: 'facilitator', produces: 'RetroReport' },
    { id: 'librarian', kind: 'agent', role: 'librarian' },
    { id: 'done', kind: 'system' },
  ],
  custom: [
    {
      id: 'security_scan',
      kind: 'gate',
      after: 'ci_gate',
      command: 'trivy fs .',
      fail_to: 'implementation',
    },
    {
      id: 'docs_update',
      kind: 'agent',
      after: 'business_review',
      role: 'developer',
      prompt: 'prompts/docs-update.md',
    },
  ],
};

const FILE = { version: 1, templates: { feature: FEATURE_TEMPLATE } };

describe('.agentic/pipeline.yml', () => {
  it('parses the feature template from technical/12 unchanged', () => {
    expect(pipelineFileSchema.parse(FILE)).toEqual(FILE);
  });

  it('refuses an unknown major version', () => {
    expect(pipelineFileSchema.safeParse({ ...FILE, version: 2 }).success).toBe(false);
  });

  it('rejects an unknown key on a stage', () => {
    const result = pipelineFileSchema.safeParse({
      version: 1,
      templates: {
        feature: { stages: [{ id: 'intake', kind: 'system', colour: 'blue' }] },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown stage kind', () => {
    expect(stageSchema.safeParse({ id: 'intake', kind: 'ritual' }).success).toBe(false);
  });

  it('requires at least one stage per template', () => {
    expect(
      pipelineFileSchema.safeParse({ version: 1, templates: { feature: { stages: [] } } }).success,
    ).toBe(false);
  });

  it('only allows gates to wait on events from the catalogue', () => {
    expect(
      stageSchema.safeParse({ id: 'ci_gate', kind: 'gate', on: 'ci.pipeline.finished' }).success,
    ).toBe(true);
    expect(stageSchema.safeParse({ id: 'ci_gate', kind: 'gate', on: 'ci.done' }).success).toBe(
      false,
    );
  });

  it('constrains a custom stage to the two kinds a project may add', () => {
    expect(
      customStageSchema.safeParse({ id: 'x', kind: 'gate', after: 'ci_gate', command: 'true' })
        .success,
    ).toBe(true);
    expect(customStageSchema.safeParse({ id: 'x', kind: 'human', after: 'ci_gate' }).success).toBe(
      false,
    );
  });
});

describe('pipeline graph validation', () => {
  it('finds nothing wrong with the shipped feature template', () => {
    expect(pipelineGraphIssues(FEATURE_TEMPLATE)).toEqual([]);
  });

  it('reports a transition to a stage that does not exist', () => {
    const issues = pipelineGraphIssues({
      stages: [
        { id: 'intake', kind: 'system' },
        { id: 'ci_gate', kind: 'gate', pass_to: 'nowhere' },
      ],
    });
    expect(issues).toEqual([
      { code: 'unknown_target', stage: 'ci_gate', detail: expect.stringContaining('nowhere') },
    ]);
  });

  it('reports a duplicate stage id', () => {
    const issues = pipelineGraphIssues({
      stages: [
        { id: 'intake', kind: 'system' },
        { id: 'intake', kind: 'system' },
      ],
    });
    expect(issues.map((issue) => issue.code)).toEqual(['duplicate_stage_id']);
  });

  it('reports a requires that nothing upstream produces', () => {
    const issues = pipelineGraphIssues({
      stages: [
        {
          id: 'architecture',
          kind: 'agent',
          role: 'architect',
          requires: ['RefinedSpec'],
        },
      ],
    });
    expect(issues.map((issue) => issue.code)).toEqual(['missing_artifact']);
  });

  it('accepts a requires satisfied by an earlier stage but not by a later one', () => {
    const produceThenRequire: PipelineTemplate = {
      stages: [
        { id: 'refinement', kind: 'agent', role: 'product_manager', produces: 'RefinedSpec' },
        { id: 'architecture', kind: 'agent', role: 'architect', requires: ['RefinedSpec'] },
      ],
    };
    expect(pipelineGraphIssues(produceThenRequire)).toEqual([]);
    const reversed: PipelineTemplate = { stages: [...produceThenRequire.stages].reverse() };
    expect(pipelineGraphIssues(reversed).map((issue) => issue.code)).toEqual(['missing_artifact']);
  });

  it('follows a plain `next` transition as well as the verdict-driven ones', () => {
    expect(
      pipelineGraphIssues({
        stages: [
          { id: 'intake', kind: 'system' },
          { id: 'refinement', kind: 'agent', role: 'product_manager', next: 'intake' },
        ],
      }),
    ).toEqual([]);
    expect(
      pipelineGraphIssues({
        stages: [
          { id: 'refinement', kind: 'agent', role: 'product_manager', next: 'architecture' },
        ],
      }).map((issue) => issue.code),
    ).toEqual(['unknown_target']);
  });

  it('reports a custom stage hung off an unknown predecessor', () => {
    const issues = pipelineGraphIssues({
      stages: [{ id: 'intake', kind: 'system' }],
      custom: [{ id: 'scan', kind: 'gate', after: 'ci_gate', command: 'true' }],
    });
    expect(issues.map((issue) => issue.code)).toEqual(['unknown_predecessor']);
  });

  it(
    'never reports an issue whose stage is not part of the template',
    () => {
      const ids = new Set([
        ...FEATURE_TEMPLATE.stages.map((stage) => stage.id),
        ...(FEATURE_TEMPLATE.custom ?? []).map((stage) => stage.id),
      ]);
      fc.assert(
        fc.property(fc.subarray(FEATURE_TEMPLATE.stages, { minLength: 1 }), (stages) => {
          for (const issue of pipelineGraphIssues({ stages })) {
            expect(ids.has(issue.stage)).toBe(true);
          }
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});
