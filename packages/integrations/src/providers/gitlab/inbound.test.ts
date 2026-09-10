/**
 * Delivery → catalogue event.
 *
 * Every payload here is a cut-down version of the published example on
 * <https://docs.gitlab.com/user/project/integrations/webhook_events/> (retrieved 2026-09-10), and
 * every event produced is parsed against the catalogue schema, which is strict — a normaliser that
 * invented a payload field fails here rather than at the first append to `events` (technical/02).
 *
 * Half the tests assert a *drop* and why. That is the point of `NormalisedDelivery` carrying both
 * halves: a normaliser that silently swallowed a hook it did not understand would make a missing
 * pipeline transition undebuggable, and "no events" alone is also what a broken harness produces.
 */
import {
  type GitProviderInboundEvent,
  type InboundContext,
  type NormalisedDelivery,
  noSecretsRedactor,
  type SecretRedactor,
} from '@platform/application';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { normaliseGitLabDelivery } from './inbound.js';

const PROJECT = 'acme/api';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b9';
const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a9';
const USER_ID = '00000000-0000-4000-8000-00000000f002';
const HOST = 'https://gitlab.example.test';
const SHA = '1111111111111111111111111111111111111111';
const MAIN_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const projectBlock = {
  id: 1,
  name: 'api',
  web_url: `${HOST}/acme/api`,
  path_with_namespace: PROJECT,
  default_branch: 'main',
};

const user = {
  id: 77,
  name: 'Dana Reviewer',
  username: 'dana.reviewer',
  email: 'dana.reviewer@example.test',
};

const context = (resolve: InboundContext['resolveUser'] = () => null): InboundContext => ({
  projectId: PROJECT_ID,
  integrationId: INTEGRATION_ID,
  resolveUser: resolve,
});

const deps = (
  thread: { id: string; resolved: boolean } | null = {
    id: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd',
    resolved: false,
  },
  project: string | null = PROJECT,
  redactor: SecretRedactor = noSecretsRedactor(),
) => ({
  project,
  findThreadForNote: async () => thread,
  // Required (standing rule 31): a test that does not care still says which redactor it means.
  // The one that *does* care is `emitted-secrets.test.ts`, which drives this path through the real
  // registration with the binding's own webhook token planted in the delivery.
  redactor,
});

const normalise = async (
  body: unknown,
  options: {
    readonly ctx?: InboundContext;
    readonly deps?: ReturnType<typeof deps>;
  } = {},
): Promise<NormalisedDelivery<GitProviderInboundEvent>> =>
  normaliseGitLabDelivery(
    { headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) },
    options.ctx ?? context(),
    options.deps ?? deps(),
  );

/** Parses the event against the strict catalogue schema and returns the payload. */
const catalogued = (
  result: NormalisedDelivery<GitProviderInboundEvent>,
  type: string,
): Record<string, unknown> => {
  expect(result.ignored, `expected exactly one ${type}`).toEqual([]);
  expect(result.events.length).toBe(1);
  const event = result.events[0] as { type: string; payload: unknown; actor: unknown };
  expect(event.type).toBe(type);
  const schema = domainEventSchemasByType[type as keyof typeof domainEventSchemasByType];
  schema.shape.actor.parse(event.actor);
  return schema.shape.payload.parse(event.payload) as Record<string, unknown>;
};

const mergeRequestHook = (overrides: Record<string, unknown> = {}): unknown => ({
  object_kind: 'merge_request',
  event_type: 'merge_request',
  user,
  project: projectBlock,
  labels: [],
  object_attributes: {
    id: 93,
    iid: 16,
    title: 'Add input validation to booking form',
    description: 'This MR adds input validation.',
    source_branch: 'agentic/task-1',
    target_branch: 'main',
    state: 'opened',
    action: 'open',
    draft: false,
    merge_status: 'checking',
    updated_at: '2026-06-01T07:59:00.000Z',
    url: `${HOST}/acme/api/-/merge_requests/16`,
    last_commit: { id: SHA, message: 'Add email format validation' },
    ...overrides,
  },
});

