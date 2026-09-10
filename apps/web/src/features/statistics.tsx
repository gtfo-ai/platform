/**
 * Statistics — **a stub, and it says so on the screen.**
 *
 * product/10 wants delivered tasks, cost, LOC, cycle time, return rates and intervention rate per
 * day/week/month with a CSV export, and technical/08 names `GET /api/org/stats?range=…`. There is
 * no DTO for that response anywhere in `packages/contracts`, and no rollup table is populated yet
 * (WP-19 builds the cost ledger and rollups; WP-41 the deep dive). Building a chart on a response
 * shape invented here would be a client that fails the moment the real one lands, and a screen full
 * of zeroes reads as "we delivered nothing" rather than "nothing is measured yet".
 *
 * So the screen is honest instead: it names the numbers that are coming and the work packages that
 * produce them. Recorded as Q45.
 */
import type { ReactElement } from 'react';
import { Card, EmptyState, SectionHeading } from '../ui/kit.js';

const PLANNED = [
  ['Delivered tasks', 'Merged agent merge requests per period (Q11).', 'WP-19, WP-41'],
  ['Cost', 'Provider-reported spend, per project and per stage.', 'WP-19'],
  ['Cycle time', 'Ticket picked up to merge request merged.', 'WP-41'],
  ['Return rate', 'Stages sent backwards per delivered task (BD-008).', 'WP-41'],
  ['Intervention rate', 'Tasks that needed a human decision.', 'WP-41'],
  [
    'Clean first-MR rate',
    'Merge requests merged without a return, by ticket author (Q22).',
    'WP-41',
  ],
] as const;

export const StatisticsScreen = (): ReactElement => (
  <div className="flex flex-col gap-3">
    <SectionHeading>Statistics</SectionHeading>
    <EmptyState
      title="Statistics are not available on this instance yet"
      hint="GET /api/org/stats has no published response shape in packages/contracts and no rollup table behind it. This screen will render the numbers below once WP-19 lands the cost ledger and rollups; it deliberately shows nothing rather than zeroes that read as results."
    />
    <Card>
      <ul className="flex flex-col gap-2 text-sm">
        {PLANNED.map(([name, definition, owner]) => (
          <li key={name} className="flex flex-wrap gap-2">
            <span className="font-medium">{name}</span>
            <span className="text-fg-muted">{definition}</span>
            <span className="ml-auto font-mono text-xs text-fg-muted">{owner}</span>
          </li>
        ))}
      </ul>
    </Card>
  </div>
);
