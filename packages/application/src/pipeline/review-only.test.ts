/**
 * Review-only mode, driven through the real handlers, the real interpreter, the real stage executor
 * and the real `IntegrationActionExecutor` over the in-memory doubles (WP-24).
 *
 * The e2e tier runs the same thing on PostgreSQL with a signed delivery and a real `apps/server`;
 * this tier is where the **branches** live — a project with the feature off, a merge request the
 * filter refuses, a diff the platform could not read, a severity floor, a cap, a planted credential,
 * and the redelivery that must post nothing twice.
 *
 * Nothing here asserts through the runner: it is scripted per stage and never reads the prompt
 * (standing rule 82). What reaches the model is asserted on the **assembled prompt** — which this
 * harness exposes as `harness.specs` — and on the stored row.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { readDataBlocks } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor, noSecretsRedactor } from '../integrations/redaction.js';
import type { Discussion, MergeRequest } from '../ports/integrations/git-provider.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import {
  boundMergeRequestSnapshot,
  MAX_MR_DESCRIPTION_CHARS,
  MAX_MR_FILE_DIFF_CHARS,
  MAX_MR_FILES,
  MAX_MR_LABELS,
  MAX_MR_REF_CHARS,
  MAX_MR_TITLE_CHARS,
  MAX_REVIEW_DIFF_CHARS,
  MERGE_REQUEST_SNAPSHOT_MAX_TEXT_CHARS,
  REVIEW_ONLY_TEMPLATE_ID,
  REVIEW_ONLY_TICKET_PROVIDER,
  REVIEW_SUMMARY_PREAMBLE,
  renderSummary,
  reviewFindingIdempotencyKey,
  reviewMarkerFor,
  reviewSummaryMarkerFor,
  reviewTicketKeyFor,
} from './review-only.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const IID = 7;
const MR_URL = `https://git.example.test/acme/api/-/merge_requests/${IID}`;
const HEAD = 'b'.repeat(40);

/** An obviously fake credential (BD-002), planted so the redaction assertions have a target. */
const PLANTED = 'FAKE-git-token-not-a-real-secret-0000';
const PLACEHOLDER = '[REDACTED:integration:git_token]';

const mergeRequest = (overrides: Partial<MergeRequest> = {}): MergeRequest =>
  ({
    ref: {
      provider: 'fake-git',
      project_path: 'acme/api',
      iid: IID,
      url: MR_URL,
      branch: 'fix/footer',
      head_sha: HEAD,
    },
    state: 'opened',
    draft: false,
    title: 'Sum the invoice footer',
    description: 'Closes the footer bug.',
    source_branch: 'fix/footer',
    target_branch: 'main',
    head_sha: HEAD,
    mergeable: true,
    has_conflicts: false,
    labels: ['agentic-review'],
    reviewers: [],
    web_url: MR_URL,
    ...overrides,
  }) as MergeRequest;

const fileDiff = (path: string, diff = `@@ -1 +1 @@\n-old\n+new in ${path}\n`) => ({
  new_path: path,
  old_path: path,
  diff,
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  omitted: false,
});

const REVIEW = (overrides: Record<string, unknown> = {}) => ({
  verdict: 'request_changes',
  findings: [
    {
      id: 'f1',
      severity: 'blocker',
      category: 'correctness',
      file: 'src/totals.ts',
      line: 3,
      explanation: 'The footer still sums the visible rows.',
      suggestion: 'Sum the model.',
    },
    {
      id: 'f2',
      severity: 'nit',
      category: 'conventions',
      file: 'src/totals.ts',
      line: 9,
      explanation: 'A trailing space.',
      suggestion: null,
    },
  ],
  summary: 'One real problem and one nit.',
  protected_path_changes_confirmed: [],
  ...overrides,
});

interface Posted {
  readonly path: string | null;
  readonly line: number | null;
  readonly markdown: string;
}

