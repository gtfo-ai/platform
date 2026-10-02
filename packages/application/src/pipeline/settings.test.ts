/**
 * `ProjectSettings` — the port's own small decisions, which had no test of their own.
 *
 * Two of them matter beyond this file. `templateForIssueType` decides which pipeline a ticket walks
 * (product/04 S0) and falls to the **fullest** template rather than the cheapest, which is the safe
 * direction; and `autonomyPresetFor` is what turns WP-30's stored document into the policies the
 * plan-approval gate reads, including the one override a project's configuration can express.
 */
import type { IsoDateTime } from '@platform/contracts';
import {
  AUTONOMY_PRESETS,
  EPIC_SPLIT_TEMPLATE_ID,
  materialiseAutonomy,
  SHIPPED_TEMPLATES,
  SPIKE_TEMPLATE_ID,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { TransactionOpenError, withOpenTransaction } from '../events/open-transaction.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import {
  autonomyPresetFor,
  DEFAULT_TEMPLATE_BY_ISSUE_TYPE,
  DEFAULT_TEMPLATE_ID,
  defaultProjectSettings,
  epicSplitRouting,
  MAX_STORED_VALUE_CHARS,
  ProjectSettingsInvalidError,
  projectSettingsFrom,
  projectSettingsLayerFrom,
  resolveEpicSplitSettings,
  spikeRefusal,
  spikeTemplateEnabled,
  staticProjectSettings,
  templateForIssueType,
} from './settings.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as never;
const AT = '2026-09-14T10:00:00.000Z' as IsoDateTime;

describe('autonomyPresetFor', () => {
  it('is null for a project whose dial was never materialised', () => {
    // Not "the default preset" — standing rule 16, and the whole reason `planApprovalGate` names
    // its fallback rather than substituting one here.
    expect(autonomyPresetFor(defaultProjectSettings(PROJECT))).toBeNull();
  });

  it('is the stored preset for one whose dial was', () => {
    const settings = defaultProjectSettings(PROJECT, {
      autonomy: materialiseAutonomy({ level: 'autonomous', at: AT, appliedBy: null }),
    });
    expect(autonomyPresetFor(settings)).toEqual(AUTONOMY_PRESETS.autonomous);
  });

  it('applies the project’s own configuration override on top of it', () => {
    const settings = defaultProjectSettings(PROJECT, {
      autonomy: materialiseAutonomy({ level: 'supervised', at: AT, appliedBy: null }),
      config: { policies: { probation_tasks: 1 } },
    });
    expect(autonomyPresetFor(settings)?.probationTasks).toBe(1);
    // …and a document with no override changes nothing (standing rule 42).
    expect(
      autonomyPresetFor(
        defaultProjectSettings(PROJECT, {
          autonomy: materialiseAutonomy({ level: 'supervised', at: AT, appliedBy: null }),
          config: { policies: {} },
        }),
      ),
    ).toEqual(AUTONOMY_PRESETS.supervised);
  });
});

