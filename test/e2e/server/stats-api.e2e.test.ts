/**
 * **WP-41's criterion 8, on a real `apps/server` instance and a real PostgreSQL**: *"driven from
 * real events in the integration or e2e tier, never from seeded rollup rows — a tier that seeds the
 * rollup certifies nothing about the fold"* (standing rule 82).
 *
 * So nothing here inserts a `stats_task_delivery` or a `stats_event_daily` row. A feature ticket is
 * driven through the whole pipeline to `done`, the merge arrives as a **signed delivery-shaped
 * event with `task_id: null`** — which is what a git adapter really produces, and is the case that
 * would have shipped this projection as a permanent zero — and the numbers are then read back
 * through `GET /api/org/stats` and its CSV twin over HTTP, with a real session.
 *
 * **The wait binds the last row the platform writes** (standing rule 87): the projector runs at
 * TD-005 priority 240, *after* the saga's handlers and in its own transaction, so the task reaching
 * `done` does not imply the delivery row exists. The wait is therefore on
 * `stats_task_delivery`, and the API response is asserted as what that row implies.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { GIT_PROJECT, inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const ticketMatched = (pipeline: PipelineE2E, key: string) =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key,
      url: `https://tickets.example.test/browse/${key}`,
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

/**
 * The merge, in the shape a git provider really delivers it: **`task_id: null`**.
 *
 * The association is `tasks.mr_ref`, which the projector looks up — a projector that trusted this
 * payload would write nothing here and would still pass a unit test that handed it a task id.
 */
const merged = (pipeline: PipelineE2E) =>
  inboundEvent('mr.merged', {
    project_id: pipeline.projectId,
    task_id: null,
    mr: {
      provider: 'fake-git',
      project_path: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      url: pipeline.world.mr.url,
      branch: pipeline.world.branch,
      head_sha: pipeline.world.mr.headSha,
    },
    draft: false,
    head_sha: pipeline.world.mr.headSha,
    diff_stats: null,
    merge_commit_sha: 'c'.repeat(40),
  });

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

interface StatsMetric {
  readonly id: string;
  readonly value: number | null;
  readonly samples: number;
  readonly absent: { readonly reason: string; readonly owner: string } | null;
  readonly buckets: readonly { readonly start: string; readonly value: number | null }[];
}

interface StatsBody {
  readonly range: { readonly from: string; readonly to: string; readonly timezone: string };
  readonly metrics: readonly StatsMetric[];
  readonly returns_by_stage: readonly {
    readonly stage: string;
    readonly entries: number;
    readonly returns: number;
    readonly rate: number | null;
  }[];
}

const metricOf = (body: StatsBody, id: string): StatsMetric => {
  const found = body.metrics.find((metric) => metric.id === id);
  if (found === undefined) {
    throw new Error(`no metric ${id} in the answer`);
  }
  return found;
};

