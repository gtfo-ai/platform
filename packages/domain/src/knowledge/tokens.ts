/**
 * The platform's token **estimator**, and the one place the word "tokens" means a number this
 * repository produced rather than one Anthropic reported.
 *
 * Two different quantities are called tokens in this codebase and they must not be confused:
 *
 *  - **Reported tokens** — `runs.input_tokens` and friends, taken from the SDK's `result` message.
 *    Those are the real tokenisation and they are what costs money.
 *  - **Estimated tokens** — what this module returns. The context pack is assembled *before* a
 *    prompt exists, so nothing can tokenise it; the budget in product/05 is therefore a budget over
 *    an estimate, and `run_context_pack.tokens` stores the estimate.
 *
 * ## The estimate is `ceil(utf8Bytes / 4)`, and the unit is the part that was wrong
 *
 * It was `ceil(chars / 4)` until WP-17 — JavaScript characters, which are UTF-16 code units. That
 * is the right shape with the wrong unit, and the error is entirely one-sided: a byte-level BPE
 * tokeniser (which Claude's is) splits the **UTF-8 encoding**, so a script whose characters are
 * three bytes long was being estimated at a third of its weight while ASCII was unaffected. PROGRESS
 * backlog 14 measured the corner: **48 000 CJK characters estimated to exactly 12 000 tokens**,
 * which is the shipped default budget, so a pack that "filled" the budget on such a corpus was
 * three to four times over it. Counting bytes moves the same corpus to 36 000 and leaves every
 * ASCII figure in this repository unchanged.
 *
 * **What is measured and what is not, stated rather than implied.** Measured here: the unit, and
 * that `estimateTokens` equals `ceil(utf8ByteLength(t) / 4)` for every string (`tokens.test.ts`, a
 * property, which is what makes an estimator with the *wrong ratio* fail rather than merely one
 * that is non-monotone). **Not** measured, by anyone, on this build: the ratio itself. Anthropic's
 * own documentation gives one datum — *"1M tokens is roughly … 2.5M Unicode characters on the
 * current tokenizer"* ([models overview](https://platform.claude.com/docs/en/models/overview),
 * retrieved 2026-09-12) — which is **2.5 characters** per token for mixed prose, not 4 bytes; for
 * ASCII that means this estimator is optimistic by roughly 1.6×. It is therefore still capable of
 * under-estimating, which is the direction that overflows a context window, and closing that needs
 * a real tokeniser rather than another constant. The honest reading of a budget today is *"about
 * this much, ±2×"*, and `MAX_CONTEXT_BUDGET_TOKENS` in `@platform/contracts` is what keeps the
 * consequence bounded.
 *
 * A real tokeniser would have to be the one the model uses, would pin a vocabulary file into the
 * domain ring, and would still be an approximation for the mixed Czech/English a vault is written
 * in (TD-008 chose the `simple` text-search configuration for the same reason). That is the trade
 * this module has taken; it is not a claim that the trade is free.
 *
 * It is an estimate; it is not accurate. Every number this module produces travels under the name
 * `tokens` in a record whose docblock says the same thing, so that a reader of `run_context_pack`
 * never mistakes it for the billed figure.
 */

/** UTF-8 bytes per estimated token. Changing this changes every budget in the platform. */
export const BYTES_PER_TOKEN = 4;

/**
 * The UTF-8 length of a string, without allocating an encoder or a buffer.
 *
 * The domain ring has no I/O and no dependencies; `TextEncoder` is a global rather than an import,
 * but it allocates a `Uint8Array` per call and this runs once per knowledge chunk. The arithmetic
 * is the standard one, and `tokens.test.ts` holds it to `new TextEncoder().encode(t).length` as a
 * property over arbitrary strings — including lone surrogates, which encode as one `U+FFFD` (three
 * bytes) and are the case a hand-written counter gets wrong.
 */
export const utf8ByteLength = (text: string): number => {
  let bytes = 0;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = at + 1 < text.length ? text.charCodeAt(at + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A surrogate pair is one code point in four bytes.
        bytes += 4;
        at += 1;
      } else {
        // A lone high surrogate is not a code point; every UTF-8 encoder substitutes U+FFFD.
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

/**
 * Estimated tokens for a string.
 *
 * Empty text is zero; **any** non-empty text is at least one. That floor is the property the budget
 * depends on — the fill in `retrieval.ts` admits documents while `spent + tokens <= budget`, so a
 * document estimated at zero tokens is admitted regardless of the budget, and a vault of 10 000
 * one-character pages would fill a pack with 10 000 entries and report `total_tokens: 0`.
 *
 * It is enforced by `Math.ceil` rather than by a `Math.max(1, …)` in front of it. A second guard
 * here would be **unreachable by construction** (`ceil(n / 4) >= 1` for every `n >= 1`) and
 * therefore untestable — standing rule 22 — so the property is asserted in `tokens.test.ts` against
 * the arithmetic that actually holds it, and there is nothing here for a mutation to survive
 * behind.
 */
export const estimateTokens = (text: string): number =>
  text.length === 0 ? 0 : Math.ceil(utf8ByteLength(text) / BYTES_PER_TOKEN);
