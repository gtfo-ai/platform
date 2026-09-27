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
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import { askingRefinedSpec, PROCEEDING_REFINED_SPEC } from './artifact-fixtures.js';
import {
  createPipelineHarness,
  type ScriptedRun,
  ScriptedRunRefusedError,
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
