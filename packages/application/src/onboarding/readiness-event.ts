/**
 * `readiness.evaluated` — the event both readiness producers append beside the row they record
 * (WP-73, PROGRESS backlog 228).
 *
 * The event was in the catalogue with named producers and a named consumer from WP-01, and until
 * WP-73 nothing appended it: the discovery recorder and the post-merge re-check wrote
 * `readiness_evaluations` through `ReadinessStore.record` and said nothing on the bus, so a level
 * could change after any merge (since WP-64) with no event and no SSE frame about it. Both
 * producers now append one event **per recorded row, in the transaction of that `record` call** —
 * a rolled-back row leaves no event, and a committed one cannot be missing its event.
 *
 * The consumption row stays `unconsumed` (`events/consumption.ts`): nothing reacts to the event yet
 * — policy suggestions and a trend view are its named consumers and neither exists — and every
 * reader of the level still queries the row. The payload is the row's, so a consumer that arrives
 * later needs no second read. `evidence` is what the row stores, which was redacted on the way in
 * (the discovery recorder's redactor; the re-check writes platform text only).
 */
import { type Id, type IsoDateTime, readinessEvaluatedEvent } from '@platform/contracts';
import type { ReadinessEvaluation } from './ports.js';

/** Which producer wrote the row — `readiness_evaluations.source`, and the event's `source`. */
const EVENT_SOURCES = ['discovery', 'recheck'] as const;

type ReadinessEventSource = (typeof EVENT_SOURCES)[number];

const eventSourceOf = (source: string): ReadinessEventSource => {
  const known = EVENT_SOURCES.find((candidate) => candidate === source);
  if (known === undefined) {
    // A third producer is a decision, not a default: the event would otherwise say which producer
    // wrote a row that some other producer wrote.
    throw new Error(`readiness.evaluated has no source for a "${source}" evaluation`);
  }
  return known;
};

/** The event for one recorded evaluation, on the project's stream at `streamSeq`. */
export const readinessEvaluatedEventFor = (input: {
  readonly id: Id;
  readonly evaluation: ReadinessEvaluation;
  readonly streamSeq: number;
  readonly component: string;
  readonly occurredAt: IsoDateTime;
}) =>
  readinessEvaluatedEvent.parse({
    id: input.id,
    stream_type: 'project',
    stream_id: input.evaluation.projectId,
    stream_seq: input.streamSeq,
    actor: { kind: 'system', component: input.component },
    occurred_at: input.occurredAt,
    type: 'readiness.evaluated',
    payload: {
      project_id: input.evaluation.projectId,
      level: input.evaluation.level,
      criteria: input.evaluation.criteria.map((criterion) => ({
        id: criterion.id,
        passed: criterion.passed,
        evidence: criterion.evidence,
      })),
      source: eventSourceOf(input.evaluation.source),
    },
  });
