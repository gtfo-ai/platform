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
import type { GitProviderPort } from '../ports/integrations/git-provider.js';
import type { TaskManagementPort } from '../ports/integrations/task-management.js';
import type { PipelineIntegrations } from './integrations.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  staticPipelineIntegrations,
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
  'gates.ts': 1,
  'jobs.ts': 1,
  'saga.ts': 1,
  'workpad.ts': 2,
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
        if (!window.includes('noRunScopedSecrets()')) {
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
      getDefaultBranchHead: async () => ({ branch: 'main', sha: 'a'.repeat(40) }),
    } as unknown as GitProviderPort,
    ref: { integrationId: PROJECT, provider: 'fake-git', type: 'git' },
    project: 'acme/api',
  },
  taskManagement: {
    port: {
      transition: async () => ({ changed: true, from: 'To Do', to: 'In Progress' }),
    } as unknown as TaskManagementPort,
    ref: { integrationId: PROJECT, provider: 'fake-jira', type: 'task_management' },
  },
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
      withOpenTransaction(async () => gitReads(integrations).defaultBranch(context)),
    ).rejects.toBeInstanceOf(TransactionOpenError);
    // Outside a transaction the same call reaches the executor, which is this double's refusal.
    await expect(gitReads(integrations).defaultBranch(context)).rejects.toThrow(
      'the executor was entered',
    );
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
