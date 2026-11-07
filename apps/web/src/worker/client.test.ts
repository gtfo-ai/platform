/**
 * The local page's client on the wire (S-26.7): the claim-scope read asks in the policy's
 * vocabulary, a save **always** names the policy and sends `null` for every project (the card never
 * produces `[]`: `claim-policy-card.test.tsx`),
 * a pick carries the list's `as_of`, and a refused pick's owner reaches the page on the error.
 */
import { describe, expect, it, vi } from 'vitest';
import { CLAIM_SCOPE_POLICY_READ, createLocalClient, LocalCallError } from './client.js';

const PROJECT = '00000000-0000-4000-8000-000000026721';
const RUN = '00000000-0000-4000-8000-000000026722';
const OWNER = '00000000-0000-4000-8000-000000026723';
const AS_OF = '2026-11-07T10:00:00.000Z';

const SCOPE = { claim_project_ids: null, claim_policy: 'mine', projects: [] };

const recording = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls, client: createLocalClient(null, fetchImpl as unknown as typeof fetch) };
};

describe('the local client (S-26.7)', () => {
  it('reads the claim scope in the policy’s vocabulary', async () => {
    const { calls, client } = recording(200, SCOPE);
    await client.claimScope();
    expect(CLAIM_SCOPE_POLICY_READ).toBe('claim-scope?vocabulary=policy');
    expect(calls[0]?.url).toBe('/api/local/claim-scope?vocabulary=policy');
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('saves the policy always, with null for every project and a list as it is', async () => {
    const { calls, client } = recording(200, SCOPE);
    await client.setClaimScope('mine', null);
    await client.setClaimScope('pick_only', [PROJECT]);
    expect(calls.map((call) => JSON.parse(String(call.init.body)))).toEqual([
      { claim_project_ids: null, claim_policy: 'mine' },
      { claim_project_ids: [PROJECT], claim_policy: 'pick_only' },
    ]);
    expect(calls.every((call) => call.url === '/api/local/claim-scope')).toBe(true);
  });

  it('carries the list’s as_of with a pick, and nothing without one', async () => {
    const { calls, client } = recording(200, { run_id: RUN });
    await client.take(RUN, AS_OF);
    await client.take(RUN);
    expect(calls[0]?.url).toBe(`/api/local/offers/${RUN}/take`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ as_of: AS_OF });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({});
  });

  it('hands a refused pick’s owner to the page, and no owner for any other refusal', async () => {
    const owned = recording(409, {
      error: {
        code: 'task_owned_by_another',
        message: 'the core refused to hand over that run',
        owner: { user_id: OWNER, name: 'Vojtěch' },
      },
    });
    const refusal = await owned.client.take(RUN, AS_OF).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(LocalCallError);
    expect((refusal as LocalCallError).code).toBe('task_owned_by_another');
    expect((refusal as LocalCallError).owner).toEqual({ user_id: OWNER, name: 'Vojtěch' });

    const lost = recording(409, {
      error: { code: 'offer_not_claimable', message: 'this offer cannot be taken' },
    });
    const other = await lost.client.take(RUN).catch((error: unknown) => error);
    expect((other as LocalCallError).code).toBe('offer_not_claimable');
    expect((other as LocalCallError).owner).toBeUndefined();
  });
});
