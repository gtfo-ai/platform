/**
 * The human words (TD-033 decision 6). The records are exhaustive by type; these tests hold the
 * runtime half: every **value** the contracts and the shipped templates can produce has its own
 * word — compared with the enums themselves, so a value added there fails here as well as in
 * `typecheck` — and an unknown stage slug is never printed raw.
 */
import {
  agentRoleSchema,
  approvalKindSchema,
  approvalStatusSchema,
  artifactTypeSchema,
  BUILTIN_GATE_STAGE_IDS,
  BUILTIN_STAGE_IDS,
  integrationSummarySchema,
  integrationTypeSchema,
  questionStatusSchema,
  runStatusSchema,
  runTerminalReasonSchema,
  taskStageStateSchema,
  taskStateSchema,
  WORKER_CLAIM_BLOCKERS,
  workerPauseReasonSchema,
} from '@platform/contracts';
import { ITERATION_LOOPS, READINESS_CRITERION_IDS, SHIPPED_STAGE_IDS } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_KIND_LABEL,
  APPROVAL_STATUS_LABEL,
  ARTIFACT_TYPE_LABEL,
  choiceLabel,
  claimBlockerLines,
  configFieldLabel,
  GATE_LABEL,
  INTEGRATION_HEALTH_LABEL,
  INTEGRATION_TYPE_LABEL,
  INTEGRATION_TYPE_PURPOSE,
  isUpdating,
  LOOP_LABEL,
  leadingClaimBlocker,
  loopLabel,
  ordinal,
  QUESTION_STATUS_LABEL,
  READINESS_CRITERION_LABEL,
  ROLE_LABEL,
  RUN_STATUS_LABEL,
  readinessCriterionLabel,
  runSubject,
  STAGE_LABEL,
  STAGE_STATE_LABEL,
  stageLabel,
  TASK_STATE_LABEL,
  TERMINAL_REASON_LABEL,
  titleCase,
  UPDATER_FIX,
  UPDATING_WORDS,
  WORKER_CLAIM_BLOCKER_WORDS,
  WORKER_PAUSE_REASON_LABEL,
} from './humanize.js';

const VOCABULARIES = [
  ['task state', taskStateSchema.options, TASK_STATE_LABEL],
  ['role', agentRoleSchema.options, ROLE_LABEL],
  ['run status', runStatusSchema.options, RUN_STATUS_LABEL],
  ['terminal reason', runTerminalReasonSchema.options, TERMINAL_REASON_LABEL],
  ['stage attempt state', taskStageStateSchema.options, STAGE_STATE_LABEL],
  ['artifact type', artifactTypeSchema.options, ARTIFACT_TYPE_LABEL],
  ['approval kind', approvalKindSchema.options, APPROVAL_KIND_LABEL],
  ['approval status', approvalStatusSchema.options, APPROVAL_STATUS_LABEL],
  ['question status', questionStatusSchema.options, QUESTION_STATUS_LABEL],
  ['gate', BUILTIN_GATE_STAGE_IDS, GATE_LABEL],
  ['integration type', integrationTypeSchema.options, INTEGRATION_TYPE_LABEL],
  ['integration purpose', integrationTypeSchema.options, INTEGRATION_TYPE_PURPOSE],
  [
    'integration health',
    integrationSummarySchema.shape.health.shape.status.options,
    INTEGRATION_HEALTH_LABEL,
  ],
  ['worker pause reason', workerPauseReasonSchema.options, WORKER_PAUSE_REASON_LABEL],
] as const;

