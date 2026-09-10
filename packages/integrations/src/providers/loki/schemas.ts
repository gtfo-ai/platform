/**
 * Loki HTTP API payloads, validated at the ring edge (BD-022).
 *
 * Deliberately **non-strict** (`z.object` strips unknown keys), the documented exception in
 * CLAUDE.md for opaque provider payloads: Loki 3.x added `warnings` beside `stats` and structured
 * metadata as a *third element* of a values tuple, and neither should turn a log read into an
 * outage. What is named here is checked.
 *
 * Transcribed from <https://grafana.com/docs/loki/latest/reference/loki-http-api/>, retrieved
 * 2026-09-10: the `query_range` streams example (`status`, `data.resultType`, `data.result[]` with
 * `stream` and `values`, `data.stats` with its `ingester`/`store`/`summary` blocks), the `labels`
 * and `label/<name>/values` examples (`{"status":"success","data":["foo","bar","baz"]}`) and the
 * `series` example (a list of label-set objects).
 */
import * as z from 'zod';

/**
 * One entry: `["1569266497240578000", "foo"]`.
 *
 * Modelled as an open array rather than a two-tuple because Loki 3 appends structured metadata as
 * a third element, and a `z.tuple` of length two would reject a response the vendor documents
 * elsewhere. The two members the adapter reads are checked by hand, so a malformed entry is still
 * an `invalid_response` rather than an `undefined` timestamp.
 */
export const lokiEntrySchema = z
  .array(z.unknown())
  .refine(
    (value) => typeof value[0] === 'string' && typeof value[1] === 'string',
    'expected ["<nanosecond timestamp>", "<line>"]',
  )
  .transform((value) => ({ timestampNs: value[0] as string, line: value[1] as string }));

export const lokiStreamSchema = z.object({
  stream: z.record(z.string(), z.string()),
  values: z.array(lokiEntrySchema),
});

/**
 * `status` is `"success"` on every documented example. It is checked rather than assumed: a body
 * whose status is anything else, served with a 200 by a proxy, would otherwise be read as an empty
 * result — and "no lines" is the answer that makes an agent conclude the error stopped.
 */
export const lokiStreamsResponseSchema = z.object({
  status: z.string(),
  data: z.object({
    resultType: z.string(),
    result: z.array(lokiStreamSchema),
    stats: z.unknown().nullish(),
  }),
  /** Loki 3 reports a partial or degraded answer here. Absent on the documented examples. */
  warnings: z.array(z.string()).nullish(),
});

/**
 * `data` is `nullish` rather than required, and that is a **tolerance chosen here**, not something
 * the vendor states: every published example shows an array, and no page says what an instance
 * with no matching stream answers. Accepting `null` as "nothing" costs nothing; refusing it would
 * turn an empty label index into an `invalid_response`.
 */
export const lokiValuesResponseSchema = z.object({
  status: z.string(),
  data: z.array(z.string()).nullish(),
});

export const lokiSeriesResponseSchema = z.object({
  status: z.string(),
  data: z.array(z.record(z.string(), z.string())).nullish(),
});

export type LokiStreamsResponse = z.output<typeof lokiStreamsResponseSchema>;
export type LokiStream = z.output<typeof lokiStreamSchema>;
