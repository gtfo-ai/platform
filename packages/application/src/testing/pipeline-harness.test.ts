/**
 * The harness's detector (WP-69, PROGRESS backlog 77): a script is held to what the real runner
 * could have returned, and a script that is not fails the **test** by name.
 *
 * Both directions (standing rule 42): the fixture WP-28 found — `drift.flag: 'none'`, invalid since
 * WP-15 — is refused with the zod issue in the message, and the same payload with the one field
 * corrected walks on. Calibrated on the one planted bad fixture that had a history, not on a
 * synthetic one.
 */

import path from 'node:path';
import type { DomainEvent } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import { askingRefinedSpec, PROCEEDING_REFINED_SPEC } from './artifact-fixtures.js';
import {
  cannotStart,
  createPipelineHarness,
  type ScriptedRun,
  ScriptedRunRefusedError,
  StaleCannotStartError,
  UnscriptedRunError,
} from './pipeline-harness.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b9';

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-0000000000a9',
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: {
        provider: 'fake-jira',
        key: 'ACME-1',
        url: 'https://jira.example.test/browse/ACME-1',
      },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

const walk = async (refinement: ScriptedRun) => {
  const harness = createPipelineHarness({ projectId: PROJECT, runs: { refinement } });
  await harness.publish([ticketMatched()]);
  return harness;
};

const completed = (structuredOutput: unknown): ScriptedRun => ({
  status: 'completed',
  terminalReason: 'success',
  structuredOutput,
});

describe('a scripted run is parsed against the stage’s artifact schema', () => {
  it('refuses the fixture that was invalid from WP-15 to WP-28, naming the field and the issue', async () => {
    const invalid = askingRefinedSpec(undefined, {
      drift: { flag: 'none', justification: 'in the documented direction' } as never,
    });
    const refused = walk(completed(invalid));
    await expect(refused).rejects.toBeInstanceOf(ScriptedRunRefusedError);
    await expect(refused).rejects.toThrow(
      /the script for "refinement" .*RefinedSpec.*drift\.flag: Invalid input: expected boolean, received string/,
    );
  });

  it('walks on with the same payload once the one field is what the schema says', async () => {
    const harness = await walk(completed(askingRefinedSpec()));
    expect(harness.store.snapshot()[0]?.task.state).toBe('waiting_answers');
  });

  it('refuses a completed run with no artifact for a stage that produces one', async () => {
    await expect(walk(completed(undefined))).rejects.toThrow(
      /completes a RefinedSpec run with no structured output/,
    );
  });

  it('refuses a run that did not complete and still carries an artifact', async () => {
    await expect(
      walk({
        status: 'failed',
        terminalReason: 'error_during_execution',
        structuredOutput: PROCEEDING_REFINED_SPEC,
      }),
    ).rejects.toThrow(/ends "failed" and still carries structured output/);
  });

  it('lets a test declare a deliberately invalid artifact, and refuses the declaration once it parses', async () => {
    // The declared case reaches the executor's own check behind the runner (it escalates).
    const declared = await walk({
      ...completed({ ...PROCEEDING_REFINED_SPEC, decision: 'ship it' }),
      deliberatelyInvalid: 'the executor’s own verdict check',
    });
    expect(declared.store.snapshot()[0]?.task.state).toBe('needs_human');
    // …and a declaration over a payload that has since become valid is stale, so it is refused.
    await expect(
      walk({ ...completed(askingRefinedSpec()), deliberatelyInvalid: 'no longer true' }),
    ).rejects.toThrow(/declared deliberately invalid .* so the declaration is stale/);
  });
});

/**
 * Every declared exemption from the parse, pinned (WP-69 review round 1): `deliberatelyInvalid`
 * opts a script out of the detector, and a declaration nobody counts is how a bad fixture would
 * hide. A new one fails here until it is added below — a reviewed decision, not a line. The census
 * reads a literal string value only; a value built elsewhere and spread in (ask-pipeline's
 * pass-through is one) is a spelling it cannot see, which is why the pass-through's own call site
 * is the one it counts.
 */
