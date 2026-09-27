/**
 * When an undelivered notification is counted as *not told* (WP-65, PROGRESS backlog 81): the
 * bounds are derived from the queues' own retry policies, so they move when a policy does.
 */
import type { IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { PIPELINE_OUTBOUND_RETRY, retryWindowMs } from '../pipeline/jobs.js';
import { DIGEST_RETRY } from './digest.js';
import {
  DIGEST_UNDELIVERED_AFTER_MS,
  IMMEDIATE_UNDELIVERED_AFTER_MS,
  undeliveredNotificationBounds,
} from './undelivered.js';

describe('the retry window of a queue', () => {
  it('is every attempt’s expiry plus every backoff delay at its worst case', () => {
    // pipeline.outbound: 2 retries, 30 s backoff → at most 60 s + 120 s, and 3 attempts × 900 s.
    expect(retryWindowMs(PIPELINE_OUTBOUND_RETRY)).toBe((60 + 120 + 3 * 900) * 1000);
    // Without backoff each retry waits the plain delay.
    expect(
      retryWindowMs({
        retryLimit: 1,
        retryDelaySeconds: 30,
        retryBackoff: false,
        expireInSeconds: 60,
      }),
    ).toBe((30 + 2 * 60) * 1000);
  });
});

describe('the undelivered bounds', () => {
  it('counts an immediate row past the outbound window, and a digest row past a day and the digest job', () => {
    expect(IMMEDIATE_UNDELIVERED_AFTER_MS).toBe(retryWindowMs(PIPELINE_OUTBOUND_RETRY));
    expect(DIGEST_UNDELIVERED_AFTER_MS).toBe(
      24 * 60 * 60 * 1000 + 5 * 60 * 1000 + retryWindowMs(DIGEST_RETRY),
    );
    const at = '2026-06-02T12:00:00.000Z' as IsoDateTime;
    const bounds = undeliveredNotificationBounds(at);
    expect(Date.parse(at) - Date.parse(bounds.immediateBefore)).toBe(
      IMMEDIATE_UNDELIVERED_AFTER_MS,
    );
    expect(Date.parse(at) - Date.parse(bounds.digestBefore)).toBe(DIGEST_UNDELIVERED_AFTER_MS);
    // A digest row may legitimately wait a day; an immediate one may not.
    expect(bounds.digestBefore < bounds.immediateBefore).toBe(true);
  });
});