describe('the statistics endpoint, on numbers this instance really produced', () => {
  it('counts a delivery folded from a real merge, and exports the same numbers as CSV', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'stats',
      tickets: TICKETS,
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    // WP-61, PROGRESS backlog 179 — the refiner's proving case: the merge event carries
    // `diff_stats: null` (what GitLab sends; `merged` above) and the provider's **read** answers a
    // number, so a `loc_changed` value can only have come from the read.
    pipeline.git.setDiffStats({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      stats: { files_changed: 2, insertions: 30, deletions: 10 },
    });
    await pipeline.publish([merged(pipeline)]);
    await pipeline.settle('done', (task) => task.state === 'done');

    // Standing rule 87: the row the assertions read, not the transition that precedes it. The
    // projector is priority 240 and commits in a transaction of its own, so `done` does not imply
    // this row — and a wait on `done` would pass or fail on a scheduling accident.
    await pipeline.waitFor('the delivery to be projected', async () => {
      const rows = await pipeline.query<{ task_id: string }>(
        'select task_id from stats_task_delivery where task_id = $1',
        [waiting.id],
      );
      return rows.length === 1;
    });
    // Rule 87 again: the measured size is the `task.mr.measured` the `merge_measure` job appends
    // after its own provider read — neither `done` nor the delivery row implies it.
    await pipeline.waitFor('the merged merge request’s size to be recorded', async () => {
      const rows = await pipeline.query<{ type: string }>(
        "select type from events where type = 'task.mr.measured' and payload ->> 'task_id' = $1",
        [waiting.id],
      );
      return rows.length === 1;
    });
    /**
     * **A second wait, because the cost half reads different rows than the delivery half** (WP-49,
     * pre-review: this failed once under the full tier at load ~12 with `expected 2.4 to be close
     * to 2.8`, one run's 0.40 short, and passed 3/3 alone).
     *
     * The wait above binds `stats_task_delivery`, which the projector writes on `mr.merged`.
     * `cost_total` reads `cost_rollup_daily` and `cost_per_delivered_task` reads
     * `sum(cost_entries.usd)` for the task (`apps/server/src/queries/stats-queries.ts`), and **both**
     * are written by the cost ledger's handler on `run.finished` — one transaction per run, in a
     * dispatch of its own that commits whenever it commits. So `done` plus a delivery row implies
     * neither of them: the task row reaching `done` and the last run's ledger dispatch are two
     * different transactions, and the endpoint can be read between them.
     *
     * The condition is "every run that ended has its ledger row", which is the last row these
     * assertions read and needs no number of its own; the rollup term binds the *other* table, and
     * is `>=` rather than `=` so that a future second task in this scenario cannot make the wait
     * hang on a total that legitimately exceeds this task's.
     */
    // The predicate assumes every ended run produces a `cost_entries` row, which holds for this
    // scenario because every fake run reports a figure. A run that reported nothing and has no
    // `price_list` row gets **no** ledger row by design (rule 16), so a scenario that grows one
    // turns this wait into a timeout — fail-loud, and the sentence to read when it does.
    await pipeline.waitFor(
      'every ended run’s spend to reach the ledger and its rollup',
      async () => {
        const [row] = await pipeline.query<{
          ended: string;
          charged: string;
          entries_usd: string;
          rollup_usd: string;
        }>(
          `select (select count(*) from runs where task_id = $1 and ended_at is not null)::text as ended,
                (select count(distinct run_id) from cost_entries where task_id = $1)::text as charged,
                (select coalesce(sum(usd), 0) from cost_entries where task_id = $1)::text as entries_usd,
                (select coalesce(sum(d.usd), 0) from cost_rollup_daily d
                   join tasks t on t.project_id = d.project_id
                  where t.id = $1)::text as rollup_usd`,
          [waiting.id],
        );
        if (row === undefined) {
          return false;
        }
        return (
          Number(row.ended) > 0 &&
          row.ended === row.charged &&
          Number(row.rollup_usd) >= Number(row.entries_usd)
        );
      },
    );

    const response = await client.json<StatsBody>('/api/org/stats?range=7d&bucket=day');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body;

    // The delivery, at merge time, from an event whose payload named no task.
    expect(metricOf(body, 'tasks_delivered').value).toBe(1);
    expect(metricOf(body, 'tasks_started').value).toBe(1);
    expect(metricOf(body, 'merge_rate').value).toBe(1);
    // Six agent stages at 0.40 USD each plus the retrospective and the librarian — the same 2.80
    // `pipeline.e2e.test.ts` asserts on the task row, arrived at through the cost ledger's rollup
    // rather than through `tasks.cost_actual` (two readings of one spend, and they agree).
    expect(metricOf(body, 'cost_total').value).toBeCloseTo(2.8, 2);
    expect(metricOf(body, 'cost_per_delivered_task').value).toBeCloseTo(2.8, 2);
    // A scripted run reports its cost, so none of this spend is priced by the platform.
    expect(metricOf(body, 'estimated_spend_share').value).toBe(0);
    // Every stage this template ran, with the returns it did not have.
    expect(body.returns_by_stage.map((stage) => stage.stage)).toContain('code_review');
    expect(body.returns_by_stage.every((stage) => stage.returns === 0)).toBe(true);
    // Lines changed per merged merge request, from the provider's read (30 + 10 over one merge),
    // though the merge event carried none (WP-61, backlog 179).
    const loc = metricOf(body, 'loc_changed');
    expect(loc.absent).toBeNull();
    expect(loc.value).toBe(40);
    // …and the metrics this build cannot compute are absent with an owner, on a real answer rather
    // than only in the fold's unit test (standing rule 16).
    const queueWait = metricOf(body, 'queue_wait_minutes');
    expect(queueWait.value).toBeNull();
    expect(queueWait.absent?.owner).toContain('task.dequeued');

    // `request` rather than `json`: the answer is `text/csv`, and reading it as JSON would be
    // asserting the wrong thing about the one route whose whole point is that it is not.
    const csv = await client.request('/api/org/stats.csv?range=7d&bucket=day');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const lines = (await csv.text()).trimEnd().split('\n');
    expect(lines[0]).toContain('metric,label,unit,scope,bucket_start,bucket_end,value,samples');
    // The same number, in the other representation — one source, two renderings.
    expect(lines.some((line) => line.startsWith('tasks_delivered,') && line.includes(',1,'))).toBe(
      true,
    );
    // An absent metric contributes a total row and no bucket rows, so nothing in a spreadsheet can
    // sum a cell the platform never measured.
    expect(lines.filter((line) => line.startsWith('queue_wait_minutes,'))).toHaveLength(1);
  }, 240_000);

  it('counts the rebase gate’s settlement from the event the gate appended', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'stats-rebase',
      tickets: TICKETS,
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    // The counter row, not the event: the projector writes it after the gate appended the event,
    // in its own transaction (standing rule 87).
    await pipeline.waitFor('the rebase settlement to be counted', async () => {
      const rows = await pipeline.query<{ metric: string }>(
        "select metric from stats_event_daily where metric = 'rebase.clean'",
      );
      return rows.length === 1;
    });

    const body = (await client.json<StatsBody>('/api/org/stats?range=7d&bucket=day')).body;
    // `clean` is not `resolved`: the branch applied on the first check, so nothing was
    // auto-resolved and nothing was escalated. Both directions, on the same answer (rule 42).
    expect(metricOf(body, 'rebase_conflicts_resolved').value).toBe(0);
    expect(metricOf(body, 'rebase_conflicts_escalated').value).toBe(0);
    expect(metricOf(body, 'concurrent_task_overlaps').value).toBe(0);
  }, 240_000);
});
