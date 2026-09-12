/**
 * The **data-block contract** — how untrusted text is put into a prompt, and the whole of what
 * "delimited as data" means in this repository (BD-022; technical/04 § "Prompt assembly" steps 4–5;
 * technical/07's provider-text block, which says of this obligation *"this is where it closes"*).
 *
 * ## The contract, in three sentences
 *
 * 1. A block opens with `<untrusted-data-<nonce> …>` and closes with `</untrusted-data-<nonce>>`,
 *    where `<nonce>` is 32 hex characters drawn at random **for this prompt** and unknown to
 *    whoever wrote the text.
 * 2. The body is emitted **byte-identical**. Nothing is stripped, escaped or re-encoded, so there
 *    is nothing for a later transform to undo — the same answer `apps/web/src/ui/untrusted.tsx`
 *    gives for the same question, and the same reason: an indexer or an encoder that edited the
 *    words would be a knowledge base nobody could trust to say what the file says.
 * 3. **Everything in a marker is the platform's.** The tag is a constant, the nonce matches
 *    {@link NONCE_PATTERN}, an attribute name matches {@link SAFE_ATTRIBUTE_NAME} and an attribute
 *    value matches {@link SAFE_ATTRIBUTE_VALUE} — and a value that does not is a **refusal**, never
 *    a truncation or an escape. So a vault path, a ticket key, a URL, a provider label and a model's
 *    own prose can never reach the marker; they go in the body, which is where data lives.
 *
 * The rule a reader applies is the dual of 1: *a block ends only at the closing marker carrying its
 * opening nonce, and any text inside it — including text shaped like a marker — is data.*
 * {@link readDataBlocks} is that reader, written separately and deliberately sloppier.
 *
 * ## Why a nonce rather than a fixed tag plus escaping
 *
 * technical/04 step 5's `<ticket>` … `</ticket>` is the precedent and it is spoofable: a ticket
 * whose body contains `</ticket>` closes the block and everything after it reads as the platform's
 * own voice. The two ways out are escaping the body (which breaks rule 2 above, and leaves an
 * encoder whose correctness nobody can see) or making the close marker **unguessable**. A random
 * nonce is the second, and it is the one that needs no transform: a document cannot write a marker
 * it cannot predict.
 *
 * It costs determinism, which is why the nonce is an *input* — this module is pure, the randomness
 * belongs to the composition root, and `promptVersion` hashes layers 1–3, which carry no nonce
 * (`assembly.ts`). Layer 1 states the rule in the abstract; the concrete nonce appears only where
 * blocks do.
 *
 * ## Zero-width characters, measured rather than assumed
 *
 * `U+200B`, `U+FEFF`, `U+2060` and `U+00AD` pass the indexer's sanitiser untouched — measured on
 * this build: `sanitiseDocumentText('pre' + zw + 'post').removed === 0` for all four, where an ESC,
 * a BEL, a `U+202E` and a `U+2066` each become one `U+FFFD` and are counted
 * (`packages/domain/src/knowledge/sanitise.ts`). PROGRESS backlog 12 names the attack that follows:
 * *a delimiter a document could spoof by hiding a zero-width character inside the marker.*
 *
 * Under a fixed-marker scheme that attack works, because "does the body contain the marker?" is an
 * exact-string question and a `</untrusted-data>` with a `U+200B` between two of its letters is not
 * an exact match while a human or a model may read it as one. Under this scheme it does not: a
 * spoofed marker still has to carry the
 * nonce, and hiding a zero-width character *inside* the nonce makes it fail {@link NONCE_PATTERN}
 * for the reader too. Both directions are asserted in `data-block.test.ts` — the zero-width
 * characters survive into the body byte-identical (nothing here edits them), and no arrangement of
 * them closes a block.
 *
 * **The residual, stated rather than implied.** This is a guarantee about the *structural* parse,
 * which is the only thing a string can guarantee. A model that ignores the stated rule and treats a
 * visually-convincing `</untrusted-data-0000…>` as a terminator is not stopped by any delimiter
 * scheme, escaping included; what the nonce buys is that the model is never *required* to guess,
 * because the correct answer is derivable from the prompt. Layer 1 spends two sentences telling it
 * so, and the eval cases under `packages/prompts/<role>/evals` are where that instruction is measured
 * against a live model — which is the half of this work package no credential in this repository
 * can run today.
 */

/** The constant half of the tag; the nonce is appended to it. */
export const DATA_BLOCK_TAG = 'untrusted-data';

/**
 * 32 lowercase hex characters — 128 bits, the shape `randomUUID()` yields with its dashes removed.
 *
 * Anchored, fixed-length and hex-only on purpose: it is the *reader's* test as much as the writer's,
 * so a nonce with a zero-width character, a space or a combining mark in it is not a nonce at all.
 */
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** Attribute names the platform writes. Not a sanitiser: a name is a literal in this repository. */
export const SAFE_ATTRIBUTE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Attribute values the platform writes.
 *
 * The alphabet is the one `workspaceNameFor` already produces (`A–Z a–z 0–9 . _ - /`) plus nothing.
 * A quote, a newline, an angle bracket, a zero-width character and every non-ASCII codepoint are
 * outside it, so no arrangement of an attribute value can end the marker early or hide inside it.
 * A value that does not match is refused (see {@link UnsafeMarkerValueError}) rather than escaped:
 * an escape is a transform, and a transform is a thing a later reader can undo.
 */
