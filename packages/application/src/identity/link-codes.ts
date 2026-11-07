/**
 * A person links their own tracker or git account, **proven by the provider** — the code, the one
 * reader of a comment's text, and the claim a comment makes (S-26.6, TD-031's 2026-11-06 amendment
 * item 9, BD-022).
 *
 * A linked identity gains authority: it answers questions and approves plans (BD-006, Q10). So a
 * link is never typed and never matched by email. The person asks for a code, writes it as a
 * comment from their own account, the platform reads the comment's **authenticated author** from a
 * verified delivery (or through the binding, `link-thread.ts`), and only the person's confirmation
 * of *that* account writes `user_identities` (`identity-links.ts`).
 *
 * ## The code
 *
 * `agentic-link-` and ten characters of Crockford's base32 alphabet — 50 bits drawn from a CSPRNG
 * (`randomBytes`). Each character is one random byte's low five bits, and 256 is a multiple of 32,
 * so every character is uniform: no modulo bias. Four characters (20 bits) was rejected because a
 * few thousand comments inside the code's 30 minutes would guess one. Only the SHA-256 is stored;
 * it is a high-entropy secret, so a slow hash buys nothing (TD-022's argument for the worker
 * credential).
 *
 * **The code is never compared.** A comment's code is hashed and the hash is **looked up** through
 * the unique index on `identity_link_codes.code_hash`; there is no second comparison in code. What
 * the lookup's timing could reveal is how far a guessed code's SHA-256 agrees with a stored one's,
 * which is no step toward a 50-bit random code — so the lookup is the whole check, and a
 * constant-time re-comparison after it would always answer `true` and defend nothing.
 *
 * ## The one reader of a comment's text
 *
 * {@link readLinkComment} is the only function on the link path that reads a comment's body. It
 * answers the **hashes** of the codes it found and whether the comment carries a platform marker,
 * and nothing else — so no part of the text, not even the code, travels further than this module.
 * The match the platform records names the comment's id and author (`identity_link_matches`).
 *
 * ## What a claim refuses before anything is looked up
 *
 * {@link linkCodeClaimOf} turns one comment into a claim, and refuses here what the comment itself
 * disqualifies — each one a threat-model actor of TD-031's item 9:
 *
 *  - **an edited comment** (`edited`): a holder of Jira's *Edit All Comments* can put a code into
 *    another person's comment while its `author` stays the original writer. Jira: `updated` ≠
 *    `created`; GitLab: `updated_at` ≠ `created_at` (`[unverified]` live, docs/TODO.md). A comment
 *    whose instants the provider did not state is refused the same way (`edit_state_unknown`);
 *  - **`updateAuthor` ≠ `author`** (`edited_by_another`, Jira's comment carries both);
 *  - **a platform marker** anywhere in the body (`platform_marker`): the platform posts
 *    agent-written text, which reads attacker-controlled tickets, so a code an attacker planted
 *    could otherwise be "authored" by the platform;
 *  - **the binding's own account** (`binding_account`), for the same reason, and an account the
 *    adapter could not name (`binding_account_unknown`) — fail closed;
 *  - an author or comment id outside a plain identifier shape (`unsafe_identifier`): the id is
 *    stored and compared, and a redaction placeholder or a control character is not an account.
 *
 * What needs the database — a `machine` identity, an author linked to someone else, any binding's
 * stored account, an author ignored for the day — is decided by the recorder.
 */
import { createHash, randomBytes } from 'node:crypto';
import { PLATFORM_COMMENT_MARKERS } from '@platform/domain';
import type { LinkClaimRefusal, LinkCodeClaim } from '../ports/integrations/common.js';

