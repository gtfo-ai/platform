/**
 * The coalescer's own branches (WP-59, backlog 64): what shares a read, what does not, and the two
 * bounds. The saving as a *count* at a real gate entry is asserted in `conflict-warning.test.ts`.
 */
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { FileDiff, GitProviderPort } from '../ports/integrations/git-provider.js';
import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
} from '../testing/memory-integrations.js';
import {
  coalescedMergeRequestDiff,
  createMergeRequestDiffCoalescer,
  DIFF_COALESCE_WINDOW_MS,
  diffCoalescerFor,
} from './diff-coalescer.js';
import {
  type PipelineIntegrations,
  type PipelineIntegrationsPort,
  staticPipelineIntegrations,
} from './integrations.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK_A = '00000000-0000-4000-8000-0000000000c1' as Id;
const TASK_B = '00000000-0000-4000-8000-0000000000c2' as Id;
const AT = '2026-06-01T09:00:00.000Z';

const file = (path: string): FileDiff => ({
  new_path: path,
  old_path: path,
  diff: '@@ -1 +1 @@\n-a\n+b\n',
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  omitted: false,
});

const ref = (iid: number, headSha: string | null) => ({
  provider: 'fake-git',
  project_path: 'acme/api',
  iid,
  url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
  branch: null,
  head_sha: headSha,
});

const compose = (): {
  readonly port: PipelineIntegrationsPort;
  readonly integrations: PipelineIntegrations;
  readonly reads: number[];
} => {
  const reads: number[] = [];
  const git = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a001',
      provider: 'fake-git',
      type: 'git',
    },
    getMergeRequestDiff: async (asked: { iid: number }) => {
      reads.push(asked.iid);
      return [file(`src/${asked.iid}.ts`)];
    },
  } as unknown as GitProviderPort;
  const integrations: PipelineIntegrations = {
    executor: createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog: createMemoryAuditLog(),
      redactor: exactSecretRedactor([]),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => AT },
      idempotencyStore: createMemoryIdempotencyStore(),
    }),
    git: { port: git, ref: git.ref, project: 'acme/api', redactor: exactSecretRedactor([]) },
    taskManagement: null,
    communication: null,
  };
  return { port: staticPipelineIntegrations(integrations), integrations, reads };
};

describe('coalescedMergeRequestDiff', () => {
  it('reads a merge request once per revision, whichever task asks', async () => {
    const { port, integrations, reads } = compose();
    const input = { port, integrations, now: AT };
    const first = await coalescedMergeRequestDiff(input, ref(7, 'a'.repeat(40)), 100, {
      projectId: PROJECT,
      taskId: TASK_A,
    });
    // The peer's comparison: another task, the same merge request, the same revision.
    const second = await coalescedMergeRequestDiff(input, ref(7, 'a'.repeat(40)), 100, {
      projectId: PROJECT,
      taskId: TASK_B,
    });
    expect(reads).toEqual([7]);
    expect(second).toEqual(first);
    // A copy, so one duty cannot change what the next one is served.
    expect(second).not.toBe(first);
  });

  it('reads again for a new revision, a different limit, or a ref with no head sha', async () => {
    const { port, integrations, reads } = compose();
    const input = { port, integrations, now: AT };
    const context = { projectId: PROJECT, taskId: TASK_A };
    await coalescedMergeRequestDiff(input, ref(7, 'a'.repeat(40)), 100, context);
    await coalescedMergeRequestDiff(input, ref(7, 'b'.repeat(40)), 100, context);
    await coalescedMergeRequestDiff(input, ref(7, 'b'.repeat(40)), 50, context);
    // No revision, no identity: never served from memory, however often it is asked.
    await coalescedMergeRequestDiff(input, ref(7, null), 100, context);
    await coalescedMergeRequestDiff(input, ref(7, null), 100, context);
    expect(reads).toEqual([7, 7, 7, 7, 7]);
  });

  it('answers null for a project with no git binding, like the read it wraps', async () => {
    const { integrations } = compose();
    const bare: PipelineIntegrations = { ...integrations, git: null };
    expect(
      await coalescedMergeRequestDiff(
        { port: staticPipelineIntegrations(bare), integrations: bare, now: AT },
        ref(7, 'a'.repeat(40)),
        100,
        { projectId: PROJECT, taskId: TASK_A },
      ),
    ).toBeNull();
  });

  it('keeps one coalescer per integrations port', () => {
    const { port } = compose();
    expect(diffCoalescerFor(port)).toBe(diffCoalescerFor(port));
    expect(diffCoalescerFor(compose().port)).not.toBe(diffCoalescerFor(port));
  });
});

describe('createMergeRequestDiffCoalescer', () => {
  const answer = async () => [file('src/a.ts')];

  it('serves a concurrent asker from the request already in flight', async () => {
    const coalescer = createMergeRequestDiffCoalescer();
    let performed = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const perform = async () => {
      performed += 1;
      await gate;
      return [file('src/a.ts')];
    };
    const both = Promise.all([coalescer.read('k', 0, perform), coalescer.read('k', 0, perform)]);
    release();
    const [left, right] = await both;
    expect(performed).toBe(1);
    expect(left).toEqual(right);
  });

  it('reads again once the window has passed', async () => {
    const coalescer = createMergeRequestDiffCoalescer();
    let performed = 0;
    const perform = async () => {
      performed += 1;
      return answer();
    };
    await coalescer.read('k', 0, perform);
    await coalescer.read('k', DIFF_COALESCE_WINDOW_MS - 1, perform);
    expect(performed).toBe(1);
    await coalescer.read('k', DIFF_COALESCE_WINDOW_MS, perform);
    expect(performed).toBe(2);
  });

  it('holds no more than its bound, dropping the oldest', async () => {
    const coalescer = createMergeRequestDiffCoalescer({ maxEntries: 2 });
    let performed = 0;
    const perform = async () => {
      performed += 1;
      return answer();
    };
    await coalescer.read('a', 0, perform);
    await coalescer.read('b', 0, perform);
    await coalescer.read('c', 0, perform);
    expect(coalescer.size()).toBe(2);
    await coalescer.read('c', 0, perform);
    expect(performed).toBe(3);
    await coalescer.read('a', 0, perform);
    expect(performed).toBe(4);
  });

  it('remembers no empty answer, because the provider may not have computed the diff yet', async () => {
    const coalescer = createMergeRequestDiffCoalescer();
    let performed = 0;
    const answers: (readonly FileDiff[])[] = [[], [file('src/a.ts')]];
    const perform = async () => {
      const next = answers[Math.min(performed, answers.length - 1)] ?? [];
      performed += 1;
      return next;
    };
    expect(await coalescer.read('k', 0, perform)).toEqual([]);
    expect(coalescer.size()).toBe(0);
    // The next asker reads again and gets the diff GitLab has computed by now — which is then held.
    expect(await coalescer.read('k', 0, perform)).toEqual([file('src/a.ts')]);
    expect(await coalescer.read('k', 0, perform)).toEqual([file('src/a.ts')]);
    expect(performed).toBe(2);
  });

  it('remembers no failure: the next asker makes the request again', async () => {
    const coalescer = createMergeRequestDiffCoalescer();
    await expect(
      coalescer.read('k', 0, async () => {
        throw new Error('provider unavailable');
      }),
    ).rejects.toThrow('provider unavailable');
    expect(coalescer.size()).toBe(0);
    expect(await coalescer.read('k', 0, answer)).toEqual([file('src/a.ts')]);
  });
});
