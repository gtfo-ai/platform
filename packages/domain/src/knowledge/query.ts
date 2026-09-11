/**
 * Turning a task's text into the **keywords** technical/07 step 2 asks for.
 *
 * > `websearch_to_tsquery('simple', <task keywords>)` over `kb_chunks.search`
 *
 * "Task keywords", not "task text", and WP-16 round 1 read it as the second. Measured against a
 * real PostgreSQL 18 over the fixture vault (2026-09-11, `simple` configuration):
 * `websearch_to_tsquery` joins bare words with **AND**, so the ticket-shaped query
 * `"the session service fails its tests with a foreign key violation"` matched **0 documents** —
 * no page contains all eleven words — while the in-memory double returned 15. The context pack's
 * whole text-match step therefore retrieved *nothing* in production and everything in the tests,
 * which is standing rule 1's forbidden direction with the fake on the kind side.
 *
 * Two things fix it, and both are here rather than in an adapter because both are decisions about
 * meaning rather than about SQL:
 *
 *  1. **Keywords, extracted.** Tokens shorter than {@link MIN_QUERY_TERM_LENGTH} are dropped. That
 *     is a *length* rule and not a stopword list on purpose: a list is a hand-maintained scope that
 *     drifts (standing rule 7), and this vault is mixed Czech/English, so there would have to be
 *     several. It is a crude rule and it is stated as one — it keeps `with`, `that` and `from`, and
 *     it drops `CI`, `MR` and `id`. What it does do is remove the degenerate queries that actually
 *     hurt: measured, `"the"` and `"and the of"` extract to **no terms at all**.
 *  2. **`OR`, not `AND`.** A pack wants the documents that are *about* the task, and a ticket is not
 *     a phrase to be found verbatim. With `OR` the same measured query returns 12 documents with
 *     the correct lesson at rank 0.500 and the noise at 0.091 — a ranking that separates, which is
 *     what the floor in `retrieval.ts` then acts on.
 *
 * **What this gives up, said plainly:** a quoted phrase. `websearch_to_tsquery` supports
 * `"exact phrase"` and tokenising destroys it, so `kb_search` cannot be asked for a literal string.
 * That is a real loss and it is smaller than the alternative, which was returning nothing.
 *
 * **What it buys, beyond retrieval:** every term that reaches the query is `[\p{L}\p{N}_]+` by
 * construction, so no byte of untrusted task text or model-written query text is ever concatenated
 * into a tsquery expression. The adapter joins terms it cannot be handed operators through.
 */

/**
 * The shortest token kept as a keyword.
 *
 * Four, because that is what removes the measured degenerate cases without a word list. Three would
 * keep `the`, `and` and `for`; five would drop `test`, `auth` and `user`, which are the words a
 * ticket about this platform is actually made of.
 */
export const MIN_QUERY_TERM_LENGTH = 4;

/**
 * The most keywords one query carries.
 *
 * A bound on the query the platform sends, not on what a caller may ask for: a ticket with a
 * pasted stack trace has thousands of distinct tokens, and a tsquery of thousands of `OR` branches
 * is a scan of the whole index for a result no better than the first two dozen terms give.
 */
export const MAX_QUERY_TERMS = 24;

const TOKEN = /[^\p{L}\p{N}_]+/u;

/**
 * The keywords of a piece of untrusted text, lowercased, de-duplicated, in first-seen order.
 *
 * First-seen order rather than sorted: when {@link MAX_QUERY_TERMS} truncates, the terms kept are
 * the ones nearest the start of the ticket, which is where a title sits.
 */
export const extractQueryTerms = (text: string): readonly string[] => {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(TOKEN)) {
    if (raw.length < MIN_QUERY_TERM_LENGTH) continue;
    seen.add(raw);
    if (seen.size >= MAX_QUERY_TERMS) break;
  }
  return [...seen];
};