const reviewHarness = (
  options: {
    readonly enabled?: boolean;
    readonly trigger?: 'label' | 'all' | 'paths';
    readonly paths?: readonly string[];
    readonly severityFloor?: 'blocker' | 'major' | 'minor' | 'nit';
    readonly maxFindings?: number;
    readonly mr?: Partial<MergeRequest>;
    readonly files?: readonly ReturnType<typeof fileDiff>[];
    readonly diffThrows?: boolean;
    readonly review?: Record<string, unknown>;
    readonly discussions?: readonly Discussion[];
    readonly harness?: HarnessOptions;
  } = {},
): { harness: PipelineHarness; posted: Posted[]; openedMrs: number } => {
  const posted: Posted[] = [];
  const counters = { openedMrs: 0 };
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: {
      code_review: {
        status: 'completed',
        terminalReason: 'success',
        structuredOutput: options.review ?? REVIEW(),
      },
    },
    settings: {
      config: {
        features: {
          review_only: {
            enabled: options.enabled ?? true,
            trigger: options.trigger ?? 'label',
            label: 'agentic-review',
            ...(options.paths === undefined ? {} : { paths: [...options.paths] }),
            ...(options.severityFloor === undefined
              ? {}
              : { severity_floor: options.severityFloor }),
            ...(options.maxFindings === undefined ? {} : { max_findings: options.maxFindings }),
          },
        },
      },
    },
    // The binding's own redactor, armed: a disarmed one proves nothing (standing rules 31, 35).
    gitRedactor: exactSecretRedactor([{ name: 'git_token', value: PLANTED }]),
    git: {
      getMergeRequest: async () => mergeRequest(options.mr),
      getMergeRequestDiff: async () => {
        if (options.diffThrows === true) {
          throw new Error('the provider refused the diff');
        }
        return options.files ?? [fileDiff('src/totals.ts')];
      },
      listDiscussions: async () => options.discussions ?? [],
      createDiscussion: async (_ref, note) => {
        posted.push({
          path: note.path ?? null,
          line: note.line ?? null,
          markdown: note.markdown,
        });
        return {
          id: `disc-${posted.length}`,
          resolvable: true,
          resolved: false,
          notes: [],
        } as Discussion;
      },
      openMergeRequest: async () => {
        counters.openedMrs += 1;
        throw new Error('review-only mode must never open a merge request');
      },
    },
    ...options.harness,
  });
  return {
    harness,
    posted,
    get openedMrs() {
      return counters.openedMrs;
    },
  };
};

let stream = 0;

const event = <T extends DomainEvent['type']>(
  type: T,
  payload: Extract<DomainEvent, { type: T }>['payload'],
): DomainEvent => {
  stream += 1;
  const suffix = stream.toString(16).padStart(12, '0');
  return domainEventSchemasByType[type].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: 'project',
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-git' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type,
    payload,
  }) as DomainEvent;
};

const mrEvent = (type: 'mr.opened' | 'mr.merged' | 'mr.closed', deliveryOverrides = {}) =>
  event(type, {
    project_id: PROJECT,
    task_id: null,
    mr: {
      provider: 'fake-git',
      project_path: 'acme/api',
      iid: IID,
      url: MR_URL,
      branch: 'fix/footer',
      head_sha: HEAD,
    },
    draft: false,
    head_sha: HEAD,
    diff_stats: null,
    ...deliveryOverrides,
  } as never);

const reviewTask = (harness: PipelineHarness) =>
  harness.store.snapshot().find((task) => task.task.template === REVIEW_ONLY_TEMPLATE_ID);

// ── The snapshot ─────────────────────────────────────────────────────────────

