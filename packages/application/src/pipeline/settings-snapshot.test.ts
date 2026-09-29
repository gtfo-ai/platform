/**
 * The settings snapshot a run row carries (WP-91, PROGRESS backlog 227): what is in it, what the
 * hash is over, and the redaction and bound it goes through. The two `runs.insert` call sites are
 * asserted where the runs are made — `saga.test.ts` (a stage) and `ask-pipeline.test.ts` (an ask).
 */
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { defaultProjectSettings, type ProjectSettings } from './settings.js';
import {
  canonicalJson,
  MAX_SETTINGS_SNAPSHOT_BYTES,
  runSettingsSnapshot,
  SETTINGS_SNAPSHOT_FORMAT,
} from './settings-snapshot.js';

const PROJECT = '00000000-0000-4000-8000-0000000000d1' as never;
const nothing = exactSecretRedactor([]);

const settingsWith = (overrides: Partial<Omit<ProjectSettings, 'projectId'>>): ProjectSettings =>
  defaultProjectSettings(PROJECT, overrides);

type Snapshot = {
  format: number;
  effective: {
    version: number;
    project: Record<string, unknown>;
    pipeline: { limits: Record<string, unknown>; wip: Record<string, unknown> };
    commands: { allow: string[]; ask: string[]; block: string[] };
    policies: { review_checklists?: Record<string, string[]> };
  };
  autonomy: unknown;
  task_budget_usd: number;
  templates: string[];
  repository: unknown;
};

describe('canonicalJson — the serialisation the hash is over', () => {
  it('sorts keys at every depth, drops undefined members and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: undefined, e: null } })).toBe(
      '{"a":{"d":[3,1],"e":null},"b":1}',
    );
  });
});

describe('runSettingsSnapshot', () => {
  it('is the effective document: platform defaults under the settings, and the WIP limits admission uses', () => {
    const { snapshot } = runSettingsSnapshot(
      settingsWith({
        config: { project: { communication_language: 'cs' } },
        wip: { maxParallelTasks: 1, maxTasksInPipeline: 5, maxParallelRuns: 4 },
      }),
      nothing,
    );
    const document = snapshot as unknown as Snapshot;
    expect(document.format).toBe(SETTINGS_SNAPSHOT_FORMAT);
    expect(document.effective.project.communication_language).toBe('cs');
    // A default the settings never stated, which the planner applies at the point of use.
    expect(document.effective.pipeline.limits.human_rounds).toBe(3);
    expect(document.effective.pipeline.wip).toEqual({
      max_parallel_tasks: 1,
      max_tasks_in_pipeline: 5,
    });
    expect(document.autonomy).toBeNull();
    expect(document.templates).toContain('feature');
    expect(document.repository).toBeNull();
  });

  it('narrows the commands layer by layer, as the run policy is', () => {
    const { snapshot } = runSettingsSnapshot(
      settingsWith({
        config: { commands: { block: ['rm -rf *'] } },
        repositoryCommands: { block: ['curl *'] },
      }),
      nothing,
    );
    const block = (snapshot as unknown as Snapshot).effective.commands.block;
    expect(block).toContain('rm -rf *');
    expect(block).toContain('curl *');
  });

  it('gives two runs with one configuration one hash, whatever the key order', () => {
    const first = runSettingsSnapshot(
      settingsWith({ config: { project: { commit_convention: 'none', knowledge_dir: 'kb' } } }),
      nothing,
    );
    const second = runSettingsSnapshot(
      settingsWith({ config: { project: { knowledge_dir: 'kb', commit_convention: 'none' } } }),
      nothing,
    );
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.hash).toBe(first.hash);
  });

  it('gives a changed configuration a different hash — criterion 1, both directions', () => {
    const before = runSettingsSnapshot(settingsWith({ config: {} }), nothing);
    const after = runSettingsSnapshot(
      settingsWith({ config: { pipeline: { limits: { ci_fix_iterations: 5 } } } }),
      nothing,
    );
    expect(after.hash).not.toBe(before.hash);
    // A reading of the repository changes it too: which commit the file came from is part of it.
    const read = runSettingsSnapshot(
      settingsWith({ repository: { status: 'valid', commitSha: 'a'.repeat(40), detail: null } }),
      nothing,
    );
    expect(read.hash).not.toBe(before.hash);
  });

  it('records the organisation’s autonomy maximum beside the capped dial, and nothing when there is none (WP-93)', () => {
    const none = runSettingsSnapshot(settingsWith({}), nothing);
    expect(Object.hasOwn(none.snapshot, 'autonomy_maximum')).toBe(false);
    const capped = runSettingsSnapshot(
      settingsWith({ organisationAutonomyMaximum: 'assist' }),
      nothing,
    );
    expect(capped.snapshot).toMatchObject({ autonomy_maximum: 'assist' });
    expect(capped.hash).not.toBe(none.hash);
  });

  it('redacts a credential an operator pasted into free text, and hashes what it stores', () => {
    const secret = 'glpat-FAKEFAKEFAKEFAKE0001';
    const { snapshot, hash } = runSettingsSnapshot(
      settingsWith({
        config: { policies: { review_checklists: { payments: [`token ${secret}`] } } },
      }),
      exactSecretRedactor([{ name: 'gitlab_token', value: secret }]),
    );
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED');
    expect(hash).toBe(
      runSettingsSnapshot(
        settingsWith({
          config: { policies: { review_checklists: { payments: [`token ${secret}`] } } },
        }),
        exactSecretRedactor([{ name: 'gitlab_token', value: secret }]),
      ).hash,
    );
  });

  it('stores a stated marker rather than a cut document past the bound, and keeps the full hash', () => {
    const big = 'x'.repeat(490);
    const items = Array.from({ length: 30 }, (_, index) => `${index} ${big}`);
    const lists = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`list_${index}`, items]),
    );
    const { snapshot, hash } = runSettingsSnapshot(
      settingsWith({ config: { policies: { review_checklists: lists } } }),
      nothing,
    );
    expect(snapshot).toMatchObject({ format: SETTINGS_SNAPSHOT_FORMAT, truncated: true });
    expect((snapshot as { bytes: number }).bytes).toBeGreaterThan(MAX_SETTINGS_SNAPSHOT_BYTES);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
