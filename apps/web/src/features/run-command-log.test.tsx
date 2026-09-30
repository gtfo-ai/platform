/**
 * The run screen says what became of each steer, take-over stop and cancel (WP-85, TD-028 decision
 * 9; the cancel since WP-101, decision 11).
 *
 * A command is accepted by one process and applied or refused by another, so the screen reads the
 * outcome rather than assuming one. Every state is rendered in words, and each refusal names its
 * reason — the two refusals have different remedies (standing rule 18).
 */
import type { RunCommandRecord } from '@platform/contracts';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RunCommandLog, runCommandStateText } from './run-command-log.js';

const base: RunCommandRecord = {
  id: '00000000-0000-4000-8000-0000000000c1',
  run_id: '00000000-0000-4000-8000-0000000000a1',
  kind: 'steer',
  state: 'pending',
  message: 'use the invoice total',
  author_user_id: '00000000-0000-4000-8000-0000000000e1',
  created_at: '2026-09-28T09:00:00.000Z',
  applied_at: null,
  refused_at: null,
  refused_reason: null,
};

afterEach(() => {
  cleanup();
});

describe('runCommandStateText', () => {
  it('says a pending command is accepted and waiting, never delivered', () => {
    const text = runCommandStateText(base);
    expect(text).toContain('Accepted');
    expect(text).toContain('waiting for the process running the agent');
    expect(text).not.toContain('delivered');
  });

  it('says an applied steer reached the live session, and an applied stop asked for the export', () => {
    expect(
      runCommandStateText({ ...base, state: 'applied', applied_at: '2026-09-28T09:00:02.000Z' }),
    ).toContain('delivered to the live session');
    expect(
      runCommandStateText({
        ...base,
        kind: 'take_over',
        state: 'applied',
        applied_at: '2026-09-28T09:00:02.000Z',
      }),
    ).toContain('asked to stop and export its workspace');
    // WP-101: a cancel's stop says it stops the session and costs what it cost — no export.
    const cancelled = runCommandStateText({
      ...base,
      kind: 'cancel',
      state: 'applied',
      applied_at: '2026-09-28T09:00:02.000Z',
    });
    expect(cancelled).toContain('the session was asked to stop');
    expect(cancelled).not.toContain('export');
  });

  it('names each refusal by its reason', () => {
    const ended = runCommandStateText({ ...base, state: 'refused', refused_reason: 'run_ended' });
    expect(ended).toContain('the run ended before this message could be applied');
    expect(ended).toContain('will not be applied later');
    const missed = runCommandStateText({
      ...base,
      state: 'refused',
      refused_reason: 'register_miss',
    });
    expect(missed).toContain('found no live session');
    expect(missed).not.toContain('ended');
    const failed = runCommandStateText({
      ...base,
      state: 'refused',
      refused_reason: 'delivery_failed',
    });
    expect(failed).toContain('the live session did not take this message');
    expect(failed).toContain('will not be retried');
    expect(failed).not.toContain('Applied');
    expect(
      runCommandStateText({ ...base, state: 'refused', refused_reason: 'undecodable' }),
    ).toContain('cannot read');
  });
});

describe('RunCommandLog', () => {
  it('renders nothing when no command was sent', () => {
    const { container } = render(<RunCommandLog commands={[]} />);
    expect(container.textContent).toBe('');
  });

  it('lists each command with its state and the stored message as text', () => {
    const { container } = render(
      <RunCommandLog
        commands={[
          { ...base, message: '<b>not markup</b>' },
          {
            ...base,
            id: '00000000-0000-4000-8000-0000000000c2',
            kind: 'take_over',
            state: 'refused',
            message: null,
            refused_at: '2026-09-28T09:01:00.000Z',
            refused_reason: 'run_ended',
          },
          {
            ...base,
            id: '00000000-0000-4000-8000-0000000000c3',
            kind: 'cancel',
            state: 'pending',
            message: null,
          },
        ]}
      />,
    );
    const items = [...container.querySelectorAll('li')];
    expect(items.map((item) => item.getAttribute('data-command-state'))).toEqual([
      'pending',
      'refused',
      'pending',
    ]);
    expect(items[2]?.textContent).toContain('Cancel');
    expect(items[2]?.textContent).toContain(
      'waiting for the process running the agent to apply this stop',
    );
    // Untrusted text stays text (BD-022): the tag is characters, not an element.
    expect(container.querySelector('b')).toBeNull();
    expect(items[0]?.textContent).toContain('<b>not markup</b>');
    expect(items[1]?.textContent).toContain('Take-over stop');
    expect(items[1]?.textContent).toContain('the run ended before this stop could be applied');
  });
});
