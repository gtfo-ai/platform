/**
 * Inverse document frequency from a project's **own** index, and the one decision made with it —
 * `docs/OPEN-QUESTIONS.md` **Q58**, implemented per its recommendation (WP-58).
 *
 * > derive inverse document frequency from the project's own index at index time, drop a query
 * > term whose document frequency exceeds a threshold, and return no documents when no term
 * > survives.
 *
 * No language dictionary and no stopword list: a vault is mixed Czech/English by design, and a term
 * that appears in most of *this* project's documents carries no information *in this project*
 * whatever language it is in.
 *
 * ## Where each half runs, and why that is rule 1's answer
 *
 * - **Counting** ({@link termStatisticsOf}) runs when the index is written, over the chunks the
 *   write carries, with the same splitter the query side uses ({@link textKeywords}). Both
 *   `KnowledgeStore` adapters call this one function inside `write` and store what it returns, so
 *   the in-memory double and PostgreSQL hold the **same numbers by construction** — the two
 *   earlier divergences this floor could have reopened (0 documents against 15; 0.667 against
 *   0.267, PROGRESS backlog 15) were both a store computing something the other did not.
 * - **Deciding** ({@link selectInformativeTerms}) runs inside `KnowledgeStore.search`, in both
 *   adapters, before the full-text query — so every caller of the port (the context pack and
 *   `kb_search`) gets the floor, and none can forget it. The shared contract suite holds both stores
 *   to the same kept/dropped split for the same vault.
 *
 * What is counted is the text **as stored in `kb_chunks.text`** — which begins with the
 * `project / path / heading` prefix the indexer writes — under the platform's splitter, not under
 * PostgreSQL's `simple` parser (which keeps a path as one `file` lexeme; the in-memory store's
 * divergence register, row 1c). So a word that appears only inside a page's *path* counts toward
 * its frequency here although PostgreSQL would not match it there. The direction is stated, and it
 * is the **harmful** one: over-counting makes a term *more* likely to be dropped, and dropping a
 * word that still tells pages apart is exactly the failure the margin below exists to prevent. The
 * prefix makes the project key (`demo` in the fixture) appear in every page, which is correct to
 * drop; a path segment shared by most pages (`technical`, `lessons`) can be counted over the line
 * without appearing in any body — not measured to matter on either corpus, and filed with 171.
 *
 * ## The line, and why it is a half *plus a margin* (architect ruling, session 8)
 *
 * A term is dropped when it is in **at least two** documents **and** in more than
 * `N/2 + √N` of the project's `N` — {@link isUninformative}. The half is where Robertson–Spärck
 * Jones inverse document frequency `ln((N − df + 0.5) / (df + 0.5))` stops being positive. The
 * margin is two binomial standard errors of a share read off `N` pages (`√(N·¼)·2 = √N`): a share
 * near one half cannot be told from one half on a small vault, and a term that splits a corpus near
 * half is close to the *most* informative binary feature, not the least. WP-58's first version
 * dropped at the bare half and measured the cost on the fixture vault: it dropped `session` (13 of
 * 23 pages, the vault's subject) and PostgreSQL then ranked a wrong lesson first.
 *
 * Where the line falls, on the two corpora measured 2026-09-26 with this module's splitter:
 *
 * - **This repository's 160 tracked Markdown files** (a real corpus): the line is 92.6 documents
 *   (0.58). Of Q58's thirteen function words `with` (0.93), `from` (0.79), `that` (0.74) and
 *   `this` (0.63) are over it and dropped; `have` (0.40), `they` (0.41) and seven rarer ones are
 *   not; every subject word sampled stays under it (the highest `knowledge`, 0.48).
 * - **The fixture vault with its negative corpus** (23 pages): the line is 16.3, so only a term in
 *   17 or more pages drops — here the project key `demo`, which the indexer writes onto every chunk.
 *   `session` (13) is searched again. A vault of **four pages or fewer drops nothing** (`N/2 + √N`
 *   is then at least `N`).
 *
 * **Residuals, stated.** The floor **narrows** the junk-query class on a real corpus and does
 * **not** close it: a query of function words each under the line still reaches the store, and on
 * a small vault every one of them is under it. And a **large** vault about one thing can have a
 * subject word *significantly* over half — that word is dropped, and a query of it alone finds
 * nothing by text (PROGRESS backlog 171).
 *
 * ## Two guards on the arithmetic
 *
 * - A term found in **one** document is never dropped ({@link MIN_DROPPABLE_DOCUMENTS}): it picks
 *   exactly that page. The margin already implies it for every `N`; the guard is kept as a named
 *   statement rather than an arithmetic accident.
 * - No statistics — an index written before migration 0042, until its next rebuild — is **not** a
 *   licence to drop anything: the floor reports `no_statistics` and every term is searched, which
 *   is the behaviour before this module existed, said out loud rather than guessed.
 */
