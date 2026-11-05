/** Timeline and Stepper: ordered lists whose state is also a word, never only a glyph. */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusIcon } from './status.js';
import { Stepper } from './stepper.js';
import { Timeline, TimelineItem } from './timeline.js';

afterEach(() => {
  cleanup();
});

describe('Timeline', () => {
  it('is a named ordered list of events with their times', () => {
    render(
      <Timeline label="Stages">
        <TimelineItem badge={<StatusIcon status="success" decorative />} time="10:02">
          Refinement finished
        </TimelineItem>
        <TimelineItem badge={<StatusIcon status="running" decorative />}>
          Implementation started
        </TimelineItem>
      </Timeline>,
    );
    const list = screen.getByRole('list', { name: 'Stages' });
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Refinement finished10:02',
      'Implementation started',
    ]);
  });
});

describe('Stepper', () => {
  const renderSteps = () =>
    render(
      <Stepper
        label="Onboarding"
        steps={[
          { id: 'repo', label: 'Repository', state: 'done' },
          { id: 'tracker', label: 'Tracker', state: 'current', hint: 'Jira or GitLab issues' },
          { id: 'chat', label: 'Chat', state: 'upcoming', optional: true },
        ]}
      />,
    );

  it('marks the current step for assistive tech and says every step’s state in words', () => {
    renderSteps();
    const list = screen.getByRole('list', { name: 'Onboarding' });
    const steps = within(list).getAllByRole('listitem');
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    // The badge (✓, or the step's number) is hidden; the words beside it are what is read.
    const spoken = (step: HTMLElement): string =>
      [...step.childNodes]
        .filter((node) => !(node instanceof HTMLElement && node.getAttribute('aria-hidden')))
        .map((node) => node.textContent)
        .join('');
    expect(steps.map(spoken)).toEqual([
      'Repository, Completed',
      'Tracker, Current stepJira or GitLab issues',
      'Chat, Not startedOptional',
    ]);
  });

  it('draws each state differently', () => {
    const { container } = renderSteps();
    expect(
      [...container.querySelectorAll('[data-step-state]')].map((node) =>
        node.getAttribute('data-step-state'),
      ),
    ).toEqual(['done', 'current', 'upcoming']);
    expect(container.querySelector('[data-step-state="done"] svg')).not.toBeNull();
  });

  it('renders an addressable step through the caller’s link', () => {
    render(
      <Stepper
        label="Wizard"
        steps={[
          {
            id: 'a',
            label: 'Repository',
            state: 'done',
            render: (props) => <button type="button" {...props} />,
          },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Repository' })).toBeTruthy();
  });
});
