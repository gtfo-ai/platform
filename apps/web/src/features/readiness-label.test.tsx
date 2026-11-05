/** The readiness label (product/17 § "Levels"): the level's own name and the colour its table gives it. */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReadinessLabel, readinessStatus, readinessWord } from './readiness-label.js';

afterEach(() => {
  cleanup();
});

describe('ReadinessLabel', () => {
  it.each([
    [0, 'L0 Unverified', 'failure'],
    [1, 'L1 Basic', 'waiting'],
    [2, 'L2 Reliable', 'waiting'],
    [3, 'L3 Agent-ready', 'success'],
    [4, 'L4 Autonomous-capable', 'success'],
    // The contract allows a level product/17 does not name: shown, never given an invented name.
    [5, 'Level 5', 'success'],
  ] as const)('level %i reads %j as %s', (level, word, status) => {
    expect(readinessWord(level)).toBe(word);
    expect(readinessStatus(level)).toBe(status);
    const { container } = render(<ReadinessLabel level={level} />);
    expect(container.textContent).toBe(word);
    expect(container.querySelector('[data-state-label]')?.getAttribute('data-state-label')).toBe(
      status,
    );
  });
});