export const SAFE_ATTRIBUTE_VALUE = /^[A-Za-z0-9._/-]{1,512}$/;

/** The length half of {@link SAFE_ATTRIBUTE_VALUE}, named so a caller can say *why* it refused. */
export const MAX_MARKER_VALUE_CHARS = 512;

const MARKER_VALUE_ALPHABET = /^[A-Za-z0-9._/-]+$/;

/**
 * Why a marker would refuse this value — `'ok'` when it would not.
 *
 * The guard above is a boolean and stays one; this is for the **caller that wants to degrade
 * instead of being refused**. `assembly.ts` uses it on the two attributes derived from a vault path,
 * because a path is a filename in somebody else's repository and refusing the whole run for one is
 * a vault page's veto over a task. The alphabet is tested *before* the length so a 600-character
 * path carrying a quote reports the reason a reader can act on rather than the one that happens to
 * be checked first.
 */
export const markerValueRefusal = (
  value: string,
): 'ok' | 'empty' | 'unsafe_characters' | 'too_long' => {
  if (value.length === 0) return 'empty';
  if (!MARKER_VALUE_ALPHABET.test(value)) return 'unsafe_characters';
  if (value.length > MAX_MARKER_VALUE_CHARS) return 'too_long';
  return 'ok';
};

/** Raised when a marker would have to carry something the platform did not write. */
export class UnsafeMarkerValueError extends Error {
  override readonly name = 'UnsafeMarkerValueError';

  constructor(what: string, value: string) {
    // The offending value is quoted with `JSON.stringify`, which escapes the control and
    // zero-width characters that are the whole point of the refusal; a raw value in an error
    // message is the same defect one layer out.
    super(
      `${what} ${JSON.stringify(value)} cannot go in a prompt data-block marker: only the platform's own alphabet (A-Z a-z 0-9 . _ - /) may appear there, and untrusted text belongs in the body`,
    );
  }
}

/** Raised when the nonce is not 32 hex characters — a reader could not use it either. */
export class MalformedNonceError extends Error {
  override readonly name = 'MalformedNonceError';

  constructor(nonce: string) {
    super(
      `prompt data-block nonce ${JSON.stringify(nonce)} is not 32 lowercase hex characters; the marker a reader is told to look for must be exactly the one the writer emitted`,
    );
  }
}

/**
 * Raised when the body already contains the nonce.
 *
 * At 128 bits this is not chance — it is either a nonce source that is not random or a text that
 * has seen a previous prompt. Both are reasons to stop: the one thing the contract rests on is that
 * the author of the body could not predict the marker.
 */
export class NonceInBodyError extends Error {
  override readonly name = 'NonceInBodyError';

  constructor() {
    super(
      'the text to be delimited already contains this prompt nonce, so the closing marker would not be unguessable; a new nonce is required',
    );
  }
}

export interface DataBlock {
  /** Platform vocabulary for what this is (`knowledge_document`, `ticket`, …). */
  readonly kind: string;
  /** Platform-written labels. Every value must match {@link SAFE_ATTRIBUTE_VALUE}. */
  readonly attributes?: Readonly<Record<string, string | number>>;
  /** Untrusted text, emitted byte-identical. */
  readonly body: string;
}

const assertNonce = (nonce: string): void => {
  if (!NONCE_PATTERN.test(nonce)) throw new MalformedNonceError(nonce);
};

const assertSafeValue = (what: string, value: string): void => {
  if (!SAFE_ATTRIBUTE_VALUE.test(value)) throw new UnsafeMarkerValueError(what, value);
};

export const openMarkerFor = (nonce: string, block: DataBlock): string => {
  assertNonce(nonce);
  assertSafeValue('a data-block kind', block.kind);
  const attributes = Object.entries(block.attributes ?? {}).map(([name, value]) => {
    if (!SAFE_ATTRIBUTE_NAME.test(name))
      throw new UnsafeMarkerValueError('an attribute name', name);
    const rendered = typeof value === 'number' ? String(value) : value;
    assertSafeValue(`the value of attribute "${name}"`, rendered);
    return ` ${name}="${rendered}"`;
  });
  return `<${DATA_BLOCK_TAG}-${nonce} kind="${block.kind}"${attributes.join('')}>`;
};

export const closeMarkerFor = (nonce: string): string => {
  assertNonce(nonce);
  return `</${DATA_BLOCK_TAG}-${nonce}>`;
};

/**
 * One block: open marker, newline, body verbatim, newline, close marker.
 *
 * The two newlines are the frame's, not the body's, and {@link readDataBlocks} removes exactly
 * those two — so a body that is empty, or that ends in its own newline, round-trips unchanged.
 */
export const renderDataBlock = (nonce: string, block: DataBlock): string => {
  const open = openMarkerFor(nonce, block);
  if (block.body.includes(nonce)) throw new NonceInBodyError();
  return `${open}\n${block.body}\n${closeMarkerFor(nonce)}`;
};

/**
 * Does every one of these bodies leave this nonce unguessable?
 *
 * Separate from {@link renderDataBlock} because the caller has to answer it **before** it starts
 * rendering: the remedy for a collision is a different nonce for the whole prompt, and a prompt
 * half-rendered with one nonce and half with another has two different contracts in it.
 */
export const nonceIsUsable = (nonce: string, bodies: Iterable<string>): boolean => {
  if (!NONCE_PATTERN.test(nonce)) return false;
  for (const body of bodies) {
    if (body.includes(nonce)) return false;
  }
  return true;
};
