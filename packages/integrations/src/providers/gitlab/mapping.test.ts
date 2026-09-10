/**
 * The mapping layer, and above all the three-state mergeability rule WP-26 depends on.
 *
 * The table below is driven from GitLab's own documented values rather than from a handful of
 * cases, because the failure this guards against is a *default*: a mapping that answers `false`
 * for a state it does not recognise turns "not computed yet" into "conflicted", and the rebase
 * gate then rebases a branch that has nothing wrong with it.
 */
import { IntegrationError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import {
  isDraftTitle,
  mapMergeability,
  mapMergeRequestState,
  mapPipelineStatus,
  pipelineStatusOrNull,
  terminalCiStatus,
  toIsoDateTime,
  toIsoDateTimeOrNull,
  withDraftPrefix,
  withoutDraftPrefix,
} from './mapping.js';
import { DETAILED_MERGE_STATUSES } from './schemas.js';

describe('mapMergeability', () => {
  it('reports a clean merge as mergeable with no conflicts', () => {
    expect(
      mapMergeability({
        mergeStatus: 'can_be_merged',
        detailedMergeStatus: 'mergeable',
        hasConflicts: false,
      }),
    ).toEqual({ mergeable: true, hasConflicts: false });
  });

  it('reports a conflicted merge request as not mergeable, with conflicts', () => {
    expect(
      mapMergeability({
        mergeStatus: 'cannot_be_merged',
        detailedMergeStatus: 'conflict',
        hasConflicts: true,
      }),
    ).toEqual({ mergeable: false, hasConflicts: true });
  });

  /**
   * The state the whole three-way distinction exists for.
   *
   * GitLab: "The mergeability (`merge_status`) … is checked asynchronously … Poll this API
   * endpoint to get the updated status. This affects the `has_conflicts` property … It returns
   * `false` unless `merge_status` is `cannot_be_merged`."
   *
   * So a `has_conflicts: false` alongside `unchecked` is not evidence of anything, and passing it
   * through would be the adapter being kinder than the provider.
   */
  it.each(['unchecked', 'checking', 'cannot_be_merged_recheck'])(
    'reports merge_status %s as not computed yet, never as false',
    (mergeStatus) => {
      const result = mapMergeability({
        mergeStatus,
        detailedMergeStatus: mergeStatus === 'cannot_be_merged_recheck' ? null : mergeStatus,
        hasConflicts: false,
      });
      expect(result.mergeable, `merge_status ${mergeStatus}`).toBeNull();
      expect(
        result.hasConflicts,
        `has_conflicts is false by construction while ${mergeStatus}, so it must not be reported`,
      ).toBeNull();
    },
  );

  it('lets detailed_merge_status checking/unchecked/preparing veto a stale merge_status', () => {
    for (const detailed of ['checking', 'unchecked', 'preparing']) {
      expect(
        mapMergeability({
          mergeStatus: 'can_be_merged',
          detailedMergeStatus: detailed,
          hasConflicts: false,
        }),
        `detailed_merge_status ${detailed}`,
      ).toEqual({ mergeable: null, hasConflicts: null });
    }
  });

  /**
   * `detailed_merge_status` answers "may GitLab merge this now", which folds in CI, approvals and
   * draft status. Those are not facts about whether the branches merge.
   *
   * Mutation: map every non-`mergeable` detailed status to `mergeable: false`, and this fails —
   * which is the bug that would send WP-26 rebasing a branch whose only problem is a red pipeline.
   */
  it('never turns a blocking reason into "not mergeable" when merge_status says otherwise', () => {
    for (const detailed of [
      'ci_must_pass',
      'ci_still_running',
      'discussions_not_resolved',
      'draft_status',
      'not_approved',
      'requested_changes',
      'status_checks_must_pass',
      'merge_request_blocked',
    ]) {
      expect(
        mapMergeability({
          mergeStatus: 'can_be_merged',
          detailedMergeStatus: detailed,
          hasConflicts: false,
        }),
        `a branch that merges cleanly but is blocked by ${detailed}`,
      ).toEqual({ mergeable: true, hasConflicts: false });
    }
  });

  it('falls back to detailed_merge_status when merge_status is gone (deprecated in 15.6)', () => {
    expect(
      mapMergeability({ mergeStatus: null, detailedMergeStatus: 'mergeable', hasConflicts: null }),
    ).toEqual({ mergeable: true, hasConflicts: false });
    expect(
      mapMergeability({ mergeStatus: null, detailedMergeStatus: 'conflict', hasConflicts: null }),
    ).toEqual({ mergeable: false, hasConflicts: true });
  });

  it('answers null, never false, for a blocking reason it cannot interpret alone', () => {
    expect(
      mapMergeability({
        mergeStatus: null,
        detailedMergeStatus: 'not_approved',
        hasConflicts: null,
      }),
    ).toEqual({ mergeable: null, hasConflicts: null });
    expect(
      mapMergeability({ mergeStatus: null, detailedMergeStatus: null, hasConflicts: null }),
    ).toEqual({ mergeable: null, hasConflicts: null });
  });

  /**
   * WP-09 review round 1, should-fix 2. `can_be_merged` beside `detailed_merge_status: conflict`
   * used to answer `{ mergeable: true, hasConflicts: true }` — self-contradictory, and optimistic
   * in exactly the place a gate trusts. `merge_status` was deprecated in 15.6; its successor wins.
   */
  it('believes the successor field when the two disagree, and never both at once', () => {
    const result = mapMergeability({
      mergeStatus: 'can_be_merged',
      detailedMergeStatus: 'conflict',
      hasConflicts: false,
    });
    expect(
      result.mergeable,
      'a merge request with a conflict is not mergeable, whatever the deprecated field says',
    ).toBe(false);
    expect(result.hasConflicts, 'and the conflict is reported').toBe(true);
    expect(
      result.mergeable === true && result.hasConflicts === true,
      'mergeable *and* conflicted is not a state a caller can act on',
    ).toBe(false);
  });

  /**
   * The branch WP-09's reviewer mutated to `?? false` and watched 251 tests pass.
   *
   * `has_conflicts` is documented to mean something only while `merge_status` is
   * `cannot_be_merged`, and an instance that does not publish the field at all leaves the question
   * open. `false` there would be the adapter's kindest divergence — "it cannot be merged, but
   * don't worry, there are no conflicts" — so it takes a positive assertion, not a comment
   * (standing rule 12).
   */
  it('answers unknown, not "no conflicts", when a blocked merge request publishes no flag', () => {
    for (const hasConflicts of [undefined, null]) {
      const result = mapMergeability({
        mergeStatus: 'cannot_be_merged',
        detailedMergeStatus: null,
        hasConflicts,
      });
      expect(result.mergeable, 'cannot_be_merged is still a decided "no"').toBe(false);
      expect(
        result.hasConflicts,
        `has_conflicts ${String(hasConflicts)} is an absent field, and an absent field is not a false one`,
      ).toBeNull();
      expect(result.hasConflicts, 'and above all it is not false').not.toBe(false);
    }
  });

  it('still reports a published has_conflicts on a blocked merge request', () => {
    // The positive control for the assertion above: the field is read when GitLab publishes it.
    expect(
      mapMergeability({
        mergeStatus: 'cannot_be_merged',
        detailedMergeStatus: 'broken_status',
        hasConflicts: true,
      }).hasConflicts,
    ).toBe(true);
    expect(
      mapMergeability({
        mergeStatus: 'cannot_be_merged',
        detailedMergeStatus: 'broken_status',
        hasConflicts: false,
      }).hasConflicts,
    ).toBe(false);
  });

  /** No documented value may produce a `mergeable: false` that is not about the merge itself. */
  it('never reports false for a documented detailed status other than conflict', () => {
    for (const detailed of DETAILED_MERGE_STATUSES) {
      const result = mapMergeability({
        mergeStatus: null,
        detailedMergeStatus: detailed,
        hasConflicts: null,
      });
      if (detailed === 'conflict') {
        expect(result.mergeable).toBe(false);
      } else {
        expect(result.mergeable, `detailed_merge_status ${detailed}`).not.toBe(false);
      }
    }
  });
});

describe('mapPipelineStatus', () => {
  it.each([
    ['created', 'pending'],
    ['waiting_for_resource', 'pending'],
    ['preparing', 'pending'],
    ['waiting_for_callback', 'pending'],
    ['scheduled', 'pending'],
    ['pending', 'pending'],
    ['running', 'running'],
    ['canceling', 'running'],
    ['manual', 'manual'],
    ['success', 'success'],
    ['failed', 'failed'],
    ['canceled', 'canceled'],
    ['skipped', 'skipped'],
  ])('maps %s to %s', (gitlab, expected) => {
    expect(mapPipelineStatus(gitlab, 'probe')).toBe(expected);
  });

  it('refuses a status GitLab has added since the table was transcribed', () => {
    // Loud beats a default: the only "safe" default here would report a green pipeline as red.
    expect(() => mapPipelineStatus('teleported', 'probe')).toThrow(IntegrationError);
  });

  it('treats canceling as in flight, so a CI gate does not read it as a result', () => {
    expect(terminalCiStatus(mapPipelineStatus('canceling', 'probe'))).toBeNull();
    expect(terminalCiStatus(mapPipelineStatus('canceled', 'probe'))).toBe('canceled');
  });

  /**
   * The two callers deserve opposite answers, which is why there are two functions: a read the
   * platform asked for must not invent a state, and an inbound notification must not become a
   * permanently failing job (WP-09 review round 1).
   */
  it('answers null for an unknown status where a caller has to keep going', () => {
    expect(pipelineStatusOrNull('waiting_for_quantum_runner')).toBeNull();
    expect(pipelineStatusOrNull('success'), 'and the table is the same table').toBe('success');
    expect(
      () => mapPipelineStatus('waiting_for_quantum_runner', 'probe'),
      'while the throwing variant still refuses, for the read path',
    ).toThrow(IntegrationError);
  });
});

describe('draft titles', () => {
  // There is no `draft` parameter on POST or PUT /merge_requests; the title prefix is the API.
  it.each(['Draft: add the parser', '[Draft] add the parser', '(Draft) add the parser'])(
    'recognises the documented prefix in %s',
    (title) => {
      expect(isDraftTitle(title)).toBe(true);
      expect(withoutDraftPrefix(title)).toBe('add the parser');
    },
  );

  it('does not mistake a title that merely mentions drafting', () => {
    expect(isDraftTitle('Redraft the parser')).toBe(false);
    expect(isDraftTitle('add the draft parser')).toBe(false);
  });

  it('adds the prefix once and only once', () => {
    expect(withDraftPrefix('add the parser')).toBe('Draft: add the parser');
    expect(withDraftPrefix('Draft: add the parser')).toBe('Draft: add the parser');
  });

  it('strips a repeated prefix', () => {
    expect(withoutDraftPrefix('Draft: [Draft] add the parser')).toBe('add the parser');
  });
});

describe('timestamps', () => {
  it('accepts the REST form', () => {
    expect(toIsoDateTime('2018-03-03T21:54:39.668Z', 'probe')).toBe('2018-03-03T21:54:39.668Z');
  });

  it('accepts the webhook form "2015-05-17 18:21:36 UTC"', () => {
    expect(toIsoDateTime('2015-05-17 18:21:36 UTC', 'probe')).toBe('2015-05-17T18:21:36.000Z');
  });

  it('refuses a timestamp it cannot parse rather than emitting Invalid Date', () => {
    expect(() => toIsoDateTime('yesterday', 'probe')).toThrow(IntegrationError);
  });

  it('passes null through', () => {
    expect(toIsoDateTimeOrNull(null, 'probe')).toBeNull();
    expect(toIsoDateTimeOrNull(undefined, 'probe')).toBeNull();
  });
});

describe('mapMergeRequestState', () => {
  it.each(['opened', 'closed', 'merged', 'locked'])('accepts %s', (state) => {
    expect(mapMergeRequestState(state)).toBe(state);
  });

  it('refuses an unknown state', () => {
    expect(() => mapMergeRequestState('quantum')).toThrow(IntegrationError);
  });
});
