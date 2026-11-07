/**
 * The link code and the claim one comment makes (S-26.6, TD-031's 2026-11-06 amendment item 9) —
 * acceptance 1's code half and the comment-level refusals of acceptance 3.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateLinkCode,
  hashLinkCode,
  LINK_CODE_ALPHABET,
  LINK_CODE_CHARS,
  type LinkCommentInput,
  linkCodeClaimOf,
  MAX_LINK_CODES_PER_COMMENT,
  MAX_LINK_DISPLAY_NAME_CHARS,
  onceBindingAccount,
  readLinkComment,
  wasEdited,
} from './link-codes.js';

const CODE = 'agentic-link-7K3Q9VDM2X';
const OTHER = 'agentic-link-0123456789';
const BOT = '557058:agentic-bot';

const comment = (overrides: Partial<LinkCommentInput> = {}): LinkCommentInput => ({
  provider: 'jira-cloud',
  commentId: '10105',
  author: { externalId: '557058:dev-one', displayName: 'Dev One' },
  updateAuthorId: '557058:dev-one',
  createdAt: '2026-09-02T12:00:00.000+0000',
  updatedAt: '2026-09-02T12:00:00.000+0000',
  text: `my code is ${CODE}`,
  ...overrides,
});

const account = async () => BOT;

describe('the link code (acceptance 1)', () => {
  it('is the prefix and ten Crockford base32 characters — 50 bits', () => {
    const code = generateLinkCode();
    expect(code).toMatch(/^agentic-link-[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(LINK_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(LINK_CODE_ALPHABET).size).toBe(32);
    expect(LINK_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    expect(LINK_CODE_CHARS * Math.log2(LINK_CODE_ALPHABET.length)).toBe(50);
  });

  it('draws its characters from the random source it is given, one byte each', () => {
    const asked: number[] = [];
    const code = generateLinkCode((size) => {
      asked.push(size);
      return Uint8Array.from([0, 1, 31, 32, 63, 255, 10, 17, 20, 26]);
    });
    expect(asked).toEqual([10]);
    // byte & 31: 0→0, 1→1, 31→Z, 32→0, 63→Z, 255→Z, 10→A, 17→H, 20→M, 26→T
    expect(code).toBe('agentic-link-01Z0ZZAHMT');
  });

  it('refuses a random source that answered too few bytes rather than padding', () => {
    expect(() => generateLinkCode(() => new Uint8Array(4))).toThrow(TypeError);
  });

  it('uses every character of the alphabet uniformly from a CSPRNG (no modulo bias by construction)', () => {
    const counts = new Map<string, number>();
    for (let index = 0; index < 400; index += 1) {
      for (const character of generateLinkCode(randomBytes).slice('agentic-link-'.length)) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }
    // 4 000 draws over 32 characters: every one appears, none dominates.
    expect(counts.size).toBe(32);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(50);
      expect(count).toBeLessThan(250);
    }
  });

  it('is stored as its SHA-256, one hash per code', () => {
    const hash = hashLinkCode(CODE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('7K3Q9VDM2X');
    expect(hashLinkCode(CODE)).toBe(hash);
    expect(hashLinkCode(OTHER)).not.toBe(hash);
  });
});

describe('readLinkComment — the one reader of a comment’s text (acceptance 6)', () => {
  it('answers the hashes of the codes it found and nothing of the text', () => {
    const reading = readLinkComment(`hello ${CODE} and again ${CODE}, also ${OTHER}`);
    expect(reading.codeHashes).toEqual([hashLinkCode(CODE), hashLinkCode(OTHER)]);
    expect(JSON.stringify(reading)).not.toContain('hello');
    expect(JSON.stringify(reading)).not.toContain('7K3Q9VDM2X');
  });

  it.each([
    ['a lower-case code', 'agentic-link-7k3q9vdm2x'],
    ['nine characters', 'agentic-link-7K3Q9VDM2'],
    ['an eleventh character', 'agentic-link-7K3Q9VDM2XA'],
    ['a letter outside the alphabet', 'agentic-link-7K3Q9VDM2U'],
    ['a longer word around it', 'xagentic-link-7K3Q9VDM2X'],
  ])('reads no code in %s', (_name, text) => {
    expect(readLinkComment(text).codeHashes).toEqual([]);
  });

  it(`reads at most ${MAX_LINK_CODES_PER_COMMENT} codes from one comment`, () => {
    const codes = Array.from({ length: 8 }, () => generateLinkCode());
    expect(readLinkComment(codes.join(' ')).codeHashes).toHaveLength(MAX_LINK_CODES_PER_COMMENT);
  });

  it('sees a platform marker anywhere in a comment that carries a code', () => {
    expect(readLinkComment(`agentic:task:abc ${CODE}`).platformMarker).toBe(true);
    expect(readLinkComment(`> quoted\n<!-- agentic:reply:x -->\n${CODE}`).platformMarker).toBe(
      true,
    );
    expect(readLinkComment(`a person writes ${CODE}`).platformMarker).toBe(false);
  });
});

describe('wasEdited', () => {
  it('reads one instant in two spellings as unedited, and anything else as edited', () => {
    expect(wasEdited('2026-09-02T12:00:00.000+0000', '2026-09-02T12:00:00.000+0000')).toBe(false);
    expect(wasEdited('2026-09-02T12:00:00.000+0000', '2026-09-02T12:00:00.000Z')).toBe(false);
    expect(wasEdited('2026-06-01 09:00:00 UTC', '2026-06-01T09:00:00.000Z')).toBe(false);
    expect(wasEdited('2026-09-02T12:00:00.000+0000', '2026-09-02T12:00:01.000+0000')).toBe(true);
    expect(wasEdited('2026-09-02T12:00:00.000Z', 'not a date')).toBe(true);
  });
});

describe('linkCodeClaimOf — what a comment refuses by itself (acceptance 3)', () => {
  it('makes no claim for a comment with no code, and asks nobody', async () => {
    let asked = 0;
    const claim = await linkCodeClaimOf(comment({ text: 'please rebase' }), async () => {
      asked += 1;
      return BOT;
    });
    expect(claim).toBeNull();
    expect(asked).toBe(0);
  });

  it('claims a clean comment with its author, comment id and the code’s hash', async () => {
    expect(await linkCodeClaimOf(comment(), account)).toEqual({
      provider: 'jira-cloud',
      externalId: '557058:dev-one',
      displayName: 'Dev One',
      commentId: '10105',
      codeHashes: [hashLinkCode(CODE)],
      refusal: null,
    });
  });

  it('(c) refuses an edited comment', async () => {
    const claim = await linkCodeClaimOf(
      comment({ updatedAt: '2026-09-02T12:03:00.000+0000' }),
      account,
    );
    expect(claim?.refusal).toBe('edited');
  });

  it('(c) refuses a comment another account edited — the Edit All Comments holder', async () => {
    const claim = await linkCodeClaimOf(
      comment({ updateAuthorId: '557058:site-admin-with-edit-all' }),
      account,
    );
    expect(claim?.refusal).toBe('edited_by_another');
  });

  it('refuses a comment whose instants the provider did not state', async () => {
    expect((await linkCodeClaimOf(comment({ updatedAt: null }), account))?.refusal).toBe(
      'edit_state_unknown',
    );
    expect((await linkCodeClaimOf(comment({ createdAt: null }), account))?.refusal).toBe(
      'edit_state_unknown',
    );
  });

  it('refuses a comment carrying a platform marker — the platform’s own text', async () => {
    const claim = await linkCodeClaimOf(
      comment({ text: `agentic:task:0000 the agent wrote ${CODE}` }),
      account,
    );
    expect(claim?.refusal).toBe('platform_marker');
  });

  it('refuses the platform’s own account — the binding’s account', async () => {
    const claim = await linkCodeClaimOf(
      comment({ author: { externalId: BOT, displayName: 'Agentic Bot' }, updateAuthorId: BOT }),
      account,
    );
    expect(claim?.refusal).toBe('binding_account');
  });

  it('fails closed when the binding’s account cannot be named', async () => {
    expect((await linkCodeClaimOf(comment(), async () => null))?.refusal).toBe(
      'binding_account_unknown',
    );
    expect(
      (
        await linkCodeClaimOf(comment(), async () => {
          throw new Error('GET /myself failed');
        })
      )?.refusal,
    ).toBe('binding_account_unknown');
  });

  it('refuses an author or comment id outside a plain identifier', async () => {
    expect(
      (
        await linkCodeClaimOf(
          comment({ author: { externalId: '[REDACTED:integration:x]', displayName: null } }),
          account,
        )
      )?.refusal,
    ).toBe('unsafe_identifier');
    expect((await linkCodeClaimOf(comment({ commentId: 'a b' }), account))?.refusal).toBe(
      'unsafe_identifier',
    );
    expect((await linkCodeClaimOf(comment({ author: null }), account))?.refusal).toBe('no_author');
  });

  it('bounds the display name it carries', async () => {
    const claim = await linkCodeClaimOf(
      comment({ author: { externalId: '557058:dev-one', displayName: 'x'.repeat(500) } }),
      account,
    );
    expect(claim?.displayName).toHaveLength(MAX_LINK_DISPLAY_NAME_CHARS);
  });
});

describe('onceBindingAccount', () => {
  it('asks once, and remembers a failure as a failure', async () => {
    let asked = 0;
    const lookup = onceBindingAccount(async () => {
      asked += 1;
      throw new Error('down');
    });
    await expect(lookup()).rejects.toThrow('down');
    await expect(lookup()).rejects.toThrow('down');
    expect(asked).toBe(1);
  });
});