/** The code's fixed prefix. */
export const LINK_CODE_PREFIX = 'agentic-link-';
/** Crockford's base32: no `I`, `L`, `O` or `U`. Thirty-two characters, five bits each. */
export const LINK_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Ten characters — 50 bits (TD-031's amendment item 9). */
export const LINK_CODE_CHARS = 10;
/** How long a code is valid. */
export const LINK_CODE_TTL_MS = 30 * 60_000;
/** At most this many codes issued per user per {@link LINK_CODE_RATE_WINDOW_MS}. */
export const LINK_CODES_PER_WINDOW = 5;
export const LINK_CODE_RATE_WINDOW_MS = 60 * 60_000;
/** Five non-matching codes in {@link LINK_MISS_WINDOW_MS} make an author ignored for the day. */
export const LINK_MISSES_BEFORE_IGNORED = 5;
export const LINK_MISS_WINDOW_MS = 24 * 60 * 60_000;
/** The most codes one comment is read for; the rest are not looked up (bounded work per comment). */
export const MAX_LINK_CODES_PER_COMMENT = 5;
/** The stored display name's bound (technical/03, BD-022: one more sink of provider text). */
export const MAX_LINK_DISPLAY_NAME_CHARS = 128;

/**
 * The code, strictly: the prefix and ten characters of the alphabet, not inside a longer word —
 * `xagentic-link-…` and a twelfth character both fail. Upper case only: the page shows the code
 * upper case and the person copies it.
 */
const LINK_CODE_PATTERN = /(?<![0-9A-Za-z-])agentic-link-([0-9A-HJKMNP-TV-Z]{10})(?![0-9A-Za-z])/g;

/**
 * A platform marker anywhere in the body — the ticket markers (`PLATFORM_COMMENT_MARKERS`) and the
 * merge-request note's `<!-- agentic:<kind>:<id> -->` shape. **Anywhere**, where the human-return
 * window asks *opens with* (TD-029 decision 6): there a false positive silences a person, here it
 * only refuses one comment as a link, and the person can write another.
 */
const MR_MARKER = /<!--\s*agentic:/;

/** The identifier shape an author id and a comment id must have to be stored (migration 0105). */
const IDENTIFIER = /^[A-Za-z0-9:._-]{1,255}$/;

/** A fresh code. `draw` is the CSPRNG, injectable so a test can name the code it will post. */
export const generateLinkCode = (draw: (size: number) => Uint8Array = randomBytes): string => {
  const bytes = draw(LINK_CODE_CHARS);
  if (bytes.length < LINK_CODE_CHARS) {
    throw new TypeError(`the random source answered ${bytes.length} bytes, not ${LINK_CODE_CHARS}`);
  }
  let suffix = '';
  for (let index = 0; index < LINK_CODE_CHARS; index += 1) {
    // Always in range: five bits index thirty-two characters.
    suffix += LINK_CODE_ALPHABET[(bytes[index] as number) & 0x1f] as string;
  }
  return `${LINK_CODE_PREFIX}${suffix}`;
};

/** What is stored: the SHA-256 of the whole code, hex. */
export const hashLinkCode = (code: string): string =>
  createHash('sha256').update(code, 'utf8').digest('hex');

/** What the one reader answers: the hashes of the codes it found, and whether a marker is there. */
export interface LinkCommentReading {
  readonly codeHashes: readonly string[];
  readonly platformMarker: boolean;
}

/**
 * **The only reader of a comment's text on the link path** (BD-022): the code regex and the marker
 * test, answering hashes and a flag. Distinct codes, in the order they appear, at most
 * {@link MAX_LINK_CODES_PER_COMMENT}.
 */
export const readLinkComment = (text: string): LinkCommentReading => {
  const hashes: string[] = [];
  for (const match of text.matchAll(LINK_CODE_PATTERN)) {
    const hash = hashLinkCode(match[0]);
    if (!hashes.includes(hash)) {
      hashes.push(hash);
    }
    if (hashes.length === MAX_LINK_CODES_PER_COMMENT) {
      break;
    }
  }
  return {
    codeHashes: hashes,
    platformMarker:
      hashes.length > 0 &&
      (MR_MARKER.test(text) || PLATFORM_COMMENT_MARKERS.some((marker) => text.includes(marker))),
  };
};

/** One comment, as an adapter or the thread read hands it over. */
export interface LinkCommentInput {
  readonly provider: string;
  readonly commentId: string;
  /** The provider's authenticated author, or `null` when the delivery names none. */
  readonly author: { readonly externalId: string; readonly displayName: string | null } | null;
  /** Who last edited it, when the provider says (Jira's `updateAuthor`); absent or `null` otherwise. */
  readonly updateAuthorId?: string | null;
  /** The provider's creation and last-update instants, as it wrote them; `null` when not stated. */
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** The body. Read by {@link readLinkComment} and by nothing else. */
  readonly text: string;
}

/** Normalises the two offset spellings the providers use (`+0000`, ` UTC`) before parsing. */
const instantOf = (value: string): number => {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) {
    return direct;
  }
  return Date.parse(
    value
      .replace(/ UTC$/, 'Z')
      .replace(' ', 'T')
      .replace(/([+-]\d{2})(\d{2})$/, '$1:$2'),
  );
};

