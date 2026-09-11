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
 * The estimate is `ceil(chars / 4)`, the conventional rough ratio for English prose. It is
 * deliberately crude, deterministic and dependency-free: a real tokeniser would have to be the same
 * one the model uses, would pin a vocabulary file into the domain ring, and would still be wrong
 * for the mixed Czech/English the vault is written in (TD-008 chose the `simple` text-search
 * configuration for the same reason). What matters for a budget is that the estimate is
 * **monotone** in document length and never zero for text that exists — both asserted in
 * `tokens.test.ts` — because a document the estimator scores at zero is a document the budget fill
 * can admit an unbounded number of.
 *
 * It is an estimate; it is not accurate. Every number this module produces travels under the name
 * `tokens` in a record whose docblock says the same thing, so that a reader of `run_context_pack`
 * never mistakes it for the billed figure.
 */

/** Characters per estimated token. Changing this changes every budget in the platform. */
export const CHARS_PER_TOKEN = 4;

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
  text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