describe('the snapshot a merge request is bounded into', () => {
  it('keeps the merge request’s own words and says nothing was cut when nothing was', () => {
    const snapshot = boundMergeRequestSnapshot(
      mergeRequest(),
      [fileDiff('src/totals.ts')],
      noSecretsRedactor(),
    );
    expect(snapshot.title).toBe('Sum the invoice footer');
    expect(snapshot.source_branch).toBe('fix/footer');
    expect(snapshot.labels).toEqual(['agentic-review']);
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]?.diff).toContain('+new in src/totals.ts');
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.file_count).toBe(1);
    expect(snapshot.redaction_count).toBe(0);
  });

  it('cuts every field at its own cap and announces the cut once', () => {
    const snapshot = boundMergeRequestSnapshot(
      mergeRequest({
        title: 'T'.repeat(MAX_MR_TITLE_CHARS + 50),
        description: 'D'.repeat(MAX_MR_DESCRIPTION_CHARS + 50),
        source_branch: 'b'.repeat(MAX_MR_REF_CHARS + 50),
        labels: Array.from({ length: MAX_MR_LABELS + 5 }, (_, at) => `label-${at}`),
      }),
      [fileDiff('src/totals.ts', 'x'.repeat(MAX_MR_FILE_DIFF_CHARS + 50))],
      noSecretsRedactor(),
    );
    expect(snapshot.title).toHaveLength(MAX_MR_TITLE_CHARS);
    expect(snapshot.description).toHaveLength(MAX_MR_DESCRIPTION_CHARS);
    expect(snapshot.source_branch).toHaveLength(MAX_MR_REF_CHARS);
    expect(snapshot.labels).toHaveLength(MAX_MR_LABELS);
    expect(snapshot.files[0]?.diff).toHaveLength(MAX_MR_FILE_DIFF_CHARS);
    expect(snapshot.files[0]?.truncated).toBe(true);
    expect(snapshot.truncated).toBe(true);
  });

  it('drops files past the file cap and keeps `file_count` honest about how many there were', () => {
    const files = Array.from({ length: MAX_MR_FILES + 7 }, (_, at) => fileDiff(`src/f${at}.ts`));
    const snapshot = boundMergeRequestSnapshot(mergeRequest(), files, noSecretsRedactor());
    expect(snapshot.files).toHaveLength(MAX_MR_FILES);
    expect(snapshot.file_count).toBe(MAX_MR_FILES + 7);
    expect(snapshot.truncated).toBe(true);
  });

  it('spends one whole-diff budget across the files, in the provider’s order', () => {
    const files = Array.from({ length: MAX_MR_FILES }, (_, at) =>
      fileDiff(`src/f${at}.ts`, 'y'.repeat(MAX_MR_FILE_DIFF_CHARS)),
    );
    const snapshot = boundMergeRequestSnapshot(mergeRequest(), files, noSecretsRedactor());
    const total = snapshot.files.reduce((sum, file) => sum + file.diff.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_REVIEW_DIFF_CHARS);
    expect(snapshot.files.length).toBeLessThan(MAX_MR_FILES);
    expect(snapshot.files[0]?.path).toBe('src/f0.ts');
    expect(snapshot.truncated).toBe(true);
  });

  it('keeps a file the provider excluded as a named absence, not as an empty change', () => {
    const snapshot = boundMergeRequestSnapshot(
      mergeRequest(),
      [{ ...fileDiff('src/huge.bin'), diff: null, omitted: true }],
      noSecretsRedactor(),
    );
    expect(snapshot.files[0]?.omitted).toBe(true);
    expect(snapshot.files[0]?.diff).toBe('');
  });

  /**
   * Redact **then** cut, which is the ordering an exact-match redactor depends on.
   *
   * The credential sits at the very end of a description that is longer than the cap, so a cut
   * applied first would leave the redactor nothing to find — and the mutation that reverses the two
   * lines fails here rather than in production.
   */
  it('redacts before it cuts, so a credential at the far end of a long description is still found', () => {
    const redactor = exactSecretRedactor([{ name: 'git_token', value: PLANTED }]);
    const description = `${'D'.repeat(MAX_MR_DESCRIPTION_CHARS - 10)}${PLANTED}`;
    const snapshot = boundMergeRequestSnapshot(
      mergeRequest({ description }),
      [fileDiff('src/totals.ts', `secret ${PLANTED}`)],
      redactor,
    );
    expect(snapshot.description).not.toContain(PLANTED);
    expect(snapshot.files[0]?.diff).toContain(PLACEHOLDER);
    expect(snapshot.files[0]?.diff).not.toContain(PLANTED);
    // The count is over the text as it was **read**, so a snapshot whose secret was cut off still
    // says one was there.
    expect(snapshot.redaction_count).toBe(2);
  });

  it('pins the worst-case character budget rather than quoting it', () => {
    expect(MERGE_REQUEST_SNAPSHOT_MAX_TEXT_CHARS).toBe(
      MAX_MR_TITLE_CHARS +
        MAX_MR_DESCRIPTION_CHARS +
        3 * MAX_MR_REF_CHARS +
        MAX_MR_LABELS * MAX_MR_REF_CHARS +
        MAX_REVIEW_DIFF_CHARS,
    );
    expect(MERGE_REQUEST_SNAPSHOT_MAX_TEXT_CHARS).toBe(106_400);
  });
});

// ── The trigger ──────────────────────────────────────────────────────────────

