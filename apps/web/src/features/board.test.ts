import { taskStateSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { BOARD_COLUMNS, columnFor } from './board.js';

/**
 * Every task state must land in a column somebody can see.
 *
 * The columns are a hand-written grouping over a published enum, which is exactly the shape that
 * drifts when the enum grows (standing rule 7). Rather than carrying a second list, the test asks
 * `taskStateSchema` what the states are: a state added to `packages/contracts` and not to
 * `BOARD_COLUMNS` fails here instead of quietly disappearing from the board.
 */
describe('the board columns', () => {
  it('cover every published task state exactly once', () => {
    const declared = BOARD_COLUMNS.flatMap((column) => [...column.states]);
    const states = taskStateSchema.options;

    expect([...declared].sort()).toEqual([...states].sort());
    expect(new Set(declared).size, 'a state appears in two columns').toBe(declared.length);
  });

  it('routes each state to the column that declares it', () => {
    for (const state of taskStateSchema.options) {
      const column = BOARD_COLUMNS.find((candidate) =>
        (candidate.states as readonly string[]).includes(state),
      );
      expect(columnFor(state), state).toBe(column?.id);
    }
  });

  it('puts a state nobody has heard of in Active rather than hiding it', () => {
    expect(columnFor('a_state_from_the_future')).toBe('active');
  });
});