describe('humanize', () => {
  it.each(VOCABULARIES)(
    'names every %s, and no value it does not have',
    (_name, values, labels) => {
      expect(Object.keys(labels).sort()).toEqual([...values].sort());
      for (const value of values) {
        const word = (labels as Readonly<Record<string, string>>)[value];
        expect(word).toMatch(/^[A-Z]/);
        // A word, not the identifier back: `needs_human` is not a label.
        expect(word).not.toMatch(/_/);
      }
      // Two values with one word would be two states a person cannot tell apart.
      expect(new Set(Object.values(labels)).size).toBe(values.length);
    },
  );

  it('words every claim blocker in a sentence and a fix, both sides alike (S-22.19)', () => {
    expect(Object.keys(WORKER_CLAIM_BLOCKER_WORDS)).toEqual([...WORKER_CLAIM_BLOCKERS]);
    for (const blocker of WORKER_CLAIM_BLOCKERS) {
      const { word, fix } = WORKER_CLAIM_BLOCKER_WORDS[blocker];
      expect(word, blocker).toMatch(/^[A-Z]/);
      expect(word, blocker).not.toMatch(/_/);
      expect(fix, blocker).toMatch(/^[A-Z].*\.$/);
      // The same words on the platform and on the machine: never "this worker" or "your".
      expect(`${word} ${fix}`, blocker).not.toMatch(/\b(this worker|your)\b/i);
    }
    const words = Object.values(WORKER_CLAIM_BLOCKER_WORDS).map((entry) => entry.word);
    expect(new Set(words).size).toBe(WORKER_CLAIM_BLOCKERS.length);
  });

  it('tells an outdated worker’s owner that its updater does it, never to reinstall (S-23.27)', () => {
    expect(UPDATER_FIX).toBe(
      'Its updater is bringing it up to date. Nothing to do; this usually takes a minute or two.',
    );
    expect(WORKER_CLAIM_BLOCKER_WORDS.images_outdated.fix).toBe(UPDATER_FIX);
    expect(WORKER_CLAIM_BLOCKER_WORDS.protocol_outdated.fix).toBe(
      `It speaks an older version than this platform accepts. ${UPDATER_FIX}`,
    );
    for (const blocker of ['images_outdated', 'protocol_outdated'] as const) {
      const { fix } = WORKER_CLAIM_BLOCKER_WORDS[blocker];
      expect(fix, blocker).not.toMatch(/compose|docker|within 5 minutes|download/i);
    }
  });

  it('reads a draining outdated worker as updating, and anything else as it is (S-23.27)', () => {
    expect(isUpdating(['draining', 'images_outdated'])).toBe(true);
    expect(isUpdating(['protocol_outdated', 'draining'])).toBe(true);
    expect(isUpdating(['draining'])).toBe(false);
    expect(isUpdating(['images_outdated'])).toBe(false);
    expect(isUpdating(['paused', 'images_outdated'])).toBe(false);

    const lines = claimBlockerLines(['draining', 'images_outdated', 'no_eligible_project']);
    expect(lines.map((line) => [line.blocker, line.word, line.updating])).toEqual([
      ['draining', 'Updating now…', true],
      ['images_outdated', WORKER_CLAIM_BLOCKER_WORDS.images_outdated.word, true],
      ['no_eligible_project', WORKER_CLAIM_BLOCKER_WORDS.no_eligible_project.word, false],
    ]);
    // The drain's own fix (resume, restart) would undo the update: it is not offered.
    expect(lines[0]?.fix).not.toBe(WORKER_CLAIM_BLOCKER_WORDS.draining.fix);
    expect(lines[1]?.fix).toBe(UPDATER_FIX);
    // A drain alone is a drain, with its own words.
    expect(claimBlockerLines(['draining'])[0]).toEqual({
      blocker: 'draining',
      ...WORKER_CLAIM_BLOCKER_WORDS.draining,
      updating: false,
    });

    expect(leadingClaimBlocker(['protocol_outdated', 'draining'])).toEqual({
      blocker: 'protocol_outdated',
      ...UPDATING_WORDS,
      updating: true,
    });
    // Something more fundamental still comes first.
    expect(leadingClaimBlocker(['offline', 'draining', 'images_outdated'])).toEqual({
      blocker: 'offline',
      ...WORKER_CLAIM_BLOCKER_WORDS.offline,
      updating: false,
    });
    expect(leadingClaimBlocker([])).toBeUndefined();
  });

  it('names every stage the shipped templates declare, not only the ticket flow’s', () => {
    for (const id of [...BUILTIN_STAGE_IDS, ...SHIPPED_STAGE_IDS]) {
      expect(Object.hasOwn(STAGE_LABEL, id), id).toBe(true);
    }
    expect(new Set(Object.values(STAGE_LABEL)).size).toBe(Object.keys(STAGE_LABEL).length);
  });

  it('uses the words the research names for the states it names', () => {
    expect(TASK_STATE_LABEL.waiting_approval).toBe('Waiting for approval');
    expect(stageLabel('ci_gate')).toBe('CI');
    expect(stageLabel('code_review')).toBe('Code review');
    expect(stageLabel('rebase_gate')).toBe('Rebase check');
    expect(RUN_STATUS_LABEL.timed_out).toBe('Timed out');
  });

  it('title-cases a project’s own stage rather than printing the slug', () => {
    expect(stageLabel('security_scan')).toBe('Security Scan');
    expect(stageLabel('load-test_2')).toBe('Load Test 2');
    expect(titleCase('__')).toBe('');
    // An inherited property name is a slug like any other, not a lookup hit.
    expect(stageLabel('constructor')).toBe('Constructor');
    expect(stageLabel('__proto__')).toBe('Proto');
  });

  it('says which stage and role a run belongs to, or the role alone for an ask', () => {
    expect(runSubject({ stage: 'implementation', role: 'developer' })).toBe(
      'Implementation · Developer',
    );
    expect(runSubject({ stage: null, role: 'ask' })).toBe('Ask');
  });

  it('names every readiness criterion the domain declares, and shows an unknown id as itself', () => {
    expect(Object.keys(READINESS_CRITERION_LABEL)).toEqual([...READINESS_CRITERION_IDS]);
    for (const id of READINESS_CRITERION_IDS) {
      const word = readinessCriterionLabel(id);
      expect(word, id).toMatch(/^[A-Z]/);
      // A name, not the id back.
      expect(word, id).not.toBe(id);
    }
    expect(new Set(Object.values(READINESS_CRITERION_LABEL)).size).toBe(
      READINESS_CRITERION_IDS.length,
    );
    expect(readinessCriterionLabel('R99')).toBe('R99');
    expect(readinessCriterionLabel('constructor')).toBe('constructor');
  });

  it('labels a provider field in words, initialisms and units included', () => {
    expect(configFieldLabel('site_url')).toBe('Site URL');
    expect(configFieldLabel('api_token')).toBe('API token');
    expect(configFieldLabel('team_id')).toBe('Team ID');
    expect(configFieldLabel('run_ssh_public_key')).toBe('Run SSH public key');
    expect(configFieldLabel('request_timeout_ms')).toBe('Request timeout (ms)');
    expect(configFieldLabel('poll_interval_seconds')).toBe('Poll interval (seconds)');
    expect(configFieldLabel('max_line_bytes')).toBe('Max line (bytes)');
    expect(configFieldLabel('poll_enabled')).toBe('Poll for changes');
    // A lone unit word is the field's name, not a unit of nothing.
    expect(configFieldLabel('seconds')).toBe('Seconds');
    expect(configFieldLabel('__')).toBe('__');
    expect(choiceLabel('deploy_key')).toBe('Deploy key');
    expect(choiceLabel(30)).toBe('30');
  });
});

describe('the loop words and ordinals (S-23.5)', () => {
  it('names every loop the domain ships, and nothing else', () => {
    expect(Object.keys(LOOP_LABEL).sort()).toEqual([...ITERATION_LOOPS].sort());
    expect(loopLabel('code_review')).toBe('Review');
    // A loop this build does not ship is title-cased rather than printed raw.
    expect(loopLabel('custom_loop')).toBe('Custom Loop');
    // An inherited property name is a slug like any other, not a lookup hit.
    expect(loopLabel('constructor')).toBe('Constructor');
  });

  it('spells ordinals, the teens included', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '101st',
      '111th',
    ]);
  });
});
