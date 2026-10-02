/**
 * The knowledge MR flow — technical/07 § "Librarian pipeline" step 4 (WP-18b).
 *
 * > Apply: … edit files, regenerate `index.md`, commit with provenance trailer
 * > (`Agentic-Source: task PROJ-123 run <id>`), push to the knowledge branch → MR.
 *
 * ## A branch and a merge request, always — never the default branch
 *
 * technical/07 step 4 offers "(or direct push to default branch when the project allows and the
 * branch is not protected)" and this build does **not** implement that half. The reason is BD-025
 * rather than caution: the platform reads `.agentic/`, `CLAUDE.md` and `.claude/` — the vault
 * included — **from the default branch**, so a direct push is the one write that changes the rules
 * every later run is governed by, with no review in between. A merge request puts a human on that
 * path, which is the same answer BD-007 gives for code. `auto_apply` therefore decides whether a
 * proposal needs a *maintainer's decision in the queue*, not whether it skips review entirely: an
 * auto-applied proposal still lands as a commit on `agentic/knowledge/*` with an open MR.
 *
 * ## The shape: read, call, write
 *
 * A job, never a handler, because it makes two provider calls (`CLAUDE.md`'s *transaction / no
 * transaction / transaction*, WP-15d). Everything it needs is read before the calls, the calls go
 * through `IntegrationActionExecutor` by way of `knowledgeWrites`, and one transaction at the end
 * records what happened. `integrations.forProject` and the executor both refuse to run inside a
 * transaction, so an accidental reordering fails loudly rather than holding a pooled connection
 * across somebody else's HTTP latency.
 *
 * ## What is in the commit, and what decides `create` versus `update`
 *
 * The **index**, read at apply time — not the `action` the Librarian chose when the proposal was
 * written. The two can disagree (a page the model thought was missing may have been added since,
 * and vice versa), and the index is the fresher of the two. When it is wrong the provider refuses
 * the whole commit with `invalid_request`, which is the fail-closed direction: nothing is
 * overwritten and the batch is retried.
 *
 * ## A page already on an open knowledge merge request waits for it (WP-125, backlog 369)
 *
 * The index holds a page only once its knowledge merge request has **merged**, so an approved
 * proposal for a path an earlier apply put on a merge request nobody has merged yet read as
 * `create` — and became a second merge request creating the same file from a branch cut before the
 * first one, which a provider answers with an add/add conflict once the first merges (measured on
 * the fake at WP-109: two branches, `!1` and `!2`, both `create`). So before choosing `create`, the
 * pass asks the store which applied proposals of that path recorded a merge request
 * (`applyCarriers`, migration 0076 — the store recorded only the commit before it, criterion 1's
 * measurement) and asks the provider whether any of them is still open. If one is, the proposal is
 * **deferred**: it stays approved, carries a platform reason naming the merge request
 * (`apply_deferred_reason`), and is left out of this commit. It is never stacked onto the open
 * branch, because that edits a merge request a human may be reviewing. Once that merge request
 * merges, the index holds the page and the next pass applies the proposal as an `update`. A pass
 * that runs **between** the merge and the index reading it (woken by another decision, say) keeps
 * the proposal deferred rather than choosing `create` for a file that now exists — which the
 * provider would refuse for the whole commit (WP-125 review round 1) — unless the merge is older
 * than {@link INDEX_CATCH_UP_MS}, when an unindexed page was removed since and is created. A merge
 * request that was **closed** blocks nothing, and the page is created. The next pass is asked for
 * by the index run that read the merge ({@link wakeAwaitingKnowledgeApply}), and by the nightly
 * hygiene sweep failing that. The WP-124 apply recovery leaves a deferred proposal alone: it is
 * waiting on a person, not stranded. **A deferral is re-decided on every pass**: a proposal a pass
 * puts into its batch has its reason cleared before the provider calls, so a later failure of that
 * pass leaves no stale *"waits for !n"* and the recovery's `apply_failed` ending can reach it.
 *
 * Two things it does not do. It asks only before a `create`: an `update` of a page an open merge
 * request also edits still becomes a second merge request (a modify/modify conflict, not the
 * add/add one the ruling names). And a proposal applied before migration 0076 recorded no merge
 * request, so it cannot hold a later proposal back.
 *
 * `index.md` is **not** regenerated. technical/07 asks for it and this build does not do it: the
 * index page is a curated summary (product/05's "Curated, not dumped"), the Librarian can propose a
 * change to it like any other page — `index.md` is a legal `target_path` — and a generator that
 * rewrote it from the file list would overwrite whatever a human wrote there. Recorded in
 * technical/07 rather than left as a silent omission.
 */