describe('templateForIssueType', () => {
  const settings = defaultProjectSettings(PROJECT);

  it('maps the provider’s own type names, case- and whitespace-insensitively', () => {
    expect(templateForIssueType(settings, 'Story')).toBe('feature');
    expect(templateForIssueType(settings, '  bug ')).toBe('bug');
    expect(templateForIssueType(settings, 'Sub-Task')).toBe('chore');
  });

  it('falls to the fullest template for a type nobody mapped, and for none at all', () => {
    // The safe direction: a chore on the feature template only costs a plan, while a feature on the
    // chore template skips architecture and business review.
    expect(templateForIssueType(settings, 'Escalation')).toBe(DEFAULT_TEMPLATE_ID);
    expect(templateForIssueType(settings, null)).toBe(DEFAULT_TEMPLATE_ID);
  });

  it('falls back when a project maps a type onto a template it does not have', () => {
    const broken = defaultProjectSettings(PROJECT, {
      templateByIssueType: { story: 'a-template-nobody-defined' },
    });
    expect(templateForIssueType(broken, 'Story')).toBe(DEFAULT_TEMPLATE_ID);
  });

  /**
   * product/04 S0 classifies into four templates and this map could produce only three until WP-40:
   * a ticket a team had literally typed *Spike* ran the **feature** pipeline and opened a merge
   * request for a research question. Since review round 2 the map entry alone does not route it —
   * a spike ends at a human with **no merge request**, so turning it on for an existing project is
   * a behaviour change, and product/18:39's Default column for this row says *"off"*.
   */
  it('leaves a Spike ticket on the default pipeline until the project turns the template on', () => {
    expect(templateForIssueType(settings, 'Spike')).toBe(DEFAULT_TEMPLATE_ID);
    expect(templateForIssueType(settings, ' spike ')).toBe(DEFAULT_TEMPLATE_ID);
    // The map still says what it says: the switch is the gate, not a deleted entry (criterion 2's
    // reasoning — the map is the project's to override).
    expect(DEFAULT_TEMPLATE_BY_ISSUE_TYPE.spike).toBe(SPIKE_TEMPLATE_ID);
    expect(spikeTemplateEnabled(settings)).toBe(false);
  });

  it('routes a Spike ticket to the spike template once it is on, and says so when it is not', () => {
    const on = defaultProjectSettings(PROJECT, {
      config: { features: { spike: { enabled: true } } },
    });
    expect(templateForIssueType(on, 'Spike')).toBe(SPIKE_TEMPLATE_ID);
    expect(templateForIssueType(on, ' spike ')).toBe(SPIKE_TEMPLATE_ID);
    expect(spikeRefusal(on, 'Spike')).toBeNull();
    // Off, the operator gets a reason rather than silence (standing rule 18) — and only for a
    // ticket the map would have routed, so an ordinary story produces no line at all.
    expect(spikeRefusal(settings, 'Spike')).toContain('features.spike.enabled');
    expect(spikeRefusal(settings, 'Story')).toBeNull();
    expect(spikeRefusal(settings, null)).toBeNull();
  });

  /**
   * The gate is on the **answer**, not on the shipped map entry: a project that maps its own type
   * onto the spike template meets the same switch, so `features.spike.enabled` is the whole state
   * of the feature and nobody has to read two places to know whether it is on.
   */
  it('gates a project’s own mapping onto the spike template too', () => {
    const mapped = { templateByIssueType: { research: SPIKE_TEMPLATE_ID } };
    expect(templateForIssueType(defaultProjectSettings(PROJECT, mapped), 'Research')).toBe(
      DEFAULT_TEMPLATE_ID,
    );
    expect(
      templateForIssueType(
        defaultProjectSettings(PROJECT, {
          ...mapped,
          config: { features: { spike: { enabled: true } } },
        }),
        'Research',
      ),
    ).toBe(SPIKE_TEMPLATE_ID);
  });

  /**
   * The two switches are **independent**, asserted from both sides: the variant routes to its own
   * template with the plain spike off (which is how every other test in this file is configured),
   * and turning the plain spike on does not turn the variant on.
   */
  it('does not tie the epic-split variant to the spike template’s switch', () => {
    const splitOnly = defaultProjectSettings(PROJECT, {
      config: { features: { epic_split: { enabled: true } } },
    });
    expect(templateForIssueType(splitOnly, 'Epic', { canCreateTickets: true })).toBe(
      EPIC_SPLIT_TEMPLATE_ID,
    );
    const spikeOnly = defaultProjectSettings(PROJECT, {
      config: { features: { spike: { enabled: true } } },
    });
    expect(templateForIssueType(spikeOnly, 'Epic', { canCreateTickets: true })).toBe('feature');
  });
});

/**
 * The epic-split variant's routing — product/18:45's *"off (spike template option)"* (WP-40).
 *
 * Both directions of the default (standing rule 42) and each refusal by name, because the only way
 * an operator learns why their epic went down the feature pipeline is the reason this function
 * returns (standing rule 18).
 */
