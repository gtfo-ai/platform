/**
 * The core client's `GET offers` (S-26.7): the URL carries `?fields=held_elsewhere`, and a refusal's
 * message names the bare verb — `offers: …` — never the query. Its `GET claim-scope` (backlog 1456)
 * asks `?fields=unassigned_has_taker` only when told to.
 */
import {
  WORKER_CLAIM_SCOPE_TAKERS_QUERY,
  WORKER_OFFERS_HELD_ELSEWHERE_QUERY,
} from '@platform/contracts';
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

describe('GET claim-scope asks for unassigned_has_taker by name, only when told to (backlog 1456)', () => {
  const PROJECT = '00000000-0000-4000-8000-000000014561';
  const SCOPE = {
    claim_project_ids: null,
    projects: [{ id: PROJECT, key: 'ACME', name: 'Acme' }],
    claim_policy: 'mine',
  };

  it('sends the query with takers, none without, and parses an answer with and without the field', async () => {
    const urls: string[] = [];
    const bodies = [{ ...SCOPE, unassigned_has_taker: { [PROJECT]: false } }, SCOPE];
    const fetch: CoreFetch = async (url) => {
      urls.push(url);
      return answer(200, bodies[urls.length - 1]);
    };
    const client = createCoreClient({ baseUrl: 'https://core.example.test/', fetch });
    expect((await client.claimScope('wkr_fake', true)).unassigned_has_taker).toEqual({
      [PROJECT]: false,
    });
    // An older core ignores the query and sends no field: unknown, not an error.
    expect(await client.claimScope('wkr_fake')).not.toHaveProperty('unassigned_has_taker');
    expect(urls).toEqual([
      `https://core.example.test/api/worker/v1/claim-scope?${WORKER_CLAIM_SCOPE_TAKERS_QUERY}`,
      'https://core.example.test/api/worker/v1/claim-scope',
    ]);
  });
});