import type { Id, IsoDateTime, MergeRequestRef } from '@platform/contracts';
import { knowledgeProposalAppliedEvent } from '@platform/contracts';
import type { Clock, IdSource } from '@platform/domain';
import {
  gitReads,
  integrationsForProject,
  knowledgeWrites,
  noRunScopedSecrets,
  type PipelineIntegrations,
  type PipelineIntegrationsPort,
} from '../pipeline/integrations.js';
import { appendOnProjectWithRetry } from '../pipeline/project-stream.js';
import type { EventStore } from '../ports/event-store.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { CommitAction } from '../ports/integrations/git-provider.js';
import { jobQueueDefinition } from '../ports/job-queues.js';
import type { EnqueueResult, JobHandler, Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type {
  KnowledgeApplyCarrier,
  KnowledgeProposalStore,
  KnowledgeStore,
  StoredKnowledgeProposal,
} from './ports.js';

/** Why the apply job was asked for — a log field, and the only thing that separates two wake-ups. */
export type KnowledgeApplyReason =
  | 'auto_apply'
  | 'decision'
  | 'sweep'
  | 'recovery'
  /** An index run read a new default-branch commit while proposals waited (WP-125). */
  | 'indexed';

export interface KnowledgeApplyData {
  readonly project_id: string;
  readonly reason: KnowledgeApplyReason;
  readonly [key: string]: unknown;
}

/** What the job re-reads about the project when it fires. */
export interface KnowledgeApplyProject {
  readonly knowledgeDir: string;
  /** `projects.default_branch` — what the knowledge branch starts from and merges back into. */
  readonly defaultBranch: string;
}

/**
 * How many proposals one commit may carry.
 *
 * A bound on a provider request built from model output. Twenty pages is a large knowledge change
 * by any measure, and whatever is left over is applied by the next pass — the job re-enqueues
 * itself while anything is still waiting.
 */
export const MAX_PROPOSALS_PER_COMMIT = 20;

/** Longest path list the commit message carries before it says how many it left out. */
const MAX_MESSAGE_LINES = 20;

export interface KnowledgeApplyOptions {
  readonly unitOfWork: UnitOfWork;
  readonly eventStore: EventStore;
  readonly proposals: KnowledgeProposalStore;
  readonly knowledge: KnowledgeStore;
  readonly integrations: PipelineIntegrationsPort;
  readonly jobs: Jobs;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly project: (projectId: Id) => Promise<KnowledgeApplyProject | null>;
  /**
   * Ticket key per task id, for the provenance trailer (`Agentic-Source: task PROJ-123 run <id>`).
   *
   * A function rather than a port: one `tasks` read, and the composition root already holds the
   * pool (the shape `KnowledgeIndexJobOptions.project` uses).
   */
  readonly ticketKeys: (taskIds: readonly Id[]) => Promise<ReadonlyMap<Id, string>>;
  readonly logger?: Logger;
}

export type KnowledgeApplyStatus =
  /** A commit exists and the proposals that went into it are `applied`. */
  | 'applied'
  /** There was nothing waiting, or nothing that could be applied. */
  | 'nothing_to_apply'
  /** The project has no git binding, or no row; the proposals stay where they are. */
  | 'unavailable';

export interface KnowledgeApplyReport {
  readonly status: KnowledgeApplyStatus;
  readonly reason: string | null;
  readonly branch: string | null;
  readonly commitSha: string | null;
  readonly mergeRequestUrl: string | null;
  readonly applied: number;
  /** Still waiting after this pass — the reason the job re-enqueues itself. */
  readonly remaining: number;
  /**
   * Proposals this pass left out because their page is on an open knowledge merge request (WP-125,
   * backlog 369). Not counted in `remaining`: nothing this job does can move them.
   */
  readonly deferred: number;
}

const nothing = (reason: string): KnowledgeApplyReport => ({
  status: 'nothing_to_apply',
  reason,
  branch: null,
  commitSha: null,
  mergeRequestUrl: null,
  applied: 0,
  remaining: 0,
  deferred: 0,
});

/**
 * The branch one batch lands on.
 *
 * technical/07 names `agentic/knowledge/<date>`; this appends the batch's own discriminator,
 * because a date alone is not a name a second batch on the same day can use — the provider refuses
 * to create a branch that exists, and the alternative (committing onto the open branch) would add
 * pages to a merge request a human is already reading.
 *
 * **Both halves come from the batch, and that is what makes a retry idempotent.** The discriminator
 * is the earliest proposal's id and the date is that same proposal's `created_at` — *not* the
 * clock. A clock date is stable only inside one UTC day: a job that fails at 23:59 and retries at
 * 00:01 would compute a different branch, both idempotency keys (`knowledge_commit:<branch>`,
 * `knowledge_mr:<branch>`) would miss, and the retry would open a second merge request for a commit
 * that already exists. The `at` argument survives as the fallback for a batch with no proposals,
 * which the caller returns before reaching (it answers `nothing(…)` on an empty list).
 */
export const knowledgeBranchName = (
  at: IsoDateTime,
  proposals: readonly StoredKnowledgeProposal[],
): string => {
  const earliest = [...proposals].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  const discriminator = (earliest?.id ?? '').replaceAll('-', '').slice(0, 8);
  return `agentic/knowledge/${(earliest?.createdAt ?? at).slice(0, 10)}-${discriminator}`;
};

/**
 * Longest token the provenance trailer carries, and the character class it admits.
 *
 * A ticket key is **provider text** (`nonEmptyStringSchema` in `TicketRef`, and Jira emits
 * `issue.key` with no cap of its own), and the trailer is a **line-structured** document read by
 * git, by a human and by whatever parses `Agentic-Source:` later. A key containing a newline forges
 * additional trailer lines; a long one makes a multi-megabyte provider request out of twenty rows.
 *
 * So it is **refused rather than escaped**, which is the same answer `vaultPathOf` gives a
 * model-chosen path and `assemblePrompt` gives a marker attribute: escaping leaves something for a
 * later transform to undo, and there is nothing to undo if the value never enters. The fallback is
 * the task's own **uuid**, which is safe by construction and still identifies the task — a trailer
 * that says `task 0199…` is worse to read and is never a lie.
 */
export const MAX_TRAILER_TOKEN_CHARS = 64;

const SAFE_TRAILER_TOKEN = /^[A-Za-z0-9._/-]+$/;

/**
 * One token of the trailer: the provider's value when it is safe, the platform's own otherwise.
 *
 * Exported because the refusal is the interesting half and a test drives it directly with a hostile
 * key (rule 40: a field bounded by a refusal needs a document that triggers the refusal).
 */
export const provenanceTokenOf = (value: string | null | undefined, fallback: string): string =>
  value !== null &&
  value !== undefined &&
  value.length <= MAX_TRAILER_TOKEN_CHARS &&
  SAFE_TRAILER_TOKEN.test(value)
    ? value
    : fallback;

/**
 * `Agentic-Source: task PROJ-123 run <id>` — technical/07's trailer, one line per source run.
 *
 * Every interpolated value passes {@link provenanceTokenOf}: the ticket key because it is provider
 * text, and the run id because "it is a uuid in the database" is a claim about a column rather than
 * about this line (standing rule 16's shape — the guard must not read a field whose producer it
 * cannot see).
 */
const provenanceTrailers = (
  proposals: readonly StoredKnowledgeProposal[],
  ticketKeys: ReadonlyMap<Id, string>,
): readonly string[] => {
  const lines = new Set<string>();
  for (const proposal of proposals) {
    const fallback = proposal.taskId ?? 'unknown';
    const task =
      proposal.taskId === null
        ? 'unknown'
        : provenanceTokenOf(ticketKeys.get(proposal.taskId), fallback);
    const run = provenanceTokenOf(proposal.runId, 'unknown');
    lines.add(`Agentic-Source: task ${task} run ${run}`);
  }
  return [...lines];
};

const commitMessageFor = (input: {
  readonly proposals: readonly StoredKnowledgeProposal[];
  readonly ticketKeys: ReadonlyMap<Id, string>;
}): string => {
  const count = input.proposals.length;
  const subject = `docs(knowledge): apply ${count} knowledge proposal${count === 1 ? '' : 's'}`;
  const shown = input.proposals.slice(0, MAX_MESSAGE_LINES);
  // `targetPath` is safe to interpolate into a line-structured document for a reason that is not
  // obvious here: only a proposal the curator **joined** onto the knowledge directory can reach an
  // apply pass (`vaultPathOf` refuses control characters, backslashes, traversal and anything over
  // 200 characters, and a refused proposal is `discarded`, which `listAwaitingApply` excludes).
  // `type` is an enum and `significance` a number.
  const body = shown.map((proposal) => `- ${proposal.targetPath} (${proposal.type})`);
  if (input.proposals.length > shown.length) {
    body.push(`- …and ${input.proposals.length - shown.length} more`);
  }
  return [
    subject,
    '',
    ...body,
    '',
    ...provenanceTrailers(input.proposals, input.ticketKeys),
    '',
  ].join('\n');
};

const mergeRequestBodyFor = (input: {
  readonly proposals: readonly StoredKnowledgeProposal[];
  readonly ticketKeys: ReadonlyMap<Id, string>;
}): string =>
  [
    'The Librarian proposes these knowledge-base changes (technical/07, BD-018).',
    '',
    ...input.proposals
      .slice(0, MAX_MESSAGE_LINES)
      .map(
        (proposal) =>
          `- \`${proposal.targetPath}\` — ${proposal.type}, significance ${proposal.significance}`,
      ),
    '',
    ...provenanceTrailers(input.proposals, input.ticketKeys),
  ].join('\n');

/**
 * The reason a deferred proposal carries — platform text, so it may be stored, rendered and logged.
 * Both interpolated values are the platform's: the merge request's `iid` is an integer the schema
 * admits, and the path is one the curator joined onto the knowledge directory (`vaultPathOf`).
 */
export const applyDeferredReason = (path: string, mergeRequestIid: number): string =>
  `this approved change waits for knowledge merge request !${String(mergeRequestIid)}, which already creates ${path} and is not merged yet; it is applied as an update once that merge request merges, never added to its branch (PROGRESS backlog 369)`;

/**
 * The reason a deferred proposal carries when its merge request could not be read at all — a
 * refusal no retry fixes (`forbidden`, `invalid_response`, …). Platform text, as above.
 */
export const applyUnreadableReason = (path: string, mergeRequestIid: number): string =>
  `this approved change waits: knowledge merge request !${String(mergeRequestIid)} may already create ${path}, and the provider refused to say whether it is still open; it is retried when the project's index next moves and by the nightly knowledge pass (PROGRESS backlog 369)`;

/**
 * The reason a deferred proposal carries while its page's merge request has **merged** and the index
 * has not read the merge yet (WP-125 review round 1). Platform text, as above.
 */
export const applyAwaitingIndexReason = (path: string, mergeRequestIid: number): string =>
  `this approved change waits for the knowledge index to read knowledge merge request !${String(mergeRequestIid)}, which merged ${path}; the index run that reads the merge asks for it to be applied as an update (PROGRESS backlog 369)`;

/**
 * How long after a merge an unindexed page is still taken to be the index's lag (WP-125 review
 * round 1). The index run is enqueued on the merge itself, so a day is far past any lag; past it, a
 * merged page the index does not hold was **removed** from the default branch since, and a
 * `create` is right. Without the bound, such a proposal would wait for an index that never comes.
 */
export const INDEX_CATCH_UP_MS = 24 * 60 * 60_000;

/** States in which a merge request still holds its branch's change back from the default branch. */
const UNMERGED_STATES: ReadonlySet<string> = new Set(['opened', 'locked']);

/** What the provider says about a recorded knowledge merge request, as far as this pass cares. */
type CarrierState = 'open' | 'merged_recently' | 'not_open' | 'unreadable';

/**
 * Whether a recorded knowledge merge request is still unmerged, asked of the provider through the
 * executor (a read: audited, rate-limited, refused inside a transaction).
 *
 * One answer per merge request per pass. A merge request the provider no longer knows
 * (`not_found`, deleted) holds nothing back. A **retryable** failure (`rate_limited`,
 * `unavailable`) throws, so the pass fails closed and pg-boss retries it rather than choosing
 * `create` on a guess. Any other refusal is `unreadable`: retrying it would fail the same way, and
 * throwing it would fail the whole batch for one page (PROGRESS backlog 420's shape), so that one
 * proposal waits instead — still never a `create` on a guess.
 */
const openMergeRequestReader = (
  integrations: PipelineIntegrations,
  projectId: Id,
  now: IsoDateTime,
): ((ref: MergeRequestRef) => Promise<CarrierState>) => {
  const answers = new Map<number, Promise<CarrierState>>();
  const reads = gitReads(integrations);
  return (ref) => {
    const known = answers.get(ref.iid);
    if (known !== undefined) return known;
    const answer = (async (): Promise<CarrierState> => {
      try {
        const current = await reads.mergeRequest(ref, { projectId, taskId: null });
        if (current === null) return 'not_open';
        if (UNMERGED_STATES.has(current.state)) return 'open';
        // Merged, and the caller asks only for a path the index does not hold: the index has not
        // read the merge yet, so a `create` now would be refused for a file that exists — unless
        // the merge is old enough that the page must have been removed since.
        if (current.state === 'merged') {
          const mergedAt = current.merged_at == null ? null : Date.parse(current.merged_at);
          if (mergedAt === null || Date.parse(now) - mergedAt < INDEX_CATCH_UP_MS) {
            return 'merged_recently';
          }
        }
        return 'not_open';
      } catch (error) {
        if (!(error instanceof IntegrationError) || error.retryable) throw error;
        return error.code === 'not_found' ? 'not_open' : 'unreadable';
      }
    })();
    answers.set(ref.iid, answer);
    return answer;
  };
};

interface PlannedAction {
  readonly proposal: StoredKnowledgeProposal;
  readonly action: CommitAction['action'];
}

/**
 * Which waiting proposals this commit carries, as what, and which wait (WP-125, backlog 369).
 *
 * One action per path — a commit cannot carry two for the same file, and the ones left over are
 * applied by the next pass (which the job asks for itself); taking the *first* keeps the order the
 * decisions were made in. A path the index holds is an `update`. A path it does not hold is a
 * `create` unless an applied proposal of that path recorded a merge request the provider still
 * reports open, in which case the proposal is deferred. A deferred proposal does not take a place
 * in the batch, so a page waiting on a merge does not hold back the other pages.
 */
const planBatch = async (input: {
  readonly waiting: readonly StoredKnowledgeProposal[];
  readonly indexed: ReadonlyMap<string, string>;
  readonly carriers: readonly KnowledgeApplyCarrier[];
  readonly isOpen: (ref: MergeRequestRef) => Promise<CarrierState>;
}): Promise<{
  readonly batch: readonly PlannedAction[];
  readonly deferred: readonly { readonly id: Id; readonly reason: string }[];
}> => {
  const batch: PlannedAction[] = [];
  const deferred: { id: Id; reason: string }[] = [];
  const claimed = new Set<string>();
  for (const proposal of input.waiting) {
    if (batch.length >= MAX_PROPOSALS_PER_COMMIT) break;
    if (claimed.has(proposal.targetPath)) continue;
    claimed.add(proposal.targetPath);
    if (input.indexed.has(proposal.targetPath)) {
      batch.push({ proposal, action: 'update' });
      continue;
    }
    let reason: string | null = null;
    for (const carrier of input.carriers) {
      if (carrier.targetPath !== proposal.targetPath) continue;
      const state = await input.isOpen(carrier.mergeRequest);
      if (state === 'open') {
        reason = applyDeferredReason(proposal.targetPath, carrier.mergeRequest.iid);
        break;
      }
      if (state === 'merged_recently') {
        reason = applyAwaitingIndexReason(proposal.targetPath, carrier.mergeRequest.iid);
        break;
      }
      if (state === 'unreadable') {
        reason = applyUnreadableReason(proposal.targetPath, carrier.mergeRequest.iid);
        break;
      }
    }
    if (reason === null) {
      batch.push({ proposal, action: 'create' });
    } else {
      deferred.push({ id: proposal.id, reason });
    }
  }
  return { batch, deferred };
};

/**
 * One apply pass for one project.
 *
 * Exported beside the handler so a test can read the report; the handler is this plus logging and
 * the self re-enqueue.
 */
export const applyKnowledgeProposals = async (
  options: KnowledgeApplyOptions,
  data: KnowledgeApplyData,
): Promise<KnowledgeApplyReport> => {
  const projectId = data.project_id as Id;
  const project = await options.project(projectId);
  if (project === null) {
    return { ...nothing('the project no longer has a row'), status: 'unavailable' };
  }

  const waiting = await options.proposals.listAwaitingApply(
    projectId,
    MAX_PROPOSALS_PER_COMMIT * 2,
  );
  if (waiting.length === 0) {
    return nothing('no proposal is waiting to be applied');
  }

  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  if (integrations.git === null) {
    return {
      ...nothing('the project has no git binding, so there is nowhere to commit a knowledge page'),
      status: 'unavailable',
      remaining: waiting.length,
    };
  }

  const indexed = await options.knowledge.readIndexedBlobs(projectId);
  const plan = await planBatch({
    waiting,
    indexed,
    carriers: await options.proposals.applyCarriers(projectId, [
      ...new Set(
        waiting
          .filter((proposal) => !indexed.has(proposal.targetPath))
          .map((proposal) => proposal.targetPath),
      ),
    ]),
    isOpen: openMergeRequestReader(integrations, projectId, options.clock.now()),
  });
  const batch = plan.batch.map((entry) => entry.proposal);
  // Every deferral is re-decided here (WP-125 review round 1): a proposal this pass carries loses a
  // reason an earlier pass gave it **before** the provider calls, so a pass that then fails cannot
  // leave a stale "waits for !n" that also keeps it outside the apply recovery for ever.
  const undeferred = batch.filter((proposal) => proposal.applyDeferredReason != null);
  if (plan.deferred.length > 0 || undeferred.length > 0) {
    await options.unitOfWork.transaction(async (scope) => {
      await options.proposals.clearApplyDeferral(scope.tx, {
        ids: undeferred.map((proposal) => proposal.id),
      });
      await options.proposals.deferApply(scope.tx, { deferrals: plan.deferred });
    });
  }
  const remaining = waiting.length - batch.length - plan.deferred.length;
  if (batch.length === 0) {
    return {
      ...nothing(
        'every waiting proposal is for a page an open knowledge merge request already creates; each is applied once that merge request merges',
      ),
      remaining,
      deferred: plan.deferred.length,
    };
  }
  const actions: CommitAction[] = plan.batch.map((entry) => ({
    action: entry.action,
    path: entry.proposal.targetPath,
    content: entry.proposal.delta,
  }));

  const at = options.clock.now();
  const branch = knowledgeBranchName(at, batch);
  const ticketKeys = await options.ticketKeys([
    ...new Set(batch.flatMap((proposal) => (proposal.taskId === null ? [] : [proposal.taskId]))),
  ]);
  const writes = knowledgeWrites(integrations);
  const callContext = { projectId, taskId: null };

  const commit = await writes.commit(
    {
      branch,
      startBranch: project.defaultBranch,
      message: commitMessageFor({ proposals: batch, ticketKeys }),
      // BD-025 §4: the bot identity acts, and the provenance trailer records the humans' tasks.
      authorName: 'Agentic',
      authorEmail: 'agentic@platform.invalid',
      actions,
      idempotencyKey: `knowledge_commit:${branch}`,
    },
    callContext,
  );
  if (commit === null) {
    return { ...nothing('the git binding disappeared between two reads'), status: 'unavailable' };
  }

  const mergeRequest = await writes.openMergeRequest(
    {
      branch,
      target: project.defaultBranch,
      title: `Knowledge: ${batch.length} proposal${batch.length === 1 ? '' : 's'}`,
      description: mergeRequestBodyFor({ proposals: batch, ticketKeys }),
      idempotencyKey: `knowledge_mr:${branch}`,
    },
    callContext,
  );

  // The commit and the merge request above are **held**: a lost sequence race re-runs only this
  // transaction (WP-109, backlog 333), never the two provider calls — which before it were repeated
  // by pg-boss's retry a minute later and answered, if at all, by the executor's idempotency record.
  await appendOnProjectWithRetry(
    options,
    { projectId, writer: 'knowledge_apply' },
    async (scope, streamSeq) => {
      await options.proposals.markApplied(scope.tx, {
        ids: batch.map((proposal) => proposal.id),
        commitSha: commit.sha,
        // WP-125 (backlog 369): which merge request carries these paths, so the next pass can ask
        // whether it is still open before it chooses `create` for one of them.
        mergeRequest: mergeRequest?.ref ?? null,
      });
      await scope.events.append(
        batch.map((proposal, index) =>
          knowledgeProposalAppliedEvent.parse({
            id: options.ids.next(),
            stream_type: 'project',
            stream_id: projectId,
            stream_seq: streamSeq + index,
            actor: { kind: 'system', component: 'librarian' },
            occurred_at: at,
            type: 'knowledge.proposal.applied',
            payload: {
              project_id: projectId,
              proposal_id: proposal.id,
              commit_sha: commit.sha,
              decided_by_user_id: proposal.decidedByUserId,
            },
          }),
        ),
      );
    },
  );

  return {
    status: 'applied',
    reason: null,
    branch,
    commitSha: commit.sha,
    mergeRequestUrl: mergeRequest?.web_url ?? null,
    applied: batch.length,
    remaining,
    deferred: plan.deferred.length,
  };
};

export const knowledgeApplyKey = (projectId: string): string => `project:${projectId}`;

/**
 * Asks for one apply pass.
 *
 * `stately` + a per-project key, so a burst of decisions folds onto one run with one trailing
 * wake-up — and the trailing run re-reads `listAwaitingApply`, which is why a decision made while a
 * commit is in flight is not lost (TD-004: re-validate on fire).
 */
export const enqueueKnowledgeApply = async (
  jobs: Jobs,
  request: { readonly projectId: Id; readonly reason: KnowledgeApplyReason },
): Promise<EnqueueResult> =>
  jobs.enqueue<KnowledgeApplyData>({
    queue: JOB_QUEUES.knowledgeApply,
    singletonKey: knowledgeApplyKey(request.projectId),
    data: { project_id: request.projectId, reason: request.reason },
  });

/**
 * Asks for an apply pass when the project has an approved proposal waiting — what an index run that
 * read a **new** default-branch commit calls (WP-125, backlog 369): the commit may be the merge a
 * deferred proposal waits for, and the index now holds its page, so the next pass applies it as an
 * `update`. Answers whether it enqueued. A project with nothing waiting enqueues nothing.
 */
export const wakeAwaitingKnowledgeApply = async (
  options: { readonly proposals: KnowledgeProposalStore; readonly jobs: Jobs },
  projectId: Id,
): Promise<boolean> => {
  const waiting = await options.proposals.listAwaitingApply(projectId, 1);
  if (waiting.length === 0) return false;
  await enqueueKnowledgeApply(options.jobs, { projectId, reason: 'indexed' });
  return true;
};

export const declareKnowledgeApplyQueue = async (jobs: Jobs): Promise<void> => {
  await jobs.defineQueue(jobQueueDefinition(JOB_QUEUES.knowledgeApply));
};

export const knowledgeApplyHandler =
  (options: KnowledgeApplyOptions): JobHandler<KnowledgeApplyData> =>
  async (job) => {
    const logger = options.logger ?? silentLogger;
    const report = await applyKnowledgeProposals(options, job.data);
    const fields = {
      project_id: job.data.project_id,
      trigger: job.data.reason,
      status: report.status,
      branch: report.branch,
      commit_sha: report.commitSha,
      merge_request: report.mergeRequestUrl,
      applied: report.applied,
      remaining: report.remaining,
      deferred: report.deferred,
      reason: report.reason,
    };
    if (report.status === 'unavailable') {
      // Reported, not thrown: a project with no git binding is a configuration a deployment is
      // legitimately in, and the proposals stay queued until it has one (standing rule 20) — or, since
      // WP-124, until the apply recovery's pass ends them `apply_failed` about an hour later.
      logger.warn(fields, 'knowledge proposals could not be applied; they are left where they are');
      return;
    }
    logger.info(fields, 'knowledge apply pass finished');
    if (report.status === 'applied' && report.remaining > 0) {
      // Bounded: every pass applies at least one proposal, so the waiting set strictly shrinks.
      await enqueueKnowledgeApply(options.jobs, {
        projectId: job.data.project_id as Id,
        reason: 'sweep',
      });
    }
  };
