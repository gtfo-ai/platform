/**
 * The typeahead's server half (`boundedTicketSearch`): a tracker that fails or does not answer in
 * time is `unavailable` — the dialog's quiet note — and never a 500, while a fault that is not the
 * tracker's still propagates. The route's mapping of each answer is `routes/task-start.test.ts`'s.
 */
import { IntegrationError, silentLogger } from '@platform/application';
import type { Id } from '@platform/contracts';
import { BindingLoadError } from '@platform/integrations';
import { describe, expect, it } from 'vitest';
import {
  boundedTicketSearch,
  TICKET_SEARCH_DEADLINE_MS,
  type TicketSearchServed,
} from './task-start.js';

const PROJECT = '00000000-0000-4000-8000-0000000000e9' as Id;
const options = (deadlineMs = 50) => ({ deadlineMs, logger: silentLogger, projectId: PROJECT });

describe('boundedTicketSearch', () => {
  it('answers the search when it is in time', async () => {
    const answer: TicketSearchServed = { status: 'ok', items: [] };
    await expect(boundedTicketSearch(async () => answer, options())).resolves.toBe(answer);
  });

  it('answers unavailable at the deadline, without waiting for the tracker', async () => {
    let settle: (value: TicketSearchServed) => void = () => undefined;
    const slow = new Promise<TicketSearchServed>((resolve) => {
      settle = resolve;
    });
    const started = Date.now();
    const answer = await boundedTicketSearch(() => slow, options(30));
    expect(answer).toEqual({
      status: 'unavailable',
      reason: 'the tracker did not answer within 30 ms',
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    settle({ status: 'ok', items: [] });
    expect(TICKET_SEARCH_DEADLINE_MS).toBe(5_000);
  });

  it('answers a tracker failure and an unloadable binding as unavailable, naming only the code', async () => {
    const refused = await boundedTicketSearch(async () => {
      throw new IntegrationError(
        'rate_limited',
        'jira-cloud',
        'provider words that stay in the log',
      );
    }, options());
    expect(refused).toEqual({
      status: 'unavailable',
      reason: 'the tracker could not be searched (rate_limited)',
    });
    const unloadable = await boundedTicketSearch(async () => {
      throw new BindingLoadError(PROJECT, null, 'the binding could not be loaded');
    }, options());
    expect(unloadable.status).toBe('unavailable');
  });

  it('lets any other fault propagate', async () => {
    await expect(
      boundedTicketSearch(async () => {
        throw new TypeError('a bug');
      }, options()),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