describe('a human merge request opening', () => {
  it('creates a review-only task, runs the reviewer alone and finishes', async () => {
    const { harness, posted } = reviewHarness();
    await harness.publish([mrEvent('mr.opened')]);

    const task = reviewTask(harness);
    expect(task).toBeDefined();
    expect(task?.task.template).toBe(REVIEW_ONLY_TEMPLATE_ID);
    expect(task?.task.state).toBe('done');
    expect(task?.task.ticket).toEqual({
      provider: REVIEW_ONLY_TICKET_PROVIDER,
      key: reviewTicketKeyFor(IID),
      url: MR_URL,
    });
    // The merge request is the *subject*, not the task's own work (see the module docblock).
    expect(task?.mr).toBeNull();
    expect(task?.reviewSubject?.title).toBe('Sum the invoice footer');

    // Exactly one run, and it is the reviewer's.
    expect(harness.specs.map((spec) => spec.stage)).toEqual(['code_review']);
    expect(harness.specs[0]?.role).toBe('reviewer');
    // technical/04's mode table, recorded on the run rather than described in a comment.
    expect(harness.specs[0]?.mode).toBe('review_only');
    expect(posted.length).toBeGreaterThan(0);
  });

  it('puts the diff in the prompt, inside a data block', async () => {
    const { harness } = reviewHarness();
    await harness.publish([mrEvent('mr.opened')]);
    const spec = harness.specs[0];
    expect(spec).toBeDefined();
    const reading = readDataBlocks(spec?.userPrompt ?? '');
    const block = reading.blocks.find((entry) => entry.kind === 'merge_request');
    expect(block?.body).toContain('+new in src/totals.ts');
    expect(block?.body).toContain('title: Sum the invoice footer');
    expect(reading.platformVoice.join('')).not.toContain('Sum the invoice footer');
  });

  it('does nothing at all when the project has not enabled the mode', async () => {
    const { harness, posted } = reviewHarness({ enabled: false });
    await harness.publish([mrEvent('mr.opened')]);
    expect(reviewTask(harness)).toBeUndefined();
    expect(harness.specs).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it('does nothing when the label filter does not match, and everything when it does', async () => {
    const miss = reviewHarness({ mr: { labels: ['bug'] } });
    await miss.harness.publish([mrEvent('mr.opened')]);
    expect(reviewTask(miss.harness)).toBeUndefined();
    expect(miss.posted).toHaveLength(0);

    const hit = reviewHarness({ mr: { labels: ['bug', 'agentic-review'] } });
    await hit.harness.publish([mrEvent('mr.opened')]);
    expect(reviewTask(hit.harness)).toBeDefined();
  });

  it('matches on a changed path when the project triggers on paths, and refuses otherwise', async () => {
    const hit = reviewHarness({
      trigger: 'paths',
      paths: ['src/**'],
      mr: { labels: [] },
      files: [fileDiff('src/totals.ts')],
    });
    await hit.harness.publish([mrEvent('mr.opened')]);
    expect(reviewTask(hit.harness)).toBeDefined();

    const miss = reviewHarness({
      trigger: 'paths',
      paths: ['docs/**'],
      mr: { labels: [] },
      files: [fileDiff('src/totals.ts')],
    });
    await miss.harness.publish([mrEvent('mr.opened')]);
    expect(reviewTask(miss.harness)).toBeUndefined();
  });

  it('reviews every merge request under `all`, label or no label', async () => {
    const { harness } = reviewHarness({ trigger: 'all', mr: { labels: [] } });
    await harness.publish([mrEvent('mr.opened')]);
    expect(reviewTask(harness)).toBeDefined();
  });

  it('creates nothing for a merge request that is no longer open', async () => {
    const { harness } = reviewHarness({ mr: { state: 'merged' } });
    await harness.publish([mrEvent('mr.opened')]);
    expect(reviewTask(harness)).toBeUndefined();
  });

  /**
   * The diff **is** the input, so a read that fails starts nothing rather than starting a run with
   * nothing to review (standing rule 20's fail-closed direction for a decision to spend).
   */
  it('creates no task when the provider would not give up the diff', async () => {
    const { harness } = reviewHarness({ diffThrows: true });
    await expect(harness.publish([mrEvent('mr.opened')])).rejects.toThrow(/refused the diff/);
    expect(reviewTask(harness)).toBeUndefined();
    expect(harness.specs).toHaveLength(0);
  });

  /**
   * The platform's own merge request, before the platform knows it is its own.
   *
   * `findByMergeRequest` is the first guard and it has a window: the pipeline learns its merge
   * request from the `ImplementationNotes` artifact when the implementation stage commits, and the
   * provider's `mr.opened` delivery can arrive first. The branch namespace is the second guard, and
   * this is the case only it can answer — no task owns the merge request here.
   */
  it('skips a merge request on the platform’s own branch namespace', async () => {
    const { harness, posted } = reviewHarness({
      trigger: 'all',
      mr: { source_branch: 'agentic/acme-1', labels: [] },
    });
    await harness.publish([mrEvent('mr.opened')]);
    expect(reviewTask(harness)).toBeUndefined();
    expect(posted).toHaveLength(0);

    // The other direction (standing rule 42): the same merge request on a human's branch is
    // reviewed, so the guard is the namespace and not the `trigger: all` path being broken.
    const human = reviewHarness({
      trigger: 'all',
      mr: { source_branch: 'human/fix', labels: [] },
    });
    await human.harness.publish([mrEvent('mr.opened')]);
    expect(reviewTask(human.harness)).toBeDefined();
  });

  it('never opens a merge request of its own — product/18 level 0', async () => {
    const review = reviewHarness();
    await review.harness.publish([mrEvent('mr.opened')]);
    expect(review.openedMrs).toBe(0);
  });

  it('creates one task for two deliveries of the same merge request', async () => {
    const { harness, posted } = reviewHarness();
    await harness.publish([mrEvent('mr.opened')]);
    const before = posted.length;
    await harness.publish([mrEvent('mr.opened')]);
    expect(
      harness.store.snapshot().filter((task) => task.task.template === REVIEW_ONLY_TEMPLATE_ID),
    ).toHaveLength(1);
    expect(harness.specs).toHaveLength(1);
    expect(posted).toHaveLength(before);
  });
});

// ── The posted review ────────────────────────────────────────────────────────

describe('the findings and the neutral summary', () => {
  /**
   * The posting handler's other direction (standing rule 42): an ordinary task's `code_review`
   * stage completes all the time, and it must post nothing to anybody's merge request.
   */
  it('posts nothing for a code_review stage that is not a review-only task’s', async () => {
    const posted: Posted[] = [];
    const harness = createPipelineHarness({
      projectId: PROJECT,
      runs: {},
      git: {
        createDiscussion: async (_ref, note) => {
          posted.push({
            path: note.path ?? null,
            line: note.line ?? null,
            markdown: note.markdown,
          });
          return { id: 'x', resolvable: true, resolved: false, notes: [] } as Discussion;
        },
      },
    });
    await harness.publish([
      event('task.stage.completed', {
        project_id: PROJECT,
        task_id: '00000000-0000-4000-8000-00000000dead',
        stage: 'code_review',
        artifacts: [],
        verdict: 'request_changes',
      } as never),
    ]);
    expect(posted).toHaveLength(0);
  });

  it('posts each finding as a thread anchored to its line, and the summary on the merge request', async () => {
    const { harness, posted } = reviewHarness({ severityFloor: 'nit' });
    await harness.publish([mrEvent('mr.opened')]);

    const task = reviewTask(harness);
    const marker = reviewMarkerFor(task?.task.id as Id);
    expect(posted).toHaveLength(3);
    expect(posted[0]).toMatchObject({ path: 'src/totals.ts', line: 3 });
    expect(posted[0]?.markdown).toContain('The footer still sums the visible rows.');
    expect(posted[0]?.markdown).toContain('blocker · correctness');
    expect(posted[0]?.markdown).toContain(marker);
    // The summary is the merge-request-level thread: no path, no line.
    const summary = posted.at(-1);
    expect(summary?.path).toBeNull();
    expect(summary?.line).toBeNull();
    expect(summary?.markdown).toContain(REVIEW_SUMMARY_PREAMBLE);
    expect(summary?.markdown).toContain('One real problem and one nit.');
  });

  /**
   * product/18's *"neutral … never blocks merge"*, asserted on the **shape** rather than on the
   * model's words: the platform says it does not block, and the `verdict` field never reaches the
   * merge request — so a model that wrote `request_changes` cannot make the comment read as a
   * rejection.
   */
  it('says in the platform’s own voice that it does not block, and never posts the verdict', async () => {
    const { harness, posted } = reviewHarness({ review: REVIEW({ verdict: 'request_changes' }) });
    await harness.publish([mrEvent('mr.opened')]);
    const everything = posted.map((entry) => entry.markdown).join('\n');
    expect(everything).toContain('does not approve or reject this merge request');
    expect(everything).toContain('does not block the merge');
    expect(everything).not.toContain('request_changes');
    // …and the task still finished, rather than parking on `needs_human`.
    expect(reviewTask(harness)?.task.state).toBe('done');
  });

  it('posts nothing below the severity floor and says how many it dropped', async () => {
    const { harness, posted } = reviewHarness({ severityFloor: 'major' });
    await harness.publish([mrEvent('mr.opened')]);
    expect(posted.filter((entry) => entry.path !== null)).toHaveLength(1);
    expect(posted.at(-1)?.markdown).toContain('1 finding(s) below');
    expect(posted.map((entry) => entry.markdown).join('\n')).not.toContain('A trailing space.');
  });

  it('stops at the per-merge-request cap and says how many it held back', async () => {
    const findings = Array.from({ length: 5 }, (_, at) => ({
      id: `f${at}`,
      severity: 'major',
      category: 'correctness',
      file: 'src/totals.ts',
      line: at + 1,
      explanation: `finding ${at}`,
      suggestion: null,
    }));
    const { harness, posted } = reviewHarness({
      maxFindings: 2,
      review: REVIEW({ findings }),
    });
    await harness.publish([mrEvent('mr.opened')]);
    expect(posted.filter((entry) => entry.path !== null)).toHaveLength(2);
    expect(posted.at(-1)?.markdown).toContain('3 further finding(s)');
  });

  it('posts a finding with no line as a merge-request thread rather than dropping it', async () => {
    const { harness, posted } = reviewHarness({
      review: REVIEW({
        findings: [
          {
            id: 'f1',
            severity: 'blocker',
            category: 'architecture',
            file: null,
            line: null,
            explanation: 'The whole approach is wrong.',
            suggestion: null,
          },
        ],
      }),
    });
    await harness.publish([mrEvent('mr.opened')]);
    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({ path: null, line: null });
    expect(posted[0]?.markdown).toContain('The whole approach is wrong.');
  });

  /**
   * TD-012 in the direction the artifact row does not cover.
   *
   * `artifacts.data` stores the model's structured output unredacted (PROGRESS backlog 35, which
   * this work package does not close), so the redaction has to happen where the text **leaves the
   * platform**. The credential is planted in the finding's own explanation, which is how a model
   * quoting its environment would produce it.
   */
  it('keeps a planted credential out of every posted thread, and leaves the placeholder behind', async () => {
    const { harness, posted } = reviewHarness({
      review: REVIEW({
        findings: [
          {
            id: 'f1',
            severity: 'blocker',
            category: 'security',
            file: 'src/totals.ts',
            line: 3,
            explanation: `The config hard-codes ${PLANTED}.`,
            suggestion: null,
          },
        ],
        summary: `The token ${PLANTED} is in the repository.`,
      }),
    });
    await harness.publish([mrEvent('mr.opened')]);
    const everything = posted.map((entry) => entry.markdown).join('\n');
    expect(everything).not.toContain(PLANTED);
    // Both directions (standing rule 42): the secret is gone **and** the text is still there.
    expect(everything).toContain(PLACEHOLDER);
    expect(everything).toContain('The config hard-codes');
    expect(posted).toHaveLength(2);
  });

  /**
   * **Two findings the model gave one id are two findings** (review round 2's major).
   *
   * `reviewFindingSchema.id` is `nonEmptyStringSchema` and `roles/reviewer/prompt.md` never asks for
   * uniqueness, so round 1's key — `…:<finding.id>` — collapsed them: the second call replayed the
   * first's answer, one thread reached the merge request, and the summary said two were posted. A
   * `blocker` dropped under a sentence claiming it was published is the shape of failure standing
   * rules 16 and 79 exist for.
   *
   * Three assertions, because each catches a different half: the threads that exist, the number the
   * summary claims, and the keys the platform stored — which must contain the position and not the
   * model's string, so this cannot come back through a different route.
   */
  it('posts two threads for two findings the model gave the same id, and counts two', async () => {
    const DUPLICATE = 'the-id-the-model-repeated';
    const { harness, posted } = reviewHarness({
      review: REVIEW({
        findings: [
          {
            id: DUPLICATE,
            severity: 'blocker',
            category: 'correctness',
            file: 'src/totals.ts',
            line: 3,
            explanation: 'The first problem.',
            suggestion: null,
          },
          {
            id: DUPLICATE,
            severity: 'blocker',
            category: 'security',
            file: 'src/totals.ts',
            line: 9,
            explanation: 'The second problem, which round 1 dropped.',
            suggestion: null,
          },
        ],
      }),
    });
    await harness.publish([mrEvent('mr.opened')]);

    const findings = posted.filter((entry) => entry.path !== null);
    expect(findings).toHaveLength(2);
    const bodies = findings.map((entry) => entry.markdown).join('\n');
    expect(bodies).toContain('The first problem.');
    expect(bodies).toContain('The second problem, which round 1 dropped.');
    expect(posted.at(-1)?.markdown).toContain('2 finding(s) posted as threads.');

    // The identity the platform stored: a position, never the model's own text.
    const keys = harness.idempotency.keys().filter((key) => key.includes('review_only_finding'));
    expect(keys).toHaveLength(2);
    expect(keys.join('\n')).not.toContain(DUPLICATE);
    const task = reviewTask(harness);
    // `idempotencyStorageKey` is `<integration>:<action>:<key>` with each part percent-encoded, so
    // the platform's own key is the tail, decoded.
    const asked = keys.map((key) => decodeURIComponent(key.slice(key.lastIndexOf(':') + 1)));
    expect(asked).toEqual([
      reviewFindingIdempotencyKey(task?.task.id as Id, HEAD, 0),
      reviewFindingIdempotencyKey(task?.task.id as Id, HEAD, 1),
    ]);
  });

  /**
   * The nit's other half (review round 2): **review-only mode has no shadow mode on this build**.
   *
   * `reviewWrites.thread` passes the *task's* mode to `IntegrationActionExecutor`, and the executor
   * turns a `shadow` task's mutation into a `would_have` row with no provider call — so the
   * docblock there used to describe "a shadow review". Nothing creates one: `runReviewOnlyCheck`
   * writes `mode: 'normal'`, because `tasks.mode` is the two-valued shadow switch and `review_only`
   * is a **run** mode. Measured on the stored row *and* on the audit, rather than left as a sentence
   * (standing rule 86).
   */
  it('creates the review task in `normal` mode, so every thread it posts is a real one', async () => {
    const { harness, posted } = reviewHarness();
    await harness.publish([mrEvent('mr.opened')]);
    expect(reviewTask(harness)?.task.mode).toBe('normal');
    const rows = harness.audit.entriesFor('create_discussion');
    expect(rows.map((row) => row.status)).toEqual(['ok', 'ok']);
    expect(posted).toHaveLength(2);
  });

  it('renders the summary with the platform’s framing above the model’s paragraph', () => {
    const markdown = renderSummary({
      taskId: '00000000-0000-4000-8000-00000000aaaa' as Id,
      summary: 'The model said this.',
      posted: 2,
      belowFloor: 1,
      overFlow: 0,
      severityFloor: 'major',
    });
    expect(markdown.indexOf(REVIEW_SUMMARY_PREAMBLE)).toBeLessThan(
      markdown.indexOf('The model said this.'),
    );
    expect(markdown).toContain('2 finding(s) posted as threads.');
    expect(markdown).not.toContain('further finding(s)');
  });
});

// ── The metric ───────────────────────────────────────────────────────────────

const threadWith = (id: string, body: string, resolved: boolean): Discussion =>
  ({
    id,
    resolvable: true,
    resolved,
    notes: [
      {
        id: `${id}-n1`,
        author: {
          provider: 'fake-git',
          external_id: 'bot',
          email: null,
          display_name: 'agentic',
          verified: false,
        },
        body,
        created_at: '2026-06-01T10:00:00.000Z',
        path: null,
        line: null,
        system: false,
      },
    ],
  }) as Discussion;

const discussion = (id: string, marker: string, resolved: boolean): Discussion =>
  threadWith(id, `${marker}\n**major · correctness**\n\nsomething`, resolved);

describe('what became of the findings', () => {
  const observe = async (options: { readonly resolved: boolean; readonly headMoved: boolean }) => {
    const posted: Posted[] = [];
    const review = reviewHarness();
    await review.harness.publish([mrEvent('mr.opened')]);
    const task = reviewTask(review.harness);
    const marker = reviewMarkerFor(task?.task.id as Id);
    const nextHead = options.headMoved ? 'c'.repeat(40) : HEAD;

    // The provider answers the observation's two reads with the state the merge request ended in.
    const git = review.harness.integrations.git;
    if (git !== null) {
      (git.port as { getMergeRequest: unknown }).getMergeRequest = async () =>
        mergeRequest({ state: 'merged', head_sha: nextHead });
      (git.port as { listDiscussions: unknown }).listDiscussions = async () => [
        discussion('disc-1', marker, options.resolved),
        // A human's own thread, which the platform must not count as one of its findings.
        discussion('disc-2', 'not the marker', true),
      ];
    }
    await review.harness.publish([mrEvent('mr.merged', { merge_commit_sha: 'd'.repeat(40) })]);
    const observed = review.harness
      .events()
      .filter((entry) => entry.type === 'task.review.observed');
    return { observed, posted, harness: review.harness };
  };

  it('counts a resolved thread on a merge request whose head moved as accepted', async () => {
    const { observed } = await observe({ resolved: true, headMoved: true });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.payload).toMatchObject({
      threads_posted: 1,
      threads_resolved: 1,
      threads_accepted: 1,
      threads_dismissed: 0,
      threads_unresolved: 0,
      head_sha_reviewed: HEAD,
      head_sha_now: 'c'.repeat(40),
    });
  });

  it('counts a resolved thread on an unchanged head as dismissed', async () => {
    const { observed } = await observe({ resolved: true, headMoved: false });
    expect(observed[0]?.payload).toMatchObject({
      threads_accepted: 0,
      threads_dismissed: 1,
      threads_unresolved: 0,
    });
  });

  it('counts an unresolved thread as neither', async () => {
    const { observed } = await observe({ resolved: false, headMoved: true });
    expect(observed[0]?.payload).toMatchObject({
      threads_resolved: 0,
      threads_accepted: 0,
      threads_dismissed: 0,
      threads_unresolved: 1,
    });
  });

  it('observes a closed merge request too, not only a merged one', async () => {
    const review = reviewHarness();
    await review.harness.publish([mrEvent('mr.opened')]);
    const task = reviewTask(review.harness);
    const marker = reviewMarkerFor(task?.task.id as Id);
    const git = review.harness.integrations.git;
    if (git !== null) {
      (git.port as { listDiscussions: unknown }).listDiscussions = async () => [
        discussion('disc-1', marker, false),
      ];
    }
    await review.harness.publish([mrEvent('mr.closed')]);
    const observed = review.harness
      .events()
      .filter((entry) => entry.type === 'task.review.observed');
    expect(observed).toHaveLength(1);
    expect(observed[0]?.payload).toMatchObject({ threads_posted: 1, threads_unresolved: 1 });
  });

  /**
   * **The summary is not a finding** (review round 2's minor), read back from the threads this
   * review really posted rather than from hand-written bodies.
   *
   * The cases above script `listDiscussions`, so they never saw the thread the duty itself writes
   * last. product/18:59 counts *"findings accepted … vs dismissed"*; the summary is the platform's
   * own framing, and a human who resolves it has said nothing about a finding. While both threads
   * carried one marker this reported one more than it posted — pinned as `threads_posted: 2` for a
   * single finding in `test/e2e/pipeline/review-only.e2e.test.ts`.
   */
  it('counts the findings and not its own summary, even when a human resolves both', async () => {
    const review = reviewHarness();
    await review.harness.publish([mrEvent('mr.opened')]);
    const task = reviewTask(review.harness);
    // One finding (the `nit` is below the default `major` floor) and the summary.
    expect(review.posted).toHaveLength(2);

    const git = review.harness.integrations.git;
    if (git !== null) {
      // Every thread resolved, including the summary — the state the e2e's human leaves behind.
      (git.port as { listDiscussions: unknown }).listDiscussions = async () =>
        review.posted.map((entry, at) => threadWith(`disc-${at + 1}`, entry.markdown, true));
    }
    await review.harness.publish([mrEvent('mr.merged', { merge_commit_sha: 'd'.repeat(40) })]);

    const observed = review.harness
      .events()
      .filter((entry) => entry.type === 'task.review.observed');
    expect(observed[0]?.payload).toMatchObject({
      threads_posted: 1,
      threads_resolved: 1,
      threads_unresolved: 0,
    });
    // The mechanism, after the number it produces: a marker of its own, which the finding marker is
    // not a substring of.
    expect(review.posted.at(-1)?.markdown).toContain(reviewSummaryMarkerFor(task?.task.id as Id));
    expect(review.posted.at(-1)?.markdown).not.toContain(reviewMarkerFor(task?.task.id as Id));
  });

  it('observes nothing for a merge request the platform never reviewed', async () => {
    const { harness } = reviewHarness({ enabled: false });
    await harness.publish([mrEvent('mr.merged', { merge_commit_sha: 'd'.repeat(40) })]);
    expect(harness.events().filter((entry) => entry.type === 'task.review.observed')).toHaveLength(
      0,
    );
  });
});
