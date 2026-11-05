/**
 * PhaseTrack (TD-033 decision 7): an ordered list with the current step marked, a summary a screen
 * reader hears first, a glyph per state so colour is never the only signal, and the current stage's
 * human name with "Now: …". `phaseStagesFor` builds it from the stage rows a task page has today and
 * from a compiled graph's nodes.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PHASE_LOOK,
  PHASE_STATES,
  type PhaseStage,
  PhaseTrack,
  phaseStagesFor,
  phaseSummary,
  type StageRowLike,
} from './phase-track.js';

afterEach(() => {
  cleanup();
});

const STAGES: readonly PhaseStage[] = [
  { id: 'intake', state: 'done' },
  { id: 'refinement', state: 'done' },
  { id: 'implementation', state: 'returned' },
  { id: 'code_review', state: 'current' },
  { id: 'rebase_gate', state: 'upcoming' },
];

describe('PhaseTrack', () => {
  it('is an ordered list with the current stage marked as the step', () => {
    render(<PhaseTrack stages={STAGES} activity="working" detail="Reading files" />);
    const list = screen.getByRole('list', { name: 'Pipeline stages' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([
      null,
      null,
      null,
      'step',
      null,
    ]);
    expect(items[3]?.textContent).toBe('Code review, current');
    expect(items[2]?.textContent).toBe('Implementation, sent back');
  });

  it('opens with a visually-hidden summary and shows the stage and what it is doing now', () => {
    const { container } = render(
      <PhaseTrack stages={STAGES} activity="working" detail="Reading files" />,
    );
    expect(screen.getByText('Stage 4 of 5: Code review, working').className).toContain('sr-only');
    expect(container.querySelector('p')?.textContent).toBe('Code review · Now: Reading files');
  });

  it('falls back to the activity’s word, and to the stage alone', () => {
    const { container, rerender } = render(<PhaseTrack stages={STAGES} activity="stuck" />);
    expect(container.querySelector('p')?.textContent).toBe('Code review · Now: Stuck');
    rerender(<PhaseTrack stages={STAGES} />);
    expect(container.querySelector('p')?.textContent).toBe('Code review');
    rerender(<PhaseTrack stages={STAGES.map((stage) => ({ ...stage, state: 'done' }))} />);
    expect(container.querySelector('p')).toBeNull();
  });

  it('gives every state its own glyph and word, so colour is never the only signal', () => {
    expect(new Set(PHASE_STATES.map((state) => PHASE_LOOK[state].icon)).size).toBe(
      PHASE_STATES.length,
    );
    expect(new Set(PHASE_STATES.map((state) => PHASE_LOOK[state].word)).size).toBe(
      PHASE_STATES.length,
    );
    const { container } = render(
      <PhaseTrack stages={PHASE_STATES.map((state, index) => ({ id: `s${index}`, state }))} />,
    );
    for (const state of PHASE_STATES) {
      const item = container.querySelector(`[data-phase="${state}"]`);
      expect(item?.querySelector('svg')).not.toBeNull();
      expect(item?.className).toContain(PHASE_LOOK[state].fg);
    }
  });

  it('takes a label over the stage’s own name, and a smaller glyph at sm', () => {
    const { container } = render(
      <PhaseTrack stages={[{ id: 'security_scan', label: 'Scan', state: 'current' }]} size="sm" />,
    );
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('12');
    expect(screen.getByText('Stage 1 of 1: Scan')).toBeTruthy();
  });
});

describe('phaseSummary', () => {
  it('says when nothing is in progress', () => {
    expect(phaseSummary([])).toBe('No stages yet');
    expect(phaseSummary([{ id: 'intake', state: 'upcoming' }])).toBe('Not started');
    expect(phaseSummary([{ id: 'intake', state: 'done' }], 'done')).toBe('No stage in progress');
  });
});

const row = (stage: string, attempt: number, state: StageRowLike['state']): StageRowLike => ({
  stage,
  attempt,
  state,
});

describe('phaseStagesFor', () => {
  it('lists the entered stages in first-entered order, each at its latest attempt', () => {
    const rows = [
      row('intake', 1, 'completed'),
      row('implementation', 1, 'completed'),
      row('code_review', 1, 'returned'),
      row('implementation', 2, 'running'),
    ];
    expect(phaseStagesFor(null, rows, 'implementation')).toEqual([
      { id: 'intake', state: 'done' },
      { id: 'implementation', state: 'current' },
      { id: 'code_review', state: 'returned' },
    ]);
  });

  it('appends the current stage when the task has not entered it yet, and invents nothing upcoming', () => {
    expect(phaseStagesFor(null, [row('intake', 1, 'completed')], 'refinement')).toEqual([
      { id: 'intake', state: 'done' },
      { id: 'refinement', state: 'current' },
    ]);
    expect(phaseStagesFor(null, [], null)).toEqual([]);
  });

  it('marks the current stage failed when its latest attempt failed', () => {
    expect(phaseStagesFor(null, [row('ci_gate', 1, 'failed')], 'ci_gate')).toEqual([
      { id: 'ci_gate', state: 'failed' },
    ]);
  });

  it('reads a live attempt at a stage the task left as done', () => {
    const rows = [row('refinement', 1, 'running'), row('architecture', 1, 'running')];
    expect(phaseStagesFor(null, rows, 'architecture')[0]).toEqual({
      id: 'refinement',
      state: 'done',
    });
  });

  it('shows the whole graph in pipeline order when it has one', () => {
    const nodes = [
      'intake',
      'refinement',
      'investigation',
      'implementation',
      'ci_gate',
      'done',
    ].map((id) => ({ id }));
    const rows = [
      row('intake', 1, 'completed'),
      row('refinement', 1, 'completed'),
      row('implementation', 1, 'running'),
      row('skipped_one', 1, 'completed'),
    ];
    expect(phaseStagesFor(nodes, rows, 'implementation')).toEqual([
      { id: 'intake', state: 'done' },
      { id: 'refinement', state: 'done' },
      { id: 'investigation', state: 'skipped' },
      { id: 'implementation', state: 'current' },
      { id: 'ci_gate', state: 'upcoming' },
      { id: 'done', state: 'upcoming' },
    ]);
  });

  it('measures the graph from the last entered stage when there is no current one', () => {
    const nodes = ['intake', 'refinement', 'done'].map((id) => ({ id }));
    expect(
      phaseStagesFor(nodes, [row('intake', 1, 'completed'), row('done', 1, 'completed')], null),
    ).toEqual([
      { id: 'intake', state: 'done' },
      { id: 'refinement', state: 'skipped' },
      { id: 'done', state: 'done' },
    ]);
  });
});
