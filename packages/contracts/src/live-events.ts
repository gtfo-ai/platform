/**
 * What a `domain_event` SSE frame carries (S-23.14, TD-014, technical/08 § "SSE contract").
 *
 * The `org`, `project:<id>` and `task:<id>` topics announce that a task or a run **changed** so the
 * screens that show it refetch. They never carry the change itself. The frame's `data` is a
 * **projection** of the stored event, and the projection is an allow-list:
 *
 *  - the envelope's identity — `id`, `type`, `stream_type`, `stream_id`, `occurred_at`;
 *  - the ids a payload names — `project_id`, `task_id`, `run_id`, `question_id`, `approval_id`,
 *    `worker_id` — and the `stage` it is about;
 *  - three small enums — a run's `status`, a stage's `verdict`, a claim's `claimant_kind`.
 *
 * **Never free text.** A question's words, an escalation's brief, a steer message, a withdrawal
 * reason, an answer, a ticket status name: none of it is on the stream, for two reasons that are
 * both decided rather than incidental. BD-022 — every one of those strings is untrusted (or model
 * written), and a stream that carried them would be a second rendering path for untrusted text
 * beside the read API's. And least exposure — the client refetches through the read API, which
 * applies its own authorisation to every field it returns, so the stream needs to say *what* to
 * refetch and nothing more.
 *
 * Every field is validated against its own schema **while it is copied**, so a value the catalogue
 * would accept but this projection does not (a stage verdict outside {@link stageVerdictSchema} —
 * `RefinedSpec`'s raw model text — or a status that is a provider's lifecycle name rather than a
 * run status) is dropped, never forwarded. The result is parsed by the strict
 * {@link liveDomainEventSchema} before it is returned, so an unknown key cannot ride along.
 */
import * as z from 'zod';
import { idSchema, isoDateTimeSchema, runStatusSchema, SLUG_PATTERN } from './common.js';
import {
  DOMAIN_EVENT_TYPES,
  type DomainEventType,
  runClaimantKindSchema,
  streamTypeSchema,
} from './events.js';
import { stageVerdictSchema } from './pipeline.js';

/**
 * The catalogue types the live topics carry: every `task.*` and every `run.*` event.
 *
 * Derived from the catalogue rather than listed, so a task or run event a later change adds is live
 * the moment it exists (a hand list is the arm nobody adds — `apps/web/src/realtime/query-bridge.ts`
 * makes the same argument). `ticket.*`, `mr.*`, `ci.*`, `budget.*`, `knowledge.*` and the rest stay
 * off the stream: they are about a provider or the organisation, and every one that changes a task
 * is followed by a `task.*` event that says so.
 */
export const LIVE_DOMAIN_EVENT_TYPES = DOMAIN_EVENT_TYPES.filter(
  (type) => type.startsWith('task.') || type.startsWith('run.'),
) as [DomainEventType, ...DomainEventType[]];

export const liveDomainEventTypeSchema = z.enum(LIVE_DOMAIN_EVENT_TYPES);
export type LiveDomainEventType = z.infer<typeof liveDomainEventTypeSchema>;

const LIVE_TYPES: ReadonlySet<string> = new Set(LIVE_DOMAIN_EVENT_TYPES);

/** Whether a catalogue type is carried by the `org` / `project:<id>` / `task:<id>` topics. */
export const isLiveDomainEventType = (type: string): type is LiveDomainEventType =>
  LIVE_TYPES.has(type);

/**
 * A stage id on the stream. `stageIdSchema` is an unbounded slug; the projection bounds it, because
 * every field it copies is bounded by its own schema and a stage id is configuration text.
 */
export const MAX_LIVE_STAGE_CHARS = 64;
const liveStageSchema = z.string().max(MAX_LIVE_STAGE_CHARS).regex(SLUG_PATTERN);

/** The `data` of a `domain_event` frame. Strict: an unknown key is an error, never dropped. */
export const liveDomainEventSchema = z.strictObject({
  id: idSchema,
  type: liveDomainEventTypeSchema,
  stream_type: streamTypeSchema,
  stream_id: idSchema,
  occurred_at: isoDateTimeSchema,
  project_id: idSchema.optional(),
  task_id: idSchema.optional(),
  run_id: idSchema.optional(),
  stage: liveStageSchema.optional(),
  question_id: idSchema.optional(),
  approval_id: idSchema.optional(),
  worker_id: idSchema.optional(),
  /** A run's status — `run.finished` and `run.failed` only. */
  status: runStatusSchema.optional(),
  /** A stage's verdict — `task.stage.completed` only, and only a verdict the platform maps. */
  verdict: stageVerdictSchema.optional(),
  /** Who claimed a run — `run.claimed` only. */
  claimant_kind: runClaimantKindSchema.optional(),
});
export type LiveDomainEvent = z.infer<typeof liveDomainEventSchema>;

/** A stored event as the projection reads it: the envelope plus a payload it does not trust. */
export interface LiveDomainEventSource {
  readonly id: string;
  readonly type: string;
  readonly stream_type: string;
  readonly stream_id: string;
  readonly occurred_at: string;
  readonly payload: unknown;
}

const field = (source: unknown, key: string): unknown =>
  typeof source === 'object' &&
  source !== null &&
  !Array.isArray(source) &&
  Object.hasOwn(source, key)
    ? (source as Record<string, unknown>)[key]
    : undefined;

/** The value when it parses, otherwise nothing: a projection drops what it cannot vouch for. */
const pick = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/**
 * The live projection of a stored event, or `null` when the event is not a live type or its
 * envelope does not parse (a malformed row is skipped by the caller, never forwarded).
 */
export const projectLiveDomainEvent = (source: LiveDomainEventSource): LiveDomainEvent | null => {
  if (!isLiveDomainEventType(source.type)) {
    return null;
  }
  const payload = source.payload;
  const type = source.type;
  const fields: Record<string, unknown> = {
    id: source.id,
    type,
    stream_type: source.stream_type,
    stream_id: source.stream_id,
    occurred_at: source.occurred_at,
    project_id: pick(idSchema, field(payload, 'project_id')),
    task_id: pick(idSchema, field(payload, 'task_id')),
    run_id: pick(idSchema, field(payload, 'run_id')),
    // `task.stage.returned` names where the task went; every other stage-bearing event names one.
    stage:
      pick(liveStageSchema, field(payload, 'stage')) ??
      pick(liveStageSchema, field(payload, 'to_stage')),
    question_id:
      pick(idSchema, field(payload, 'question_id')) ??
      pick(idSchema, field(field(payload, 'question'), 'id')),
    approval_id:
      pick(idSchema, field(payload, 'approval_id')) ??
      pick(idSchema, field(field(payload, 'approval'), 'id')),
    worker_id: pick(idSchema, field(payload, 'worker_id')),
    // Gated by type: `task.human_return` also has a `status`, and it is a provider's lifecycle name.
    status: type.startsWith('run.') ? pick(runStatusSchema, field(payload, 'status')) : undefined,
    verdict:
      type === 'task.stage.completed'
        ? pick(stageVerdictSchema, field(payload, 'verdict'))
        : undefined,
    claimant_kind:
      type === 'run.claimed'
        ? pick(runClaimantKindSchema, field(payload, 'claimant_kind'))
        : undefined,
  };
  // An absent field is absent on the wire, never `undefined` or `null`.
  const candidate = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  const parsed = liveDomainEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};
