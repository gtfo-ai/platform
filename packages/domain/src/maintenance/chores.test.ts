/**
 * The chore catalogue, the key grammar and the brief (WP-36).
 *
 * Three properties rather than a restatement of the table: **every** chore type has an answer (so a
 * sixth one cannot fall through to "performed"), the refusals name their reason, and the brief
 * carries the evidence the platform established plus a count of what it dropped.
 */
import { describe, expect, it } from 'vitest';
import type { ConfigValues } from '../config/effective-config.js';
import { PLATFORM_DEFAULT_CONFIG } from '../config/effective-config.js';
import {
  choreRefusalOf,
  choreTicketKey,
  choreTypeOfTicketKey,
  MAINTENANCE_CHORE_TYPES,
  MAINTENANCE_CHORES,
  MAX_CHORE_FINDING_CHARS,
  MAX_CHORE_FINDINGS,
  maintenanceBudgetUsdOf,
  maintenanceConfigOf,
  namesAMaintenanceChore,
  PERFORMABLE_CHORE_TYPES,
  renderChoreBrief,
} from './chores.js';

const configWith = (maintenance: Record<string, unknown> | undefined): ConfigValues =>
  ({ features: maintenance === undefined ? {} : { maintenance } }) as unknown as ConfigValues;

describe('the chore catalogue', () => {
  it('answers for every chore type the configuration schema admits', () => {
    // Parameterised over the same set the branch is over (standing rule 68): a value added to
    // `MAINTENANCE_CHORE_TYPES` with no entry fails the typecheck, and this is the runtime half.
    for (const type of MAINTENANCE_CHORE_TYPES) {
      const entry = MAINTENANCE_CHORES[type];
      expect(entry.does.length, type).toBeGreaterThan(0);
      expect(entry.detail.length, type).toBeGreaterThan(0);
    }
    expect(Object.keys(MAINTENANCE_CHORES).sort()).toEqual([...MAINTENANCE_CHORE_TYPES].sort());
  });

  it('performs two and refuses three by name, each with its reason', () => {
    expect([...PERFORMABLE_CHORE_TYPES]).toEqual(['deps', 'kb']);
    expect(choreRefusalOf('deps')).toBeNull();
    expect(choreRefusalOf('kb')).toBeNull();
    expect(choreRefusalOf('flaky')?.reason).toBe('no_flaky_detection');
    expect(choreRefusalOf('docs')?.reason).toBe('no_drift_detector');
    expect(choreRefusalOf('lint')?.reason).toBe('no_project_command');
    // The sentence a human reads names *why*, not just *that* — rule 18's whole point.
    expect(choreRefusalOf('lint')?.detail).toContain('project command');
    expect(choreRefusalOf('flaky')?.detail).toContain('flaky');
    expect(choreRefusalOf('docs')?.detail).toContain('drift');
  });
});

describe('the platform-issued reference', () => {
  it('carries the type and the period, and is recognised as a maintenance chore', () => {
    const key = choreTicketKey('kb', '2026-W38');
    expect(key).toBe('chore!kb-2026-W38');
    expect(namesAMaintenanceChore({ provider: 'platform', key })).toBe(true);
    expect(choreTypeOfTicketKey(key)).toBe('kb');
  });

  it('does not recognise a ticket a provider issued, or another platform-issued key', () => {
    // Both directions (standing rule 42): the budget predicate is this function, so a `true` here
    // for a human's chore ticket would charge their delivery to the maintenance cap.
    expect(namesAMaintenanceChore({ provider: 'jira', key: 'ACME-1' })).toBe(false);
    expect(namesAMaintenanceChore({ provider: 'jira', key: 'chore!kb-2026-W38' })).toBe(false);
    expect(namesAMaintenanceChore({ provider: 'platform', key: 'mr!7' })).toBe(false);
    expect(namesAMaintenanceChore({ provider: 'platform', key: 'lint!ACME-1' })).toBe(false);
    expect(choreTypeOfTicketKey('mr!7')).toBeNull();
    expect(choreTypeOfTicketKey('chore!nonsense-2026-09')).toBeNull();
  });
});

