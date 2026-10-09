/**
 * Two claims about **every** call site in this ring, so both are checked rather than reviewed.
 *
 * 1. `integrationsForProject` takes an `IntegrationCallScope` because Q55's redactor cannot be
 *    built at binding time, and the type makes supplying one unavoidable (standing rule 31). What
 *    the type cannot do is stop the *next* call site from writing an inline `{ runScopedSecrets: [] }`
 *    because that was quicker than deciding. An empty literal and `noRunScopedSecrets()` compile
 *    identically and read completely differently: one is a decision, the other is a default with no
 *    author.
 * 2. Nothing calls `port.forProject` **directly** (WP-15d). `integrationsForProject` is the one door
 *    and it refuses to resolve a project's bindings inside a database transaction — resolution is
 *    itself a pool borrow and a credential decryption, and the call behind it would hold a
 *    connection across a provider's HTTP round trip. A door with a way round it is a docblock
 *    (standing rule 44: a scope claim is a checkable claim), so this is the check.
 *
 * So this walks the ring's own sources. It is the shape of the claim the ledger used to make in
 * prose — "resolved at four call sites", which was wrong, there were six (standing rules 7 and 37:
 * a count is a claim, and a hand-maintained one drifts). Deriving it from disk means the number is
 * never stated at all.
 *
 * **What it cannot see** (standing rule 65, and the reason the gap is listed rather than implied):
 * a call whose scope arrives through a variable, a spread, or a helper of its own is invisible to a
 * text match; a port instance passed to another ring and called there is out of scope by
 * construction; and it cannot tell a *correct* empty scope from an unconsidered one, only that
 * somebody wrote the word. The refusal itself is not syntactic and does not depend on this file:
 * `open-transaction.test.ts` drives it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { TransactionOpenError, withOpenTransaction } from '../events/open-transaction.js';
import type { IntegrationActionExecutor } from '../integrations/action-executor.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { GitProviderPort } from '../ports/integrations/git-provider.js';
import type { TaskManagementPort } from '../ports/integrations/task-management.js';
import type { PipelineIntegrations } from './integrations.js';
import {
  gitReads,
  integrationsForProject,
  mintingIntegrationFor,
  noRunScopedSecrets,
  observabilityForProject,
  PLATFORM_TICKET_PROVIDER,
  staticPipelineIntegrations,
  ticketReads,
  ticketWrites,
} from './integrations.js';

const RING = dirname(fileURLToPath(import.meta.url));
const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;

/** Non-test sources of this directory, read off disk rather than listed here (rule 7). */
const sources = (): readonly { file: string; text: string }[] =>
  readdirSync(RING)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ file: name, text: readFileSync(join(RING, name), 'utf8') }));

