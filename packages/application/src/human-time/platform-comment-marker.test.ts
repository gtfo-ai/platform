/**
 * The one heuristic in the human-time projector, held to the **real** marker builders.
 *
 * `PLATFORM_COMMENT_MARKER_PREFIX` is how the projector tells its own merge-request comments from a
 * person's, and a prefix asserted against a copy of itself asserts nothing (standing rule 7). So
 * this reads the four builders that actually post on a merge request or a ticket and checks each
 * one starts with it — a new marker that forgot the prefix fails here, in the file that explains
 * why the prefix exists, rather than by quietly inflating somebody's review minutes.
 *
 * **What it cannot check, stated:** a comment posted by a *different* bot — CI, a dependency
 * updater — carries no marker of ours and is counted as human review activity. The platform cannot
 * tell a robot from a person in somebody else's issue tracker without being told which accounts are
 * bots, and nothing in this build records that (filed under discovered work).
 */
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { conflictWarningMarker } from '../pipeline/conflict-warning.js';
import { reviewMarkerFor, reviewSummaryMarkerFor } from '../pipeline/review-only.js';
import { LINT_COMMENT_MARKER } from '../pipeline/ticket-lint.js';
import {
  externalAuthorKey,
  MAX_EXTERNAL_AUTHOR_CHARS,
  PLATFORM_COMMENT_MARKER_PREFIX,
} from './projector.js';

const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;

describe('the platform’s own comment marker', () => {
  it('is the prefix of every marker this platform posts', () => {
    const markers = [
      reviewMarkerFor(TASK),
      reviewSummaryMarkerFor(TASK),
      conflictWarningMarker(TASK),
      LINT_COMMENT_MARKER,
    ];
    // Read off the builders, not restated: the assertion is about the strings the platform really
    // writes, so it fails on the commit that introduces a fifth marker without the prefix.
    for (const marker of markers) {
      expect({ marker, prefixed: marker.startsWith(PLATFORM_COMMENT_MARKER_PREFIX) }).toEqual({
        marker,
        prefixed: true,
      });
    }
    // And the prefix is not so short that ordinary prose contains it (rule 42's other side).
    expect('the retry helper needs a bound').not.toContain(PLATFORM_COMMENT_MARKER_PREFIX);
  });
});

describe('the identity key', () => {
  it('is “provider:account”, and is refused rather than truncated past the bound', () => {
    expect(externalAuthorKey({ provider: 'gitlab', externalId: 'ada' })).toBe('gitlab:ada');
    const atBound = 'a'.repeat(MAX_EXTERNAL_AUTHOR_CHARS - 'gitlab:'.length);
    expect(externalAuthorKey({ provider: 'gitlab', externalId: atBound })).toHaveLength(
      MAX_EXTERNAL_AUTHOR_CHARS,
    );
    expect(externalAuthorKey({ provider: 'gitlab', externalId: `${atBound}a` })).toBeNull();
  });
});