describe('reading features.maintenance', () => {
  it('reads the four keys, and takes the shipped default for a project that named none', () => {
    const config = maintenanceConfigOf(
      configWith({ enabled: true, schedule: 'daily', budget_usd: 12, chores: ['kb'] }),
    );
    expect(config).toMatchObject({ enabled: true, schedule: 'daily', budgetUsd: 12 });
    expect([...config.chores]).toEqual(['kb']);
    expect(config.choresDefaulted).toBe(false);
    expect(maintenanceBudgetUsdOf(configWith({ budget_usd: 12 }))).toBe(12);
  });

  it('treats an absent list as the types this build performs and an empty one as none', () => {
    // The asymmetry is the decision: absent is "choose for me", `[]` is "no chore type" — the
    // fail-closed reading of *"the types I named"* (standing rule 20's direction for a write).
    expect([...maintenanceConfigOf(configWith({ enabled: true })).chores]).toEqual([
      ...PERFORMABLE_CHORE_TYPES,
    ]);
    expect(maintenanceConfigOf(configWith({ enabled: true, chores: [] })).chores).toEqual([]);
  });

  it('falls back rather than throwing on a value that somehow failed the schema', () => {
    const config = maintenanceConfigOf(
      configWith({
        enabled: true,
        schedule: 'fortnightly',
        budget_usd: -3,
        chores: ['kb', 'nope'],
      }),
    );
    expect(config.schedule).toBe('weekly');
    expect(config.budgetUsd).toBeNull();
    expect([...config.chores]).toEqual(['kb']);
  });

  it('is off, weekly, and names the document’s three chore types in the shipped defaults', () => {
    // The figure a reader would otherwise take from the prose: `PLATFORM_DEFAULT_CONFIG` carries
    // technical/12's example, two of whose three types this build refuses by name — which is what
    // the scheduler's refusal path exists for and why it is reached on a stock project.
    const config = maintenanceConfigOf(PLATFORM_DEFAULT_CONFIG);
    expect(config.enabled).toBe(false);
    expect(config.schedule).toBe('weekly');
    expect([...config.chores]).toEqual(['deps', 'flaky', 'docs']);
    expect(config.chores.filter((type) => choreRefusalOf(type) !== null)).toEqual([
      'flaky',
      'docs',
    ]);
  });
});

describe('the brief', () => {
  const finding = (index: number) => ({
    kind: 'expired',
    subject: `lessons/L-2025-0${index}.md`,
    detail: 'expires: 2025-06-01 has passed',
  });

  it('names the period, what to do and every finding the platform established', () => {
    const brief = renderChoreBrief({
      type: 'kb',
      period: '2026-W38',
      findings: [finding(1), finding(2)],
      source: 'the nightly knowledge hygiene pass of 2026-09-15',
    });
    expect(brief.title).toBe('Knowledge base hygiene (2026-W38)');
    expect(brief.description).toContain('2026-W38');
    expect(brief.description).toContain(MAINTENANCE_CHORES.kb.does);
    expect(brief.description).toContain('lessons/L-2025-01.md');
    expect(brief.description).toContain('lessons/L-2025-02.md');
    expect(brief.description).toContain('the nightly knowledge hygiene pass of 2026-09-15');
    expect(brief.dropped).toBe(0);
  });

  it('caps the list and says how many it dropped, rather than reading as “nothing else”', () => {
    const brief = renderChoreBrief({
      type: 'deps',
      period: '2026-09',
      findings: Array.from({ length: MAX_CHORE_FINDINGS + 3 }, (_, index) => finding(index)),
      source: 'the registry answers the dependency gate recorded',
    });
    expect(brief.dropped).toBe(3);
    expect(brief.description).toContain('and 3 more finding(s)');
  });

  it('cuts one enormous finding rather than letting it swallow the brief', () => {
    const brief = renderChoreBrief({
      type: 'kb',
      period: '2026-09',
      findings: [{ kind: 'expired', subject: 'a'.repeat(5_000), detail: 'b'.repeat(5_000) }],
      source: 'the nightly pass',
    });
    const line = brief.description
      .split('\n')
      .find((entry) => entry.startsWith('- expired')) as string;
    // One past the cap and exactly at it (standing rule 42): the line is cut and marked, and a
    // finding that fits is untouched.
    expect(line.length).toBe(MAX_CHORE_FINDING_CHARS + 1);
    expect(line.endsWith('…')).toBe(true);
    const short = renderChoreBrief({
      type: 'kb',
      period: '2026-09',
      findings: [{ kind: 'expired', subject: 'x', detail: 'y' }],
      source: 'the nightly pass',
    });
    expect(short.description).toContain('- expired: x — y');
  });
});
