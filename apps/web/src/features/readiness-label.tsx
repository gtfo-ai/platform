/**
 * A project's readiness level as a StateLabel (product/17 § "Levels").
 *
 * The level's **name** is product/17's own (*Unverified*, *Basic*, *Reliable*, *Agent-ready*,
 * *Autonomous-capable*), so the label says what the number means rather than only the number. The
 * colour follows the same table: level 0 is the red badge product/17 asks the board for, levels 1
 * and 2 run with a person checking the plan (waiting), and 3 and up are the ones product/17 lets an
 * agent run with lighter approval (success). The contract allows a level 5 that product/17 does not
 * name; it is drawn as "Level 5" rather than given an invented name.
 */
import type { ReactElement } from 'react';
import { StateLabel, type Status } from '../ui/status.js';

const LEVEL_NAMES: readonly string[] = [
  'Unverified',
  'Basic',
  'Reliable',
  'Agent-ready',
  'Autonomous-capable',
];

export const readinessWord = (level: number): string => {
  const name = LEVEL_NAMES[level];
  return name === undefined ? `Level ${level}` : `L${level} ${name}`;
};

export const readinessStatus = (level: number): Status =>
  level <= 0 ? 'failure' : level <= 2 ? 'waiting' : 'success';

export const ReadinessLabel = ({
  level,
  size = 'sm',
}: {
  readonly level: number;
  readonly size?: 'sm' | 'md';
}): ReactElement => (
  <StateLabel status={readinessStatus(level)} size={size}>
    {readinessWord(level)}
  </StateLabel>
);
