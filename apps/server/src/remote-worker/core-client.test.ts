/**
 * The core client's `GET offers` (S-26.7): the URL carries `?fields=held_elsewhere`, and a refusal's
 * message names the bare verb — `offers: …` — never the query.
 */
import { WORKER_OFFERS_HELD_ELSEWHERE_QUERY } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { CoreCallError, type CoreFetch, createCoreClient } from './core-client.js';

const answer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('GET offers asks for held_elsewhere, and says a refusal by its verb (S-26.7)', () => {
  it('sends the query in the URL only', async () => {
    const urls: string[] = [];
    const fetch: CoreFetch = async (url) => {
      urls.push(url);
      return answer(409, { error: { code: 'something_new', message: 'not now' } });
    };
    const client = createCoreClient({ baseUrl: 'https://core.example.test/', fetch });
    const refusal = await client.offers('wkr_fake').catch((error: unknown) => error);
    expect(urls).toEqual([
      `https://core.example.test/api/worker/v1/offers?${WORKER_OFFERS_HELD_ELSEWHERE_QUERY}`,
    ]);
    expect(refusal).toBeInstanceOf(CoreCallError);
    expect((refusal as CoreCallError).code).toBe('something_new');
    expect((refusal as CoreCallError).message).toBe('offers: not now');
  });
});