import { textKeywords } from './query.js';

/**
 * A term must be in at least this many documents before it can be dropped at all.
 */
export const MIN_DROPPABLE_DOCUMENTS = 2;

/**
 * The share the line is built on: a term must be in more than this share of the documents **plus**
 * {@link uninformativeMargin} before it is dropped. See the module docblock for the derivation.
 */
export const MAX_TERM_DOCUMENT_SHARE = 0.5;

/** Two binomial standard errors of a share read off `documents` pages: `2·√(N·½·½) = √N`. */
export const uninformativeMargin = (documents: number): number => Math.sqrt(documents);

/** The ruling's predicate: `df ≥ 2` and `df > N/2 + √N`. */
export const isUninformative = (frequency: number, documents: number): boolean =>
  frequency >= MIN_DROPPABLE_DOCUMENTS &&
  frequency > MAX_TERM_DOCUMENT_SHARE * documents + uninformativeMargin(documents);

/** What the index write stores: how many documents, and in how many of them each keyword occurs. */
export interface TermStatistics {
  readonly documents: number;
  readonly frequencies: ReadonlyMap<string, number>;
}

/**
 * Document frequency per keyword over the documents one index write carries — each document is the
 * concatenation of its chunks' stored text.
 */
export const termStatisticsOf = (
  documents: readonly { readonly chunks: readonly { readonly text: string }[] }[],
): TermStatistics => {
  const frequencies = new Map<string, number>();
  for (const document of documents) {
    const seen = new Set<string>();
    for (const chunk of document.chunks) {
      for (const term of textKeywords(chunk.text)) seen.add(term);
    }
    for (const term of seen) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return { documents: documents.length, frequencies };
};

/** Why the floor did or did not run for one search. */
export type TermFloor =
  /** Statistics existed and every term was judged against them. */
  | 'applied'
  /** The index carries no statistics yet (written before migration 0042); nothing was dropped. */
  | 'no_statistics';

export interface InformativeTerms {
  /** The terms the store searches for, in the caller's order. */
  readonly kept: readonly string[];
  /** The terms dropped as uninformative in this project, in the caller's order. */
  readonly uninformative: readonly string[];
  readonly floor: TermFloor;
}

/**
 * The floor. `statistics` is `null` when the index has none; `frequency` answers for any term,
 * zero for one the project has never seen.
 */
export const selectInformativeTerms = (
  terms: readonly string[],
  statistics: {
    readonly documents: number;
    readonly frequency: (term: string) => number;
  } | null,
): InformativeTerms => {
  if (statistics === null) return { kept: [...terms], uninformative: [], floor: 'no_statistics' };
  const kept: string[] = [];
  const uninformative: string[] = [];
  for (const term of terms) {
    (isUninformative(statistics.frequency(term), statistics.documents) ? uninformative : kept).push(
      term,
    );
  }
  return { kept, uninformative, floor: 'applied' };
};