const noteHook = (overrides: Record<string, unknown> = {}): unknown => ({
  object_kind: 'note',
  event_type: 'note',
  user,
  project_id: 1,
  project: projectBlock,
  object_attributes: {
    id: 1244,
    internal: false,
    note: 'This MR needs work.',
    noteable_type: 'MergeRequest',
    author_id: 77,
    created_at: '2026-06-01 07:30:00 UTC',
    updated_at: '2026-06-01 07:30:00 UTC',
    project_id: 1,
    attachment: null,
    line_code: null,
    commit_id: '',
    noteable_id: 93,
    system: false,
    st_diff: null,
    action: 'create',
    url: `${HOST}/acme/api/-/merge_requests/16#note_1244`,
    ...overrides,
  },
  merge_request: {
    id: 93,
    iid: 16,
    title: 'Add input validation',
    state: 'opened',
    source_branch: 'agentic/task-1',
    target_branch: 'main',
    last_commit: { id: SHA },
  },
});

const pipelineHook = (overrides: Record<string, unknown> = {}): unknown => ({
  object_kind: 'pipeline',
  project: projectBlock,
  object_attributes: {
    id: 31,
    iid: 3,
    ref: 'agentic/task-1',
    tag: false,
    sha: SHA,
    source: 'merge_request_event',
    status: 'failed',
    stages: ['test'],
    created_at: '2026-06-01 07:10:00 UTC',
    finished_at: '2026-06-01 07:12:00 UTC',
    duration: 63,
    url: `${HOST}/acme/api/-/pipelines/31`,
    ...overrides,
  },
  merge_request: {
    id: 93,
    iid: 16,
    title: 'Add input validation',
    source_branch: 'agentic/task-1',
    target_branch: 'main',
    url: `${HOST}/acme/api/-/merge_requests/16`,
  },
  builds: [
    { id: 376, stage: 'test', name: 'lint', status: 'success', allow_failure: false },
    { id: 378, stage: 'test', name: 'test:unit', status: 'failed', allow_failure: false },
    { id: 380, stage: 'test', name: 'flaky', status: 'failed', allow_failure: true },
  ],
});

const pushHook = (overrides: Record<string, unknown> = {}): unknown => ({
  object_kind: 'push',
  event_name: 'push',
  before: SHA,
  after: MAIN_SHA,
  ref: 'refs/heads/main',
  checkout_sha: MAIN_SHA,
  project: projectBlock,
  ...overrides,
});

describe('merge request hooks', () => {
  it.each([
    ['open', 'mr.opened'],
    ['reopen', 'mr.opened'],
    ['update', 'mr.updated'],
    ['close', 'mr.closed'],
  ])('maps action %s to %s', async (action, type) => {
    const payload = catalogued(await normalise(mergeRequestHook({ action })), type);
    expect(payload.head_sha).toBe(SHA);
    expect((payload.mr as { iid: number }).iid).toBe(16);
    expect(payload.draft).toBe(false);
    expect(payload.diff_stats, 'GitLab publishes no insertion/deletion counts').toBeNull();
  });

  it('maps merge to mr.merged and carries the merge commit', async () => {
    const payload = catalogued(
      await normalise(
        mergeRequestHook({ action: 'merge', state: 'merged', merge_commit_sha: MAIN_SHA }),
      ),
      'mr.merged',
    );
    expect(payload.merge_commit_sha).toBe(MAIN_SHA);
  });

  it('carries the draft flag from the documented `draft` attribute', async () => {
    const payload = catalogued(await normalise(mergeRequestHook({ draft: true })), 'mr.opened');
    expect(payload.draft).toBe(true);
  });

  it.each(['approval', 'approved', 'unapproval', 'unapproved'])(
    'drops the %s action, which the catalogue has no event for',
    async (action) => {
      const result = await normalise(mergeRequestHook({ action }));
      expect(result.events).toEqual([]);
      expect(result.ignored[0]?.reason).toBe('unsupported_event');
      expect(result.ignored[0]?.detail).toContain(action);
    },
  );

  it('reports a delivery with no last_commit as malformed rather than inventing a sha', async () => {
    const result = await normalise(mergeRequestHook({ last_commit: null }));
    expect(result.ignored[0]?.reason).toBe('malformed_payload');
    expect(result.ignored[0]?.detail).toContain('last_commit');
  });
});