/**
 * Whether the provider's two instants say the comment was edited. The same string is not edited;
 * two strings that parse to one instant are not edited; anything else — including an unparseable
 * one — is.
 */
export const wasEdited = (createdAt: string, updatedAt: string): boolean => {
  if (createdAt === updatedAt) {
    return false;
  }
  const created = instantOf(createdAt);
  const updated = instantOf(updatedAt);
  return Number.isNaN(created) || Number.isNaN(updated) || created !== updated;
};

/**
 * The claim one comment makes, or `null` when it carries no code (the common case — then nothing
 * else about it is read). `bindingAccount` answers the external id of the account the binding acts
 * as; it is asked **only** when every other check passed, so a comment without a code costs no
 * provider read, and a lookup that throws refuses the claim (`binding_account_unknown`).
 */
export const linkCodeClaimOf = async (
  input: LinkCommentInput,
  bindingAccount: () => Promise<string | null>,
): Promise<LinkCodeClaim | null> => {
  const reading = readLinkComment(input.text);
  if (reading.codeHashes.length === 0) {
    return null;
  }
  const displayName =
    input.author?.displayName === null || input.author?.displayName === undefined
      ? null
      : input.author.displayName.slice(0, MAX_LINK_DISPLAY_NAME_CHARS);
  const claim = (refusal: LinkClaimRefusal | null): LinkCodeClaim => ({
    provider: input.provider,
    externalId: input.author?.externalId ?? '',
    displayName,
    commentId: input.commentId,
    codeHashes: reading.codeHashes,
    refusal,
  });
  if (input.author === null || input.author.externalId.length === 0) {
    return claim('no_author');
  }
  if (!IDENTIFIER.test(input.author.externalId) || !IDENTIFIER.test(input.commentId)) {
    return claim('unsafe_identifier');
  }
  if (input.createdAt === null || input.updatedAt === null) {
    return claim('edit_state_unknown');
  }
  if (wasEdited(input.createdAt, input.updatedAt)) {
    return claim('edited');
  }
  if (
    input.updateAuthorId !== undefined &&
    input.updateAuthorId !== null &&
    input.updateAuthorId !== input.author.externalId
  ) {
    return claim('edited_by_another');
  }
  if (reading.platformMarker) {
    return claim('platform_marker');
  }
  let account: string | null;
  try {
    account = await bindingAccount();
  } catch {
    return claim('binding_account_unknown');
  }
  if (account === null || account.length === 0) {
    return claim('binding_account_unknown');
  }
  return claim(account === input.author.externalId ? 'binding_account' : null);
};

/**
 * Memoises a binding-account lookup for one delivery or one thread read: asked at most once, and
 * a throw is remembered as a throw (so a second comment does not retry a failing read).
 */
export const onceBindingAccount = (
  lookup: () => Promise<string | null>,
): (() => Promise<string | null>) => {
  let answer: Promise<string | null> | null = null;
  return () => {
    answer ??= lookup();
    return answer;
  };
};
