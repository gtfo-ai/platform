/**
 * *When* an unsuccessful run's unfinished work is saved, and where it goes — the product owner's
 * 2026-10-05 decision (PROGRESS backlog 467).
 *
 * The behaviour is parameterised over two sets — the terminal reasons and the roles — so each set is
 * driven member by member (standing rule 68): every reason the schema has is asked, and the table of
 * saved reasons is compared with the expectation in both directions.
 */
import {
  type AgentRole,
  agentRoleSchema,
  type RunStatus,
  type RunTerminalReason,
  runTerminalReasonSchema,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  SAVED_UNFINISHED_WORK_REASONS,
  savedWorkSentence,
  savesUnfinishedWork,
  unfinishedWorkBranchFor,
  unfinishedWorkCommitMessage,
  unfinishedWorkExportFor,
} from './unfinished-work.js';

const SAVED: readonly RunTerminalReason[] = [
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
  'error_during_execution',
  'timed_out',
  'stalled',
  'crash',
];

/** The status a run ends with for each reason, as the runner maps them. */
const STATUS_OF: Readonly<Record<RunTerminalReason, RunStatus>> = {
  success: 'completed',
  error_max_turns: 'failed',
  error_max_budget_usd: 'budget_exceeded',
  error_max_structured_output_retries: 'failed',
  error_during_execution: 'failed',
  permission_denied: 'failed',
  cancelled: 'cancelled',
  stalled: 'stalled',
  timed_out: 'timed_out',
  crash: 'failed',
  lease_expired: 'failed',
  shutdown: 'failed',
};

describe('which endings save their unfinished work', () => {
  it.each(runTerminalReasonSchema.options)('%s', (reason) => {
    expect(savesUnfinishedWork({ status: STATUS_OF[reason], terminalReason: reason })).toBe(
      SAVED.includes(reason),
    );
  });

  it('names exactly the saved set, in both directions', () => {
    expect([...SAVED_UNFINISHED_WORK_REASONS].sort()).toEqual([...SAVED].sort());
  });

  it('saves nothing for a run that kept its artifact, or one a person ended', () => {
    // BD-010's 2026-10-05 amendment: an artifact delivered in the over-cap turn is `completed`.
    expect(
      savesUnfinishedWork({ status: 'completed', terminalReason: 'error_max_budget_usd' }),
    ).toBe(false);
    // A take-over or a cancel ends `cancelled` whatever its interrupted turn reported.
    expect(savesUnfinishedWork({ status: 'cancelled', terminalReason: 'error_max_turns' })).toBe(
      false,
    );
  });
});

describe('whose unfinished work is saved', () => {
  const branch = 'agentic/ACME-1';

  it.each(agentRoleSchema.options)('the %s role', (role: AgentRole) => {
    expect(
      unfinishedWorkBranchFor({
        role,
        stage: 'implementation',
        mode: 'normal',
        checkoutRef: branch,
      }),
    ).toBe(role === 'developer' ? branch : null);
  });

  it('not a Developer run resolving conflicts, a shadow or review-only run, or a stageless one', () => {
    const developer = { role: 'developer' as const, checkoutRef: branch };
    expect(
      unfinishedWorkBranchFor({ ...developer, stage: 'conflict_resolution', mode: 'normal' }),
    ).toBeNull();
    expect(
      unfinishedWorkBranchFor({ ...developer, stage: 'implementation', mode: 'shadow' }),
    ).toBeNull();
    expect(
      unfinishedWorkBranchFor({ ...developer, stage: 'implementation', mode: 'review_only' }),
    ).toBeNull();
    expect(unfinishedWorkBranchFor({ ...developer, stage: null, mode: 'normal' })).toBeNull();
  });

  it('only onto an `agentic/*` branch it checked out', () => {
    const run = { role: 'developer' as const, stage: 'implementation', mode: 'normal' as const };
    expect(unfinishedWorkBranchFor({ ...run, checkoutRef: null })).toBeNull();
    expect(unfinishedWorkBranchFor({ ...run, checkoutRef: 'main' })).toBeNull();
    expect(unfinishedWorkBranchFor({ ...run, checkoutRef: 'feature/x' })).toBeNull();
    expect(unfinishedWorkBranchFor({ ...run, checkoutRef: 'agentic/a b' })).toBeNull();
    expect(unfinishedWorkBranchFor({ ...run, checkoutRef: 'agentic/AUT-6820' })).toBe(
      'agentic/AUT-6820',
    );
  });
});

describe('what the export says', () => {
  it('is a `wip:` commit naming the attempt, the stage and the ending', () => {
    expect(
      unfinishedWorkCommitMessage({
        attempt: 3,
        stage: 'implementation',
        terminalReason: 'error_max_turns',
      }),
    ).toBe('wip: unfinished attempt 3 of implementation (error_max_turns)');
  });

  it('is asked for only when the spec names a branch and the ending saves', () => {
    const spec = { unfinishedWorkBranch: 'agentic/ACME-1', stage: 'implementation', attempt: 1 };
    expect(
      unfinishedWorkExportFor(spec, { status: 'timed_out', terminalReason: 'timed_out' }),
    ).toEqual({
      branch: 'agentic/ACME-1',
      commitMessage: 'wip: unfinished attempt 1 of implementation (timed_out)',
    });
    expect(
      unfinishedWorkExportFor(spec, { status: 'completed', terminalReason: 'success' }),
    ).toBeNull();
    expect(
      unfinishedWorkExportFor(
        { ...spec, unfinishedWorkBranch: null },
        { status: 'failed', terminalReason: 'crash' },
      ),
    ).toBeNull();
    expect(
      unfinishedWorkExportFor(
        { ...spec, stage: null },
        { status: 'failed', terminalReason: 'crash' },
      ),
    ).toBeNull();
  });

  it('tells a person where the work is, pushed or not', () => {
    const pushed = savedWorkSentence({
      branch: 'agentic/ACME-1',
      commit_sha: '0123456789abcdef0123',
      pushed: true,
    });
    expect(pushed).toContain('pushed it to agentic/ACME-1');
    expect(pushed).toContain('(0123456789ab)');
    expect(pushed).toContain('a retry of this stage continues from that branch');
    const failed = savedWorkSentence({ branch: 'agentic/ACME-1', commit_sha: null, pushed: false });
    expect(failed).toContain('the push did not succeed');
    expect(failed).not.toContain('continues from');
  });
});