describe('note hooks', () => {
  it('normalises a review comment with the author identity resolved', async () => {
    const payload = catalogued(
      await normalise(noteHook(), { ctx: context(() => USER_ID) }),
      'mr.review.comment',
    );
    expect(payload.text).toBe('This MR needs work.');
    expect((payload.author as { verified: boolean }).verified).toBe(true);
    expect((payload.author as { external_id: string }).external_id).toBe('77');
    expect(payload.thread_id).toBe('aa11bb22cc33dd44ee55ff6677889900aabbccdd');
    expect(payload.resolved).toBe(false);
  });

  it('records an unmapped author rather than dropping the comment (BD-022)', async () => {
    // A comment is data, not a decision: it is recorded with `verified: false`, where an *answer*
    // or an *approval* from an unmapped identity would be dropped.
    const payload = catalogued(await normalise(noteHook()), 'mr.review.comment');
    expect((payload.author as { verified: boolean }).verified).toBe(false);
  });

  it('takes the fragment off the note URL to get the merge request URL', async () => {
    const payload = catalogued(await normalise(noteHook()), 'mr.review.comment');
    expect((payload.mr as { url: string }).url).toBe(`${HOST}/acme/api/-/merge_requests/16`);
  });

  it('reports the thread as resolved when the looked-up note is', async () => {
    const payload = catalogued(
      await normalise(noteHook(), { deps: deps({ id: 'thread-1', resolved: true }) }),
      'mr.review.comment',
    );
    expect(payload.resolved).toBe(true);
  });

  /**
   * The documented "Comment on a merge request" payload carries no `discussion_id`, so the thread
   * is looked up. When the lookup finds nothing the delivery is dropped loudly — an invented
   * `note-<id>` would satisfy the catalogue schema and then fail the first time WP-15 replied
   * to it.
   */
  it('drops a note that belongs to no discussion instead of inventing a thread id', async () => {
    const result = await normalise(noteHook(), { deps: deps(null) });
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.reason).toBe('malformed_payload');
    expect(result.ignored[0]?.detail).toContain('belongs to no discussion');
  });

  it('drops a system note', async () => {
    const result = await normalise(noteHook({ system: true }));
    expect(result.ignored[0]).toEqual({ reason: 'unsupported_event', detail: 'system note' });
  });

  it('drops a note on anything other than a merge request', async () => {
    const result = await normalise(noteHook({ noteable_type: 'Issue' }));
    expect(result.ignored[0]?.reason).toBe('unsupported_event');
    expect(result.ignored[0]?.detail).toContain('Issue');
  });
});

describe('pipeline hooks', () => {
  it('normalises a finished pipeline with its failing jobs', async () => {
    const payload = catalogued(await normalise(pipelineHook()), 'ci.pipeline.finished');
    expect(payload.head_sha).toBe(SHA);
    expect(payload.status).toBe('failed');
    expect((payload.failed_jobs as { name: string }[]).map((job) => job.name)).toEqual([
      'test:unit',
    ]);
    expect(
      (payload.failed_jobs as { log_ref: string }[])[0]?.log_ref,
      'the log handle is the numeric job id',
    ).toBe('378');
    expect(
      payload.coverage_pct,
      'the documented Pipeline Hook publishes no coverage on the pipeline or on a build',
    ).toBeNull();
  });

  it('excludes an allow_failure job from failed_jobs', async () => {
    const payload = catalogued(await normalise(pipelineHook()), 'ci.pipeline.finished');
    expect((payload.failed_jobs as { name: string }[]).map((job) => job.name)).not.toContain(
      'flaky',
    );
  });

  it.each(['running', 'pending', 'created', 'manual'])(
    'drops a %s pipeline, because the event is ci.pipeline.finished',
    async (status) => {
      const result = await normalise(pipelineHook({ status }));
      expect(result.events).toEqual([]);
      expect(result.ignored[0]?.reason).toBe('unsupported_event');
    },
  );

  it.each(['success', 'canceled', 'skipped'])('accepts terminal status %s', async (status) => {
    const payload = catalogued(await normalise(pipelineHook({ status })), 'ci.pipeline.finished');
    expect(payload.status).toBe(status);
  });

  /**
   * WP-09 review round 1, should-fix 1. GitLab adds pipeline statuses (`waiting_for_callback` and
   * `canceling` are both recent), and a normaliser that *throws* on one turns every delivery of
   * the vendor's new feature into a job that fails for ever. Fail closed on a mutation the
   * platform initiates; ignore-with-a-reason on a notification the vendor pushes.
   */
  it('ignores a pipeline status it has never heard of rather than failing the delivery', async () => {
    // Caught rather than awaited: the failure being pinned is a *throw*, so it has to be reachable
    // by an assertion with a name instead of blowing the test up as an unhandled rejection.
    const outcome = await normalise(pipelineHook({ status: 'waiting_for_quantum_runner' })).then(
      (value) => value,
      (error: unknown) => error,
    );
    expect(
      outcome,
      'normalise must not throw for a status GitLab added: the delivery would fail for ever',
    ).not.toBeInstanceOf(Error);
    const result = outcome as Awaited<ReturnType<typeof normalise>>;
    expect(result.events, 'an unknown status produces no event').toEqual([]);
    expect(
      result.ignored[0]?.reason,
      'and it is an ignored delivery, not an IntegrationError that a retry can never clear',
    ).toBe('unsupported_event');
    expect(
      result.ignored[0]?.detail,
      'the drop names the status, so a new GitLab state is one grep away',
    ).toContain('waiting_for_quantum_runner');
  });

  it('does not let an unknown status through as a finished pipeline', async () => {
    const result = await normalise(pipelineHook({ status: 'waiting_for_quantum_runner' }));
    expect(
      result.events.map((event) => event.type),
      'ignoring it must not become "treat it as success"',
    ).toEqual([]);
  });
});

