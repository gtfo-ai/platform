/**
 * Issuing, recording and confirming a self-service link (S-26.6) over an in-memory
 * `IdentityLinkStore` — every branch of the recorder and the confirmation in the fast tier. The
 * PostgreSQL adapter is held to the same answers, with real locks and the real inbound path, by
 * `test/integration/identity/identity-links.integration.test.ts`.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type {
  IdentityLinkStore,
  LinkAuthorEntry,
  LinkedIdentity,
  StoredLinkCode,
  StoredLinkMatch,
} from '../ports/identity-links.js';
import type { LinkCodeClaim } from '../ports/integrations/common.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { createIdentityLinks, decideLiveCode, isLiveLinkCode } from './identity-links.js';
import { hashLinkCode, LINK_CODE_TTL_MS } from './link-codes.js';

const ALICE = '00000000-0000-4000-8000-0000000000a1' as Id;
const BOB = '00000000-0000-4000-8000-0000000000a2' as Id;
const INTEGRATION = '00000000-0000-4000-8000-0000000000e1' as Id;
const START = Date.parse('2026-11-07T10:00:00.000Z');
const TX = { adapter: 'memory' } as Transaction;

/** The store's semantics without a database: the partial unique indexes, the never-overwrite link. */
const memoryStore = () => {
  const codes: StoredLinkCode[] = [];
  const matches: (StoredLinkMatch & { outcome: 'match' })[] = [];
  const authorRows: (LinkAuthorEntry & { outcome: 'miss' | 'ignored' })[] = [];
  const identities = new Map<string, LinkedIdentity & { displayName: string | null }>();
  const bindingAccounts = new Set<string>();
  const key = (provider: string, externalId: string) => `${provider}\0${externalId}`;
  const replace = (code: StoredLinkCode) => {
    codes[codes.findIndex((entry) => entry.id === code.id)] = code;
  };
  const store: IdentityLinkStore = {
    lockUser: async () => undefined,
    countIssuedSince: async (_tx, userId, since) => {
      const issued = codes.filter(
        (code) => code.userId === userId && Date.parse(code.createdAt) >= Date.parse(since),
      );
      return { count: issued.length, oldest: issued[0]?.createdAt ?? null };
    },
    voidOpen: async (_tx, userId, at, reason) => {
      let count = 0;
      for (const code of codes.filter(
        (entry) => entry.userId === userId && entry.consumedAt === null && entry.voidedAt === null,
      )) {
        replace({ ...code, voidedAt: at, voidReason: reason });
        count += 1;
      }
      return count;
    },
    insertCode: async (_tx, code) => {
      codes.push({
        ...code,
        consumedAt: null,
        consumedMatchId: null,
        voidedAt: null,
        voidReason: null,
      });
    },
    lockCodeByHash: async (_tx, hash) => codes.find((code) => code.codeHash === hash) ?? null,
    lockCode: async (_tx, id) => codes.find((code) => code.id === id) ?? null,
    voidCode: async (_tx, id, at, reason) => {
      const code = codes.find((entry) => entry.id === id);
      if (code !== undefined && code.consumedAt === null && code.voidedAt === null) {
        replace({ ...code, voidedAt: at, voidReason: reason });
      }
    },
    consume: async (_tx, codeId, matchId, at) => {
      const code = codes.find((entry) => entry.id === codeId);
      if (code !== undefined && code.consumedAt === null && code.voidedAt === null) {
        replace({ ...code, consumedAt: at, consumedMatchId: matchId });
      }
      const match = matches.find((entry) => entry.id === matchId);
      if (match !== undefined) {
        matches[matches.indexOf(match)] = { ...match, confirmedAt: at };
      }
    },
    matchesOf: async (_tx, codeId) => matches.filter((match) => match.codeId === codeId),
    findMatch: async (_tx, id) => matches.find((match) => match.id === id) ?? null,
    insertMatch: async (_tx, match) => {
      if (
        matches.some(
          (entry) =>
            entry.codeId === match.codeId &&
            entry.provider === match.provider &&
            entry.externalId === match.externalId,
        )
      ) {
        return false;
      }
      matches.push({ ...match, outcome: 'match', confirmedAt: null });
      return true;
    },
    insertMiss: async (_tx, entry) => {
      if (
        authorRows.some(
          (row) =>
            row.outcome === 'miss' &&
            row.provider === entry.provider &&
            row.externalId === entry.externalId &&
            row.commentId === entry.commentId,
        )
      ) {
        return false;
      }
      authorRows.push({ ...entry, outcome: 'miss' });
      return true;
    },
    insertIgnored: async (_tx, entry) => {
      authorRows.push({ ...entry, outcome: 'ignored' });
    },
    countMissesSince: async (_tx, author, since) =>
      authorRows.filter(
        (row) =>
          row.outcome === 'miss' &&
          row.provider === author.provider &&
          row.externalId === author.externalId &&
          Date.parse(row.at) >= Date.parse(since),
      ).length,
    ignoredSince: async (_tx, author, since) =>
      authorRows.some(
        (row) =>
          row.outcome === 'ignored' &&
          row.provider === author.provider &&
          row.externalId === author.externalId &&
          Date.parse(row.at) >= Date.parse(since),
      ),
    identityOf: async (_tx, author) => {
      const row = identities.get(key(author.provider, author.externalId));
      return row === undefined ? null : { kind: row.kind, userId: row.userId };
    },
    isBindingAccount: async (_tx, author) =>
      bindingAccounts.has(key(author.provider, author.externalId)),
    linkIdentity: async (_tx, input) => {
      const existing = identities.get(key(input.provider, input.externalId));
      if (existing === undefined) {
        identities.set(key(input.provider, input.externalId), {
          kind: 'person',
          userId: input.userId,
          displayName: input.displayName,
        });
        return 'linked';
      }
      if (existing.kind === 'machine') {
        return 'machine';
      }
      return existing.userId === input.userId ? 'already_linked' : 'linked_elsewhere';
    },
    readState: async () => ({ code: null, matches: [] }),
  };
  return { store, codes, matches, authorRows, identities, bindingAccounts, key };
};