describe('the scripts declared deliberately invalid', () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
  const DECLARED: Readonly<Record<string, number>> = {
    'packages/application/src/ask/ask-pipeline.test.ts': 1,
    'packages/application/src/pipeline/stage-executor.test.ts': 2,
  };

  it('are exactly the declared list, in both directions', () => {
    const found: Record<string, number> = {};
    for (const file of censusPaths(REPO_ROOT, { pathspecs: ['*.ts', '*.tsx'] })) {
      if (file === 'packages/application/src/testing/pipeline-harness.test.ts') continue;
      const count = (censusText(REPO_ROOT, file).match(/deliberatelyInvalid:\s*['"`]/g) ?? [])
        .length;
      if (count > 0) found[file] = count;
    }
    expect(found).toEqual(DECLARED);
  });
});

/**
 * A run the walk reaches and nobody scripted (WP-96, PROGRESS backlog 249). Until WP-96 it was
 * escalated by the stage executor like any `start` that threw, so a case that forgot a stage
 * passed unless it asserted the task's ending — 71 cases in 7 files, measured. Both directions:
 * the omission is refused by name, and the declared form walks to the escalation it asks for.
 */
describe('a run with no script', () => {
  it('fails the test through drain, naming the key, instead of escalating the task', async () => {
    const harness = createPipelineHarness({ projectId: PROJECT, runs: {} });
    const refused = harness.publish([ticketMatched()]);
    await expect(refused).rejects.toBeInstanceOf(UnscriptedRunError);
    await expect(refused).rejects.toThrow(/scripted no run for "refinement"/);
  });

  it('escalates the task when the case declares the run cannot start, and the declaration is spent', async () => {
    const harness = createPipelineHarness({
      projectId: PROJECT,
      runs: { refinement: cannotStart('this case needs a task and no stage') },
    });
    await harness.publish([ticketMatched()]);
    expect(harness.store.snapshot()[0]?.task.state).toBe('needs_human');
    expect(harness.staleDeclarations()).toEqual([]);
  });

  it('refuses a declaration with no reason', () => {
    expect(() => cannotStart('  ')).toThrow(/needs the reason/);
  });

  it('lists a declaration no run reached as stale', () => {
    const harness = createPipelineHarness({
      projectId: PROJECT,
      runs: { refinement: cannotStart('the walk never gets here') },
    });
    expect(harness.staleDeclarations()).toEqual(['refinement']);
    // Spent here, so this case's own end-of-test check passes; the next case measures the check.
    harness.script('refinement', completed(askingRefinedSpec()));
  });

  it('refuses, when the test finishes, a declaration no run reached — by type and message', async () => {
    const checks: (() => void)[] = [];
    const harness = createPipelineHarness({
      projectId: PROJECT,
      runs: {
        refinement: cannotStart('the walk stops here'),
        architecture: cannotStart('the walk never gets here'),
      },
      declarationCheck: (check) => checks.push(check),
    });
    expect(checks).toHaveLength(1);
    await harness.publish([ticketMatched()]);
    const run = () => (checks[0] as () => void)();
    expect(run).toThrow(StaleCannotStartError);
    expect(run).toThrow(/declared cannotStart for "architecture" and no run reached it/);
    // …and once the stale key is scripted instead, it is no longer a declaration to refuse.
    harness.script('architecture', completed(askingRefinedSpec()));
    expect(run).not.toThrow();
  });

  it('passes the check when every declaration was reached', async () => {
    const checks: (() => void)[] = [];
    const harness = createPipelineHarness({
      projectId: PROJECT,
      runs: { refinement: cannotStart('the walk stops here') },
      declarationCheck: (check) => checks.push(check),
    });
    await harness.publish([ticketMatched()]);
    expect(() => (checks[0] as () => void)()).not.toThrow();
  });

  describe('outside a test', () => {
    let thrown: unknown;
    beforeAll(() => {
      try {
        createPipelineHarness({
          projectId: PROJECT,
          runs: { refinement: cannotStart('built in a beforeAll') },
        });
      } catch (error) {
        thrown = error;
      }
    });
    it('refuses a declaration at once, since no test could check its staleness', () => {
      expect(String(thrown)).toMatch(/needs a harness built inside a test/);
    });
  });
});

/**
 * Every `cannotStart` declaration, pinned (WP-96, backlog 249) — the same census as the
 * deliberately-invalid one above, for the same reason: a declaration is an exemption from the
 * refusal, so a new one is a reviewed decision rather than a line.
 */
describe('the runs declared unable to start', () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
  const DECLARED: Readonly<Record<string, number>> = {
    'packages/application/src/notify/digest.test.ts': 1,
    'packages/application/src/notify/notify.test.ts': 1,
    'packages/application/src/pipeline/delivery-measures.test.ts': 1,
    'packages/application/src/pipeline/dependency-gate.test.ts': 1,
    'packages/application/src/pipeline/epic-split.test.ts': 1,
    'packages/application/src/shadow/batch.test.ts': 6,
  };

  it('are exactly the declared list, in both directions', () => {
    const found: Record<string, number> = {};
    for (const file of censusPaths(REPO_ROOT, { pathspecs: ['*.ts', '*.tsx'] })) {
      if (file === 'packages/application/src/testing/pipeline-harness.test.ts') continue;
      if (file === 'packages/application/src/testing/pipeline-harness.ts') continue;
      const count = (censusText(REPO_ROOT, file).match(/\bcannotStart\(/g) ?? []).length;
      if (count > 0) found[file] = count;
    }
    expect(found).toEqual(DECLARED);
  });
});
