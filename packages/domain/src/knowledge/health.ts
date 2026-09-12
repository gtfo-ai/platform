/**
 * The KB health report — technical/07 § "Librarian pipeline" step 6, product/05 § "Hygiene".
 *
 * > Nightly hygiene job: expiring items re-verified against HEAD; deprecate candidates (included N
 * > times, never cited …); consolidation suggestions; health report stored in … `kb_health_reports`
 * > and shown in the UI.
 *
 * This is the pure half: index rows in, findings out. It is a **report**, and the one rule that
 * matters about it is that nothing here decides anything — no finding removes a page, deprecates
 * one or edits one. product/05 is explicit that a deprecated page is kept and that contradictions
 * are "flagged for humans, never auto-resolved", and the hygiene pass that calls this function
 * makes **no** git call at all (see `knowledge/hygiene.ts`).
 *
 * ## What is computed here, and the one thing that cannot be
 *
 * Four kinds, all derivable from the index alone:
 *
 *  - **`expired`** — the page's own `expires` date has passed and nothing re-confirmed it. It is a
 *    *soft* expiry (product/05): the page stays indexed and stays retrievable.
 *  - **`dangling`** — a wikilink whose target the indexer could not resolve.
 *  - **`duplicate`** — two pages carrying the same frontmatter `id`, which is what a consolidation
 *    suggestion is made of.
 *  - **`oversized`** — a page over the token budget a context pack can afford to spend on one item.
 *
 * **"Deprecate candidates (included N times, never cited)" is not computed, and saying so is the
 * point.** It needs two things this build does not have: `run_context_pack` rows, which nothing
 * writes (PROGRESS backlog 31), and citation detection over `run_messages.search_text`. A finding
 * invented from the half that exists would say "never cited" about every page in every vault, which
 * is worse than an absent finding — so the pass reports what it can see and the gap is filed.
 */
import type { KbHealthFinding } from '@platform/contracts';

/** One indexed document, as the health pass reads it back. */
export interface HealthDocument {
  readonly path: string;
  /** `expires:` from the frontmatter, or null when the page never expires. */
  readonly expires: string | null;
  /** `id:` from the frontmatter — what two pages share when one supersedes the other. */
  readonly frontmatterId: string | null;
  readonly tokens: number;
}

/** One unresolved wikilink, as `kb_links` records it. */
export interface HealthLink {
  readonly fromPath: string;
  readonly toPath: string;
}

export interface HealthInputs {
  readonly documents: readonly HealthDocument[];
  readonly danglingLinks: readonly HealthLink[];
}

export interface HealthOptions {
  /** `YYYY-MM-DD`; a page expires when its `expires` is strictly before this. */
  readonly today: string;
  readonly maxDocumentTokens: number;
  readonly maxFindings: number;
}

/**
 * A page over this many tokens is reported.
 *
 * The default context budget is 12 000 tokens for tiers 0–1 (technical/07 step 4), so a single page
 * of 4 000 is a third of everything a run gets to read. It is a **report**, not a cap: the indexer
 * has its own bounds and nothing here refuses a page.
 */
export const MAX_HEALTH_DOCUMENT_TOKENS = 4_000;

/**
 * How many findings one report may carry.
 *
 * The row is a `jsonb` column and the inputs are a whole vault: a project with a thousand dangling
 * links would otherwise write a megabyte of report every night. The cap is applied after the
 * findings are ordered by kind, so a truncated report is missing the *tail* of a kind rather than a
 * random sample, and the count of what was dropped is on the pass's log line.
 */
export const MAX_HEALTH_FINDINGS = 100;

const KIND_ORDER: readonly KbHealthFinding['kind'][] = [
  'expired',
  'dangling',
  'duplicate',
  'contradiction',
  'oversized',
];

export interface HealthReport {
  readonly findings: readonly KbHealthFinding[];
  /** How many findings the cap left out — a number for the log, never a silent zero. */
  readonly dropped: number;
}

export const computeKbHealth = (inputs: HealthInputs, options: HealthOptions): HealthReport => {
  const findings: KbHealthFinding[] = [];

  for (const document of inputs.documents) {
    if (document.expires !== null && document.expires < options.today) {
      findings.push({
        kind: 'expired',
        path: document.path,
        detail: `expires: ${document.expires} has passed and nothing re-confirmed the page`,
      });
    }
    if (document.tokens > options.maxDocumentTokens) {
      findings.push({
        kind: 'oversized',
        path: document.path,
        detail: `${document.tokens} tokens, over the ${options.maxDocumentTokens}-token budget a context pack can spend on one page`,
      });
    }
  }

  for (const link of inputs.danglingLinks) {
    findings.push({
      kind: 'dangling',
      path: link.fromPath,
      detail: `links to ${link.toPath}, which the index does not have`,
    });
  }

  const byId = new Map<string, string[]>();
  for (const document of inputs.documents) {
    if (document.frontmatterId === null) continue;
    byId.set(document.frontmatterId, [...(byId.get(document.frontmatterId) ?? []), document.path]);
  }
  for (const [id, paths] of byId) {
    if (paths.length < 2) continue;
    const sorted = [...paths].sort();
    for (const path of sorted) {
      findings.push({
        kind: 'duplicate',
        path,
        detail: `id "${id}" is also on ${sorted.filter((other) => other !== path).join(', ')}`,
      });
    }
  }

  const ordered = findings.sort((a, b) => {
    const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    return kind === 0 ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : kind;
  });
  return {
    findings: ordered.slice(0, options.maxFindings),
    dropped: Math.max(0, ordered.length - options.maxFindings),
  };
};