const harness = (options: { readonly codes?: readonly string[] } = {}) => {
  const memory = memoryStore();
  let now = START;
  let next = 0;
  const queue = [...(options.codes ?? [])];
  const unitOfWork: UnitOfWork = {
    transaction: async (fn) => fn({ tx: TX } as never),
  };
  const links = createIdentityLinks({
    store: memory.store,
    unitOfWork,
    ids: {
      next: () => {
        next += 1;
        return `00000000-0000-4000-9000-${String(next).padStart(12, '0')}` as Id;
      },
    },
    clock: { now: () => new Date(now).toISOString() as IsoDateTime },
    // A named code per issue, so a test knows the code it posts; byte & 31 picks the character.
    draw: (size) => {
      const code = queue.shift();
      if (code === undefined) {
        return new Uint8Array(size).fill(7);
      }
      const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      return Uint8Array.from(code.split('').map((character) => alphabet.indexOf(character)));
    },
  });
  const claim = (overrides: Partial<LinkCodeClaim> & { code?: string } = {}): LinkCodeClaim => ({
    provider: 'jira-cloud',
    externalId: '557058:dev-one',
    displayName: 'Dev One',
    commentId: '10105',
    codeHashes: [hashLinkCode(overrides.code ?? 'agentic-link-7K3Q9VDM2X')],
    refusal: null,
    ...overrides,
  });
  return {
    ...memory,
    links,
    claim,
    record: (claims: readonly LinkCodeClaim[]) =>
      links.recorder.record(TX, { integrationId: INTEGRATION, claims }),
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('decideLiveCode', () => {
  const author = { provider: 'jira-cloud', externalId: 'a' };
  it('is a match, a repeat, a second author or an account linked to someone else', () => {
    expect(decideLiveCode({ codeUserId: ALICE, author, identity: null, matches: [] })).toBe(
      'match',
    );
    expect(decideLiveCode({ codeUserId: ALICE, author, identity: null, matches: [author] })).toBe(
      'already_matched',
    );
    expect(
      decideLiveCode({
        codeUserId: ALICE,
        author,
        identity: null,
        matches: [{ provider: 'jira-cloud', externalId: 'b' }],
      }),
    ).toBe('second_author');
    // The same external id on another provider is another account.
    expect(
      decideLiveCode({
        codeUserId: ALICE,
        author,
        identity: null,
        matches: [{ provider: 'gitlab', externalId: 'a' }],
      }),
    ).toBe('second_author');
    expect(
      decideLiveCode({
        codeUserId: ALICE,
        author,
        identity: { kind: 'person', userId: BOB },
        matches: [],
      }),
    ).toBe('linked_elsewhere');
    expect(
      decideLiveCode({
        codeUserId: ALICE,
        author,
        identity: { kind: 'person', userId: ALICE },
        matches: [],
      }),
    ).toBe('match');
  });
});

describe('issuing a code (acceptance 1)', () => {
  it('stores only the hash, expires in 30 minutes, and one is live per user', async () => {
    const h = harness({ codes: ['7K3Q9VDM2X', '0123456789'] });
    const first = await h.links.issue(ALICE);
    expect(first).toMatchObject({ kind: 'issued', code: 'agentic-link-7K3Q9VDM2X' });
    expect(h.codes[0]?.codeHash).toBe(hashLinkCode('agentic-link-7K3Q9VDM2X'));
    expect(JSON.stringify(h.codes)).not.toContain('7K3Q9VDM2X');
    expect(Date.parse(h.codes[0]?.expiresAt ?? '')).toBe(START + LINK_CODE_TTL_MS);

    await h.links.issue(ALICE);
    expect(h.codes.map((code) => code.voidReason)).toEqual(['replaced', null]);
    expect(
      h.codes.filter((code) => isLiveLinkCode(code, h.codes[1]?.createdAt as IsoDateTime)),
    ).toHaveLength(1);
  });

  it('issues at most five per user per hour, and answers how long to wait', async () => {
    const h = harness();
    for (let index = 0; index < 5; index += 1) {
      expect((await h.links.issue(ALICE)).kind).toBe('issued');
      h.advance(60_000);
    }
    const sixth = await h.links.issue(ALICE);
    expect(sixth).toEqual({ kind: 'rate_limited', retryAfterMs: 55 * 60_000 });
    // Another user is not limited by Alice's codes.
    expect((await h.links.issue(BOB)).kind).toBe('issued');
    // Just past an hour after the first, one slot is free again (the window includes its start).
    h.advance(55 * 60_000 + 1);
    expect((await h.links.issue(ALICE)).kind).toBe('issued');
  });
});

describe('recording a comment (acceptance 2 and 3)', () => {
  it('(a) records a match and writes no user_identities row', async () => {
    const h = harness({ codes: ['7K3Q9VDM2X'] });
    await h.links.issue(ALICE);
    const summary = await h.record([h.claim()]);
    expect(summary).toMatchObject({ matched: 1, missed: 0, voided: [], refused: [] });
    expect(h.matches).toHaveLength(1);
    expect(h.matches[0]).toMatchObject({ externalId: '557058:dev-one', commentId: '10105' });
    expect(h.identities.size).toBe(0);
  });

  it('records one claim once, even when two bound projects normalised it', async () => {
    const h = harness({ codes: ['7K3Q9VDM2X'] });
    await h.links.issue(ALICE);
    await h.record([h.claim(), h.claim()]);
    await h.record([h.claim()]);
    expect(h.matches).toHaveLength(1);
  });

  it('(b) a second distinct author voids the code — the JSM customer or guest who copied it', async () => {
    const h = harness({ codes: ['7K3Q9VDM2X'] });
    await h.links.issue(ALICE);
    await h.record([h.claim({ externalId: 'qm:jsm-customer', displayName: 'Customer' })]);
    const second = await h.record([h.claim({ commentId: '10106' })]);
    expect(second.voided).toEqual(['second_author']);
    expect(h.codes[0]?.voidReason).toBe('second_author');
    // The owner's confirmation of either match is refused.
    for (const match of h.matches) {
      expect(await h.links.confirm(ALICE, match.id)).toEqual({
        kind: 'refused',
        reason: 'code_voided',
        voidReason: 'second_author',
      });
    }
    expect(h.identities.size).toBe(0);
  });

  it('voids the code for an author linked to someone else (identity_linked_elsewhere)', async () => {
    const h = harness({ codes: ['7K3Q9VDM2X'] });
    await h.links.issue(ALICE);
    h.identities.set(h.key('jira-cloud', '557058:dev-one'), {
      kind: 'person',
      userId: BOB,
      displayName: null,
    });
    const summary = await h.record([h.claim()]);
    expect(summary.voided).toEqual(['identity_linked_elsewhere']);
    expect(h.matches).toHaveLength(0);
    expect(h.codes[0]?.voidReason).toBe('identity_linked_elsewhere');
  });

  it('records nothing for a machine identity, or any binding’s stored account', async () => {
    const h = harness({ codes: ['7K3Q9VDM2X'] });
    await h.links.issue(ALICE);
    h.identities.set(h.key('jira-cloud', 'bot-ci'), {
      kind: 'machine',
      userId: null,
      displayName: null,
    });
    h.bindingAccounts.add(h.key('jira-cloud', '557058:agentic-bot'));
    const summary = await h.record([
      h.claim({ externalId: 'bot-ci' }),
      h.claim({ externalId: '557058:agentic-bot' }),
    ]);
    expect(summary.refused).toEqual(['machine_identity', 'binding_account_stored']);
    expect(h.matches).toHaveLength(0);
    expect(h.authorRows).toHaveLength(0);
    expect(h.codes[0]?.voidedAt).toBeNull();
  });

  it('records nothing for a claim the comment already refused (an edit, a marker, …)', async () => {
    const h = harness({ codes: ['7K3Q9VDM2X'] });
    await h.links.issue(ALICE);
    const summary = await h.record([
      h.claim({ refusal: 'edited' }),
      h.claim({ refusal: 'edited_by_another', commentId: '2' }),
      h.claim({ refusal: 'platform_marker', commentId: '3' }),
      h.claim({ refusal: 'binding_account', commentId: '4' }),
    ]);
    expect(summary.refused).toEqual([
      'edited',
      'edited_by_another',
      'platform_marker',
      'binding_account',
    ]);
    expect(h.matches).toHaveLength(0);
    expect(h.authorRows).toHaveLength(0);
  });

  it('counts a code that is no live code as a miss — unknown, expired, consumed or voided', async () => {
    const h = harness({ codes: ['7K3Q9VDM2X'] });
    await h.links.issue(ALICE);
    h.advance(LINK_CODE_TTL_MS);
    const expired = await h.record([h.claim()]);
    expect(expired).toMatchObject({ matched: 0, missed: 1 });
    const unknown = await h.record([h.claim({ code: 'agentic-link-ZZZZZZZZZZ', commentId: '2' })]);
    expect(unknown.missed).toBe(1);
    expect(h.authorRows.map((row) => row.outcome)).toEqual(['miss', 'miss']);
  });

  it('ignores an author for the day after five misses, with one audit row, then even a good code', async () => {
    const h = harness({ codes: ['7K3Q9VDM2X'] });
    await h.links.issue(ALICE);
    for (let index = 1; index <= 4; index += 1) {
      const summary = await h.record([
        h.claim({ code: 'agentic-link-ZZZZZZZZZZ', commentId: `guess-${index}` }),
      ]);
      expect(summary.ignored).toEqual([]);
    }
    const fifth = await h.record([
      h.claim({ code: 'agentic-link-ZZZZZZZZZZ', commentId: 'guess-5' }),
    ]);
    expect(fifth.ignored).toEqual([{ provider: 'jira-cloud', externalId: '557058:dev-one' }]);
    expect(h.authorRows.filter((row) => row.outcome === 'ignored')).toHaveLength(1);
    // The real code, from the ignored author, records nothing.
    const real = await h.record([h.claim({ commentId: 'real' })]);
    expect(real.refused).toEqual(['author_ignored']);
    expect(h.matches).toHaveLength(0);
    // A day later the author is heard again.
    h.advance(24 * 60 * 60_000 + 1);
    await h.links.issue(ALICE);
    expect((await h.record([h.claim({ commentId: 'later' })])).refused).toEqual([]);
  });

  it('does not count one comment’s misses twice when the thread is read again', async () => {
    const h = harness();
    for (let index = 0; index < 6; index += 1) {
      await h.record([h.claim({ code: 'agentic-link-ZZZZZZZZZZ' })]);
    }
    expect(h.authorRows.filter((row) => row.outcome === 'miss')).toHaveLength(1);
    expect(h.authorRows.filter((row) => row.outcome === 'ignored')).toHaveLength(0);
  });
});

describe('confirming a match (acceptance 2 (a), 3 (b))', () => {
  const matched = async () => {
    const h = harness({ codes: ['7K3Q9VDM2X'] });
    await h.links.issue(ALICE);
    await h.record([h.claim()]);
    const match = h.matches[0] as StoredLinkMatch;
    return { h, match };
  };

  it('links the matched account to its person, once, and consumes the code', async () => {
    const { h, match } = await matched();
    expect(await h.links.confirm(ALICE, match.id)).toEqual({
      kind: 'linked',
      matchId: match.id,
      provider: 'jira-cloud',
      externalId: '557058:dev-one',
      displayName: 'Dev One',
      replayed: false,
    });
    expect(h.identities.get(h.key('jira-cloud', '557058:dev-one'))).toMatchObject({
      kind: 'person',
      userId: ALICE,
    });
    expect(h.codes[0]?.consumedMatchId).toBe(match.id);
    // A retry answers the link it made; nothing is written twice.
    expect(await h.links.confirm(ALICE, match.id)).toMatchObject({
      kind: 'linked',
      replayed: true,
    });
  });

  it('answers another person’s match as no match at all', async () => {
    const { h, match } = await matched();
    expect(await h.links.confirm(BOB, match.id)).toEqual({
      kind: 'refused',
      reason: 'match_not_found',
    });
    expect(h.identities.size).toBe(0);
  });

  it('expires an unconfirmed match with its code', async () => {
    const { h, match } = await matched();
    h.advance(LINK_CODE_TTL_MS);
    expect(await h.links.confirm(ALICE, match.id)).toEqual({
      kind: 'refused',
      reason: 'code_expired',
    });
    expect(h.identities.size).toBe(0);
  });

  it('re-checks a second author at the confirmation, and voids the code', async () => {
    const { h, match } = await matched();
    // A second author's match arrived by a path that did not void it (a race the lock serialises).
    h.matches.push({ ...match, id: 'other' as Id, externalId: 'guest-two', outcome: 'match' });
    expect(await h.links.confirm(ALICE, match.id)).toEqual({
      kind: 'refused',
      reason: 'code_voided',
      voidReason: 'second_author',
    });
    expect(h.codes[0]?.voidReason).toBe('second_author');
    expect(h.identities.size).toBe(0);
  });

  it('refuses an account that became somebody else’s, a machine or a binding’s since the match', async () => {
    const elsewhere = await matched();
    elsewhere.h.identities.set(elsewhere.h.key('jira-cloud', '557058:dev-one'), {
      kind: 'person',
      userId: BOB,
      displayName: null,
    });
    expect((await elsewhere.h.links.confirm(ALICE, elsewhere.match.id)).kind).toBe('refused');
    expect(elsewhere.h.codes[0]?.voidReason).toBe('identity_linked_elsewhere');

    const machine = await matched();
    machine.h.identities.set(machine.h.key('jira-cloud', '557058:dev-one'), {
      kind: 'machine',
      userId: null,
      displayName: null,
    });
    expect(await machine.h.links.confirm(ALICE, machine.match.id)).toEqual({
      kind: 'refused',
      reason: 'identity_is_machine',
    });

    const binding = await matched();
    binding.h.bindingAccounts.add(binding.h.key('jira-cloud', '557058:dev-one'));
    expect(await binding.h.links.confirm(ALICE, binding.match.id)).toEqual({
      kind: 'refused',
      reason: 'identity_is_binding_account',
    });
  });

  it('refuses a match whose code a later code replaced', async () => {
    const { h, match } = await matched();
    await h.links.issue(ALICE);
    expect(await h.links.confirm(ALICE, match.id)).toEqual({
      kind: 'refused',
      reason: 'code_voided',
      voidReason: 'replaced',
    });
  });
});