describe('epicSplitRouting', () => {
  const enabled = (extra: Record<string, unknown> = {}) =>
    defaultProjectSettings(PROJECT, {
      config: { features: { epic_split: { enabled: true, ...extra } } },
    });
  const canCreate = { canCreateTickets: true } as const;

  it('is off by default: an epic runs the feature pipeline exactly as it does today', () => {
    const off = defaultProjectSettings(PROJECT);
    expect(epicSplitRouting(off, 'Epic', canCreate)).toEqual({ kind: 'not_claimed' });
    expect(templateForIssueType(off, 'Epic', canCreate)).toBe('feature');
    // …and the shipped map is what says so, untouched by this row (criterion 2).
    expect(DEFAULT_TEMPLATE_BY_ISSUE_TYPE.epic).toBe('feature');
  });

  it('routes an epic to the variant when the project turns it on', () => {
    expect(epicSplitRouting(enabled(), 'Epic', canCreate)).toEqual({ kind: 'routed' });
    expect(templateForIssueType(enabled(), 'epic', canCreate)).toBe(EPIC_SPLIT_TEMPLATE_ID);
  });

  it('claims only the types the project named, and an explicitly empty list claims nothing', () => {
    const initiatives = enabled({ issue_types: ['Initiative'] });
    expect(templateForIssueType(initiatives, 'Initiative', canCreate)).toBe(EPIC_SPLIT_TEMPLATE_ID);
    expect(templateForIssueType(initiatives, 'Epic', canCreate)).toBe('feature');
    expect(templateForIssueType(enabled({ issue_types: [] }), 'Epic', canCreate)).toBe('feature');
  });

  it('refuses by name when the binding cannot create tickets', () => {
    // Criterion 6: a breakdown nobody can accept is worse than a feature ticket, because a human
    // has spent a decision on it by the time the `createTicket` call throws.
    const refusal = epicSplitRouting(enabled(), 'Epic', { canCreateTickets: false });
    expect(refusal.kind).toBe('refused');
    expect(refusal.kind === 'refused' && refusal.reason).toContain('cannot create tickets');
    expect(templateForIssueType(enabled(), 'Epic', { canCreateTickets: false })).toBe('feature');
    // …and a caller that says nothing at all gets the same refusal: the conservative default.
    expect(templateForIssueType(enabled(), 'Epic')).toBe('feature');
  });

  it('refuses by name for a shadow task', () => {
    const refusal = epicSplitRouting(enabled(), 'Epic', { ...canCreate, shadow: true });
    expect(refusal.kind).toBe('refused');
    expect(refusal.kind === 'refused' && refusal.reason).toContain('shadow');
    expect(templateForIssueType(enabled(), 'Epic', { ...canCreate, shadow: true })).toBe('feature');
  });

  it('refuses by name when the project has no epic_split template', () => {
    const without = defaultProjectSettings(PROJECT, {
      config: { features: { epic_split: { enabled: true } } },
      templates: { feature: SHIPPED_TEMPLATES.feature as never },
    });
    const refusal = epicSplitRouting(without, 'Epic', canCreate);
    expect(refusal.kind).toBe('refused');
    expect(refusal.kind === 'refused' && refusal.reason).toContain('no epic_split template');
  });

  it('resolves the three keys, defaults and overrides both (standing rule 42)', () => {
    expect(resolveEpicSplitSettings(defaultProjectSettings(PROJECT))).toEqual({
      enabled: false,
      issueTypes: ['Epic'],
      childIssueType: 'Task',
    });
    expect(resolveEpicSplitSettings(enabled({ child_issue_type: 'Story' }))).toEqual({
      enabled: true,
      issueTypes: ['Epic'],
      childIssueType: 'Story',
    });
  });
});

describe('the port’s two constructors', () => {
  it('answers whatever the composition root computed', async () => {
    const settings = defaultProjectSettings(PROJECT, { taskBudgetUsd: 7 });
    expect(await staticProjectSettings(() => settings).forProject(PROJECT)).toBe(settings);
  });

  it('narrows an EffectiveConfig onto the fields the pipeline reads', () => {
    const built = projectSettingsFrom(
      PROJECT,
      { values: { version: 1 }, sources: {}, hash: 'h' } as never,
      { workspaceRoot: '/tmp/ws' },
    );
    expect(built.config).toEqual({ version: 1 });
    expect(built.workspaceRoot).toBe('/tmp/ws');
    expect(built.autonomy).toBeNull();
  });
});