describe('push hooks', () => {
  it('maps a push onto the default branch to default_branch.moved', async () => {
    const payload = catalogued(await normalise(pushHook()), 'default_branch.moved');
    expect(payload.branch).toBe('main');
    expect(payload.new_head).toBe(MAIN_SHA);
  });

  it('drops a push onto any other branch', async () => {
    const result = await normalise(pushHook({ ref: 'refs/heads/agentic/task-1' }));
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.reason).toBe('unsupported_event');
    expect(result.ignored[0]?.detail).toContain('agentic/task-1');
  });

  it('drops a branch deletion, whose `after` is all zeroes', async () => {
    const result = await normalise(pushHook({ after: '0'.repeat(40) }));
    expect(result.ignored[0]).toEqual({ reason: 'unsupported_event', detail: 'branch deletion' });
  });

  it('reports a push with no default_branch as malformed', async () => {
    const result = await normalise(
      pushHook({ project: { ...projectBlock, default_branch: null } }),
    );
    expect(result.ignored[0]?.reason).toBe('malformed_payload');
  });
});

describe('routing and malformed input', () => {
  it('rejects a delivery about another project', async () => {
    const result = await normalise({
      ...(mergeRequestHook() as Record<string, unknown>),
      project: { ...projectBlock, path_with_namespace: 'acme/other' },
    });
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.reason).toBe('not_for_this_project');
    expect(result.ignored[0]?.detail).toContain('acme/other');
  });

  it('accepts any project when the binding names none', async () => {
    const result = await normalise(
      {
        ...(mergeRequestHook() as Record<string, unknown>),
        project: { ...projectBlock, path_with_namespace: 'acme/other' },
      },
      { deps: deps(undefined, null) },
    );
    expect(result.ignored).toEqual([]);
    expect(result.events.length).toBe(1);
  });

  it('reports a body that is not JSON', async () => {
    const result = await normalise('not json at all');
    expect(result.ignored[0]).toEqual({
      reason: 'malformed_payload',
      detail: 'delivery body is not JSON',
    });
  });

  it('reports a kind it handles but cannot parse as malformed', async () => {
    const result = await normalise({ object_kind: 'merge_request', object_attributes: {} });
    expect(result.ignored[0]?.reason).toBe('malformed_payload');
  });

  /**
   * A wiki, release or member hook is a subscription nobody wanted, not a defect. Calling it
   * malformed would hide a real parse failure in the same bucket.
   */
  it.each(['wiki_page', 'release', 'deployment', 'issue'])(
    'reports the unhandled kind %s as unsupported, not malformed',
    async (kind) => {
      const result = await normalise({ object_kind: kind });
      expect(result.ignored[0]?.reason).toBe('unsupported_event');
      expect(result.ignored[0]?.detail).toContain(kind);
    },
  );

  it('reports a delivery with no object_kind at all', async () => {
    const result = await normalise({ hello: 'world' });
    expect(result.ignored[0]).toEqual({
      reason: 'malformed_payload',
      detail: 'delivery carries no object_kind',
    });
  });
});