/** The door: `integrationsForProject(port, …)`. */
const DOOR = /integrationsForProject\s*\(/g;
/** Round it: `<anything>.forProject(` on the integrations port, never `settings.forProject(`. */
const BYPASS = /integrations\s*(?:\.\s*|\?\.\s*)forProject\s*\(/g;

const linesMatching = (text: string, pattern: RegExp): readonly number[] => {
  const found: number[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    pattern.lastIndex = 0;
    if (pattern.test(line)) {
      found.push(index + 1);
    }
  }
  return found;
};

/**
 * The sites that exist today, pinned per file rather than counted with a floor.
 *
 * A floor is what this asserted first, and the reviewer measured it: **4 against 5 real sites**, so
 * deleting one would not have tripped it. A bound that cannot fail when the set *shrinks* is
 * decoration (rules 7, 68) — and a sweep is at its most dangerous when it quietly reaches less than
 * it used to, because the offenders list is then empty for the wrong reason (rule 4).
 *
 * The *scope* is still read off disk (`sources()`); this is the inventory inside it. Changing a
 * number here is the deliberate act of saying "the pipeline gained/lost a way to reach a provider",
 * which is exactly the change that should not pass unnoticed.
 */
const DOOR_SITES: Readonly<Record<string, number>> = {
  // WP-147: the planner's read of where the CI configuration lives — one resolution per planned
  // run, for one `get_repository_settings` read; no run-scoped credential exists yet.
  'ci-config-location.ts': 1,
  // WP-180: the planner's conversation read — one resolution per planned run, for the merge
  // request's discussions and the ticket's comments; no run-scoped credential exists yet.
  'conversation-read.ts': 1,
  // WP-60 review round 2's `ci_settle` duty: one resolution for the merge request's live head, so
  // the CI gate is settled only for a pipeline that ran on it.
  'ci-settle.ts': 1,
  // WP-26's conflict warning: one resolution for the whole duty, and every peer's diff is read
  // through it — a binding per peer would be a credential decryption per comparison.
  'conflict-warning.ts': 1,
  // WP-39's `coverage` duty: one resolution for the head pipeline, the default branch and the
  // base's pipeline — one wake-up, up to three reads, one binding.
  'coverage.ts': 1,
  // WP-38's `dependency_gate` duty: one resolution for the merge request's diff. The registry
  // lookup that follows is **not** a door — it goes to a package registry rather than to a
  // binding, has no credential, and is the one outbound call the pipeline makes outside
  // `IntegrationActionExecutor` (`registry-metadata.ts` carries the measurement that decided it).
  'dependency-gate.ts': 1,
  // WP-61's two duties: `merge_measure` resolves once for its one diff-stats read, `bug_trace`
  // once for the ticket read and the link half's merge-request reads — neither inside a run, so
  // neither holds a minted credential.
  'delivery-measures.ts': 2,
  // WP-40's two duties: the spike's report before it comments, the epic split's creation before it
  // files the accepted children. One resolution each, and the second one files N tickets through it.
  'epic-split.ts': 2,
  'gates.ts': 1,
  'jobs.ts': 1,
  // WP-122's manual start: one resolution for the ticket read a person asked for — from an HTTP
  // request, outside every transaction and outside any run, so no minted credential.
  'manual-start.ts': 1,
  // Backlog 486's three merge-request duties (`mr_pipeline`, `mr_ready`, `mr_draft`): one shared
  // resolution, in a job, outside every transaction and outside any run.
  'merge-request-ready.ts': 1,
  // WP-138's `open_mr` and `update_mr_description`: one resolution per tool call — the one door
  // made **inside a run**, so its scope is the run's and not `noRunScopedSecrets()`
  // (`RUN_SCOPED_DOOR_SITES` below).
  'merge-request-tool.ts': 1,
  // WP-110's merge-request poller: WP-87's two — one resolution per poll of a git binding, one more
  // when a failed poll re-reads the plan to re-arm itself.
  'mr-poll.ts': 2,
  // WP-79's `ready_head_check` duty: one resolution for the merge request's live head, read outside
  // every transaction and outside any run, so no minted credential.
  'ready-head.ts': 1,
  // WP-24's three duties each resolve the project's bindings once: the check before it creates the
  // task, the post before it writes the threads, the observation before it reads them back.
  // WP-179's three review-conversation duties (`review_findings_post`, `conversation_replies`,
  // `review_threads_resolve`): one resolution each, in a job, outside every transaction and any run.
  'review-conversation.ts': 3,
  'review-only.ts': 3,
  // WP-37's `risk_route` duty: one resolution for the classification and the reviewer routing,
  // which are one wake-up and share every read.
  'risk-routing.ts': 1,
  // WP-73 (backlog 218): the `stage.execute` job's read of a pipeline task's merge-request files
  // before a Reviewer run — outside every transaction and outside the run, so no minted credential.
  'review-paths.ts': 1,
  // WP-90's `review_threads_refresh` duty (backlog 210): one resolution for the one discussion read
  // after a resolution signal — in a job, outside every transaction and outside any run.
  'review-threads-refresh.ts': 1,
  'saga.ts': 1,
  // WP-59's `close_superseded_mr` duty: one resolution for the comment and the close of the merge
  // request a rework let go of.
  'superseded-mr.ts': 1,
  // WP-177: the ticket claim, between the `stage.execute` job's transactions — outside any run.
  'ticket-claim.ts': 1,
  // WP-177: the `ticket_lifecycle` duty, one resolution, in a job.
  'ticket-lifecycle.ts': 1,
  // WP-25's two duties: the check before it creates the lint task, the post before it comments.
  'ticket-lint.ts': 2,
  // WP-177's release, its own module since WP-178: one resolution, from the `ticket_release` duty
  // or the claim's `stage.execute` job — both outside every transaction and outside any run.
  'ticket-release.ts': 1,
  // WP-87's poller: one resolution per poll of a binding, and one more when a failed poll re-reads
  // the plan to re-arm itself — both in a job, outside every transaction and outside any run.
  'ticket-poll.ts': 2,
  'ticket-snapshot.ts': 1,
  'workpad.ts': 2,
};

/**
 * The sites that resolve a project's bindings **from inside a run** and therefore pass the run's
 * own scope (Q55), with the literal that names it — WP-138's merge-request tools, whose call carries
 * the model credential the run was given. Every other site names `noRunScopedSecrets()`.
 */
const RUN_SCOPED_DOOR_SITES: Readonly<Record<string, string>> = {
  'merge-request-tool.ts': 'runScopedSecrets: options.runScopedSecrets()',
};

describe('every pipeline call into the integrations port', () => {
  it('names its scope with noRunScopedSecrets(), so a new one has to decide rather than default', () => {
    const offenders: string[] = [];
    const found: Record<string, number> = {};

    for (const { file, text } of sources()) {
      const lines = text.split('\n');
      for (const line of linesMatching(text, DOOR)) {
        if (file === 'integrations.ts') {
          // The door's own definition takes the scope as a parameter; it has no literal to name.
          continue;
        }
        found[file] = (found[file] ?? 0) + 1;
        // The scope may sit on the same line or below it; biome wraps at 100 characters.
        const window = lines.slice(line - 1, line + 3).join(' ');
        const named = RUN_SCOPED_DOOR_SITES[file] ?? 'noRunScopedSecrets()';
        if (!window.includes(named)) {
          offenders.push(`${file}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    // Both directions (rule 42): a site that appears must name its scope, and a site that
    // disappears must be noticed. `toEqual` on the whole map fails on either.
    expect(found).toEqual(DOOR_SITES);
  });

  it('goes through the door, so none of them can be made inside a transaction unnoticed', () => {
    const offenders: string[] = [];
    for (const { file, text } of sources()) {
      for (const line of linesMatching(text, BYPASS)) {
        // `integrations.ts` is the door: it is the one file that may call the port itself.
        if (file !== 'integrations.ts') {
          offenders.push(`${file}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * An executor that fails if it is entered.
 *
 * Both refusals are supposed to fire **before** anything reaches the executor — before the rate
 * limiter, before `perform`, before an audit row exists — so a test that let one through would
 * otherwise pass on a `TypeError` deep inside a half-built double and read as a refusal
 * (standing rule 21: an uncalibrated instrument reads whatever you were hoping for).
 */
const refusingExecutor: IntegrationActionExecutor = {
  execute: async () => {
    throw new Error('the executor was entered; the guard did not fire');
  },
};

const integrationsDouble = (): PipelineIntegrations => ({
  executor: refusingExecutor,
  git: {
    port: {
      getBranchHead: async () => ({ branch: 'main', sha: 'a'.repeat(40) }),
    } as unknown as GitProviderPort,
    ref: { integrationId: PROJECT, provider: 'fake-git', type: 'git', host: null },
    project: 'acme/api',
    redactor: exactSecretRedactor([]),
  },
  taskManagement: {
    port: {
      transition: async () => ({ changed: true, from: 'To Do', to: 'In Progress' }),
    } as unknown as TaskManagementPort,
    ref: { integrationId: PROJECT, provider: 'fake-jira', type: 'task_management', host: null },
    redactor: exactSecretRedactor([]),
  },
  // The chat binding this file's guards do not exercise: the notify duty's own refusals live in
  // `notify/duty.test.ts`, and what is asserted here is that `forProject` and every call refuse
  // inside a transaction whatever the bindings are.
  communication: null,
});

/**
 * Two refusals, and each is the one the other cannot make (standing rule 41 — a value bounded twice
 * has two untestable guards; these two bound *different* values).
 *
 * Deleting the `assertOutsideTransaction` in `integrationsForProject` kills the first test alone;
 * deleting the one in `read` or in `mutate` kills the second or the third alone. Every one of them
 * is asserted from both sides: refused inside a transaction, performed outside one.
 */
describe('the refusals that keep a provider call out of a transaction', () => {
  const port = staticPipelineIntegrations(integrationsDouble());

  it('refuses to resolve a project’s bindings inside a transaction, and resolves outside one', async () => {
    await expect(
      withOpenTransaction(async () => integrationsForProject(port, PROJECT, noRunScopedSecrets())),
    ).rejects.toBeInstanceOf(TransactionOpenError);
    await expect(integrationsForProject(port, PROJECT, noRunScopedSecrets())).resolves.toBeTruthy();
  });

  it('refuses a provider read whose bindings were resolved before the transaction opened', async () => {
    // The case the door cannot see: a caller that resolved its bindings first and then opened a
    // transaction walks straight past `integrationsForProject`.
    const integrations = await integrationsForProject(port, PROJECT, noRunScopedSecrets());
    const context = { projectId: PROJECT, taskId: null };
    await expect(
      withOpenTransaction(async () => gitReads(integrations).branchHead('main', context)),
    ).rejects.toBeInstanceOf(TransactionOpenError);
    // Outside a transaction the same call reaches the executor, which is this double's refusal.
    await expect(gitReads(integrations).branchHead('main', context)).rejects.toThrow(
      'the executor was entered',
    );
  });

  /**
   * PROGRESS backlog **62**, the **read** half (WP-36).
   *
   * Four kinds of task carry `{provider: 'platform', …}` — discovery, review-only, the ticket lint
   * and a scheduled maintenance chore — and `ensureTicketSnapshot` reads the ticket for every agent
   * stage of a task that has none. The three *writes* have refused that provider by name since
   * WP-25; this read did not, so a project with a task-management binding paid one doomed round
   * trip per stage, each a `failed` row in `integration_actions`. Both directions (rule 42): the
   * platform-issued reference answers `null` without touching the executor, and a provider's own
   * key still reaches it.
   */
  it('answers null for a reference no provider issued, and still reads a provider’s own', async () => {
    const integrations = await integrationsForProject(port, PROJECT, noRunScopedSecrets());
    const context = { projectId: PROJECT, taskId: null };
    const reads = ticketReads(integrations);

    await expect(
      reads.ticket(
        { provider: PLATFORM_TICKET_PROVIDER, key: 'chore!kb-2026-W38', url: '' },
        context,
      ),
    ).resolves.toBeNull();
    // The executor is the one that throws in this double, so reaching it *is* the assertion that
    // the guard did not fire — which is what makes the `null` above a refusal rather than a stub.
    await expect(
      reads.ticket(
        { provider: 'fake-jira', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' },
        context,
      ),
    ).rejects.toThrow('the executor was entered');
  });

  it('refuses a provider mutation whose bindings were resolved before the transaction opened', async () => {
    const integrations = await integrationsForProject(port, PROJECT, noRunScopedSecrets());
    const ticket = {
      provider: 'fake-jira',
      key: 'ACME-1',
      url: 'https://jira.example.test/ACME-1',
    };
    const context = {
      projectId: PROJECT,
      taskId: '00000000-0000-4000-8000-000000000001' as Id,
      mode: 'normal' as const,
      causeEventId: '00000000-0000-4000-9000-000000000001' as Id,
    };
    await expect(
      withOpenTransaction(async () =>
        ticketWrites(integrations).transition(ticket, 'In Progress', context),
      ),
    ).rejects.toBeInstanceOf(TransactionOpenError);
    await expect(
      ticketWrites(integrations).transition(ticket, 'In Progress', context),
    ).rejects.toThrow('the executor was entered');
  });
});

/**
 * WP-80 (TD-028 decision 10): the minting integration has a door of its own,
 * `mintingIntegrationFor`, guarded like `integrationsForProject` — a revocation is a provider call,
 * never made inside a transaction. Nothing in the application ring calls the port member directly.
 */
describe('the minting integration’s door (WP-80)', () => {
  const APPLICATION = join(RING, '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
          ? [join(dir, entry.name)]
          : [],
    );

  it('is the only caller of forMintingIntegration outside the port’s own module', () => {
    const callers = walk(APPLICATION)
      .filter((file) => !file.endsWith(join('pipeline', 'integrations.ts')))
      .filter((file) => /\.\s*forMintingIntegration\s*\(/.test(readFileSync(file, 'utf8')));
    expect(callers).toEqual([]);
  });

  it('refuses inside an open transaction', async () => {
    const port = staticPipelineIntegrations({
      executor: {} as IntegrationActionExecutor,
      git: null,
      taskManagement: null,
      communication: null,
    });
    await expect(
      withOpenTransaction(async () =>
        mintingIntegrationFor(port, 'a' as Id, { runScopedSecrets: [] }),
      ),
    ).rejects.toBeInstanceOf(TransactionOpenError);
    expect(await mintingIntegrationFor(port, 'a' as Id, { runScopedSecrets: [] })).toBeNull();
  });
});

/**
 * WP-89: the observability bindings have a door of their own, `observabilityForProject`, guarded
 * like `integrationsForProject` — resolving a binding is a credential decryption and the reads
 * behind it are provider round trips. Nothing in the application ring calls the member directly.
 */
describe('the observability door (WP-89)', () => {
  const APPLICATION = join(RING, '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
          ? [join(dir, entry.name)]
          : [],
    );

  it('is the only caller of forObservability outside the port’s own module', () => {
    const callers = walk(APPLICATION)
      .filter((file) => !file.endsWith(join('pipeline', 'integrations.ts')))
      .filter((file) => /\.\s*forObservability\s*\(/.test(readFileSync(file, 'utf8')));
    expect(callers).toEqual([]);
  });

  it('refuses inside an open transaction, and answers null for a type the project does not bind', async () => {
    const port = staticPipelineIntegrations({
      executor: {} as IntegrationActionExecutor,
      git: null,
      taskManagement: null,
      communication: null,
    });
    await expect(
      withOpenTransaction(async () =>
        observabilityForProject(port, PROJECT, 'errors', noRunScopedSecrets()),
      ),
    ).rejects.toBeInstanceOf(TransactionOpenError);
    expect(await observabilityForProject(port, PROJECT, 'logs', noRunScopedSecrets())).toBeNull();
  });
});