/**
 * WP-73, PROGRESS backlogs 19 and 221: the settings port's recurrence guard, held by the double
 * every harness uses as well as by the production adapter (`apps/server/src/pipeline.test.ts`), so
 * a handler that asks without its transaction fails the unit tier rather than borrowing a second
 * pooled connection in production.
 */
describe('the settings port refuses a read without the caller’s transaction inside one', () => {
  const port = staticProjectSettings((projectId) => defaultProjectSettings(projectId));
  const project = '00000000-0000-4000-8000-0000000000a1' as never;

  it('refuses inside a transaction when no transaction is handed in', async () => {
    await expect(withOpenTransaction(async () => port.forProject(project))).rejects.toThrow(
      TransactionOpenError,
    );
  });

  it('answers inside a transaction that is handed in, and outside any', async () => {
    const inside = await withOpenTransaction(async () =>
      port.forProject(project, { adapter: 'memory' }),
    );
    expect(inside.projectId).toBe(project);
    expect((await port.forProject(project)).projectId).toBe(project);
  });
});

/**
 * **A key this release does not know is named in the refusal** (WP-125, PROGRESS backlog 355).
 *
 * A strict object's `unrecognized_keys` issue carries the **parent's** path, so rendering the value
 * at that path quoted the whole parent and dropped zod's message, the part that names the key — at
 * the root as `: {…}` with no path at all. Each document below puts a long, valid sibling **before**
 * the unknown key, so the old rendering is cut at {@link MAX_STORED_VALUE_CHARS} before the key it
 * refuses: the cases fail on it by name (the canary, recorded in PROGRESS under WP-125).
 */
describe('a stored document with a key this release does not know (WP-125, backlog 355)', () => {
  const LONG_DIR = `${'docs/'.repeat(40)}kb`;
  const identity = (value: string): string => value;

  const clausesOf = (stored: unknown, redactText: (value: string) => string = identity) => {
    try {
      projectSettingsLayerFrom(PROJECT, stored, redactText);
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectSettingsInvalidError);
      return (error as ProjectSettingsInvalidError).clauses;
    }
    throw new Error('expected the stored document to be refused');
  };

  it('names an unknown key at the root, with (root) rather than an empty path', () => {
    const clauses = clausesOf({
      version: 1,
      project: { knowledge_dir: LONG_DIR },
      bogus_root_key: true,
    });
    expect(clauses).toEqual(['(root) (Unrecognized key: "bogus_root_key")']);
  });

  it('names an unknown key inside an object, under the object’s path', () => {
    const clauses = clausesOf({
      version: 1,
      project: { knowledge_dir: LONG_DIR, bogus_nested_key: 1 },
    });
    expect(clauses).toEqual(['project (Unrecognized key: "bogus_nested_key")']);
  });

  it('still renders a refused value by its value (the other side)', () => {
    expect(clausesOf({ version: 1, project: { knowledge_dir: 7 } })[0]).toBe(
      'project.knowledge_dir: 7',
    );
  });

  it('redacts the key before it bounds the clause, so a credential across the bound is not half-published', () => {
    // An obviously fake credential, written as the unknown key's name, and padded so that it
    // straddles the bound: cutting first would publish its prefix, which no rule can then match.
    const planted = 'FAKE-wp125-credential-not-real-0001';
    const redactor = exactSecretRedactor([{ name: 'pasted_key', value: planted }]);
    const prefix = '(root) (Unrecognized key: "';
    const pad = 'k'.repeat(MAX_STORED_VALUE_CHARS - prefix.length - 10);
    const [clause] = clausesOf(
      { version: 1, [`${pad}${planted}`]: true },
      (value) => redactor.redactText(value).value,
    );
    expect(clause?.startsWith(prefix)).toBe(true);
    expect(clause).not.toContain('FAKE-wp125');
    expect(clause).toContain('[REDACTED');
    expect(clause?.length).toBeLessThanOrEqual(MAX_STORED_VALUE_CHARS);
  });
});
