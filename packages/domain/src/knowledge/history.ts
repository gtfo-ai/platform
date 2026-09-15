/**
 * What the platform will and will not believe from a mining run — product/19 §18 (WP-35).
 *
 * > *"recurring reviewer requests → rules candidates; conventions observed ≥ 3 times →
 * > `conventions.md` entries; pitfalls (MRs with ≥ 3 review rounds) → lessons; glossary terms;
 * > module ownership hints. **Every proposal cites MR/ticket links as evidence.**"*
 *
 * That last sentence is a **precondition of the queue, not a nicety**, and this module is where it
 * becomes one. The queue is what a maintainer reads to decide whether a claim about their own
 * repository is true; a claim they cannot follow to a merge request is indistinguishable from an
 * invention, and a queue that mixes the two teaches a maintainer to stop checking.
 *
 * ## The three things checked here, and why each is checkable at all
 *
 * 1. **A citation must resolve into the batch the run was shown.** The platform built the sample —
 *    it knows every merge-request and ticket URL it put in the prompt — so a link the model wrote
 *    that is not in that set names something this run never saw. This is the check that makes
 *    "cites evidence" mean something: without it, `evidence.min(1)` in the schema only requires the
 *    model to *write* a link, and the cheapest link to write is a plausible one.
 * 2. **A convention must have been observed at least three times** (product/19's own threshold).
 *    The model states `occurrences` and the platform applies the number, because a model that
 *    applied its own threshold would be the only judge of whether it had met it.
 * 3. **A pitfall must cite a merge request that actually took three or more review rounds.**
 *    product/19 defines a pitfall by a property of the *merge request*, and the platform counted
 *    that property when it built the sample (`HistoryMergeRequest.rounds`) — so this one is
 *    verifiable against the evidence rather than against the claim.
 *
 * ## What is deliberately not checked
 *
 * Whether the page's **text** is true. Nothing here reads `delta` beyond bounding it: a convention
 * correctly cited and wrongly described is exactly what the proposal queue exists for, and a
 * platform that tried to grade prose would be adding a second model's opinion to the first's. The
 * guarantee this module offers is narrow and stated: *every proposal that reaches the queue cites
 * something the platform itself showed the model, and the counts product/19 defines are the
 * platform's counts.*
 *
 * ## Refusals are recorded, never dropped
 *
 * A refused proposal comes back with its reason, and the caller writes it as a `discarded` row.
 * technical/07 calls the discard path *"audit only"* and BD-003 makes an unrecorded decision the one
 * an operator cannot reconstruct — and here it matters twice over, because a run whose citations
 * are all refused is the signal that something is wrong with the mining, and a silent drop would
 * present it as a run that found nothing.
 */
import type { HistoryProposal, HistorySample, LibrarianProposal } from '@platform/contracts';

/**
 * product/19 §18's *"conventions observed ≥ 3 times"*.
 *
 * Three is the document's number, not this file's. It is applied to `convention` only: a rule
 * candidate is *"recurring reviewer requests"*, which the model counts in its own `occurrences` and
 * which has no numeric threshold in the document, and inventing one here would be this module
 * deciding a product question (rule 16's shape — a made-up threshold reads as a specified one).
 */
export const MIN_CONVENTION_OCCURRENCES = 3;

/** product/19 §18's *"pitfalls (MRs with ≥ 3 review rounds)"*. */
export const MIN_PITFALL_REVIEW_ROUNDS = 3;

/** One mined proposal after the platform has read its evidence. */
export interface CuratedHistoryProposal {
  readonly proposal: HistoryProposal;
  /**
   * The proposal in the vocabulary the shared curator and `kb_proposals` speak, or `null` when it
   * was refused. Its `evidence` is the citations rendered as `<ref> <url>` lines — the row's column
   * is `text[]`, and a maintainer following a citation needs the URL.
   */
  readonly librarian: LibrarianProposal | null;
  /** Why the platform refused it. Platform text, never the model's. `null` when it was accepted. */
  readonly refusedReason: string | null;
}

export interface HistoryCurationInput {
  readonly proposals: readonly HistoryProposal[];
  /**
   * The batch this run was shown. The **platform's** record of it, not the model's: this is what
   * makes a citation resolvable rather than merely well-formed.
   */
  readonly sample: Pick<HistorySample, 'merge_requests' | 'tickets' | 'evidence_links'>;
}

/** `!12 https://…/merge_requests/12` — what one citation looks like in `kb_proposals.evidence`. */
const citationLine = (evidence: HistoryProposal['evidence'][number]): string =>
  `${evidence.ref} ${evidence.url}`;

const refuse = (proposal: HistoryProposal, reason: string): CuratedHistoryProposal => ({
  proposal,
  librarian: null,
  refusedReason: reason,
});

/**
 * Reads one run's proposals against the batch it was shown.
 *
 * One output per input, in input order — a refusal is a decision the caller records, and the count
 * of them is what tells an operator that a mining run cited nothing real.
 */
export const curateHistoryFindings = (
  input: HistoryCurationInput,
): readonly CuratedHistoryProposal[] => {
  const links = new Set(input.sample.evidence_links);
  const roundsByUrl = new Map(input.sample.merge_requests.map((mr) => [mr.url, mr.rounds]));
  const roundsByRef = new Map(input.sample.merge_requests.map((mr) => [mr.ref, mr.rounds]));

  return input.proposals.map((proposal) => {
    // The schema already requires one (`historyProposalSchema.evidence.min(1)`), so this branch is
    // reachable only for a row an older build wrote or a caller that skipped the parse. It is kept
    // rather than assumed away because the whole point of this module is that an unevidenced
    // proposal never reaches the queue, and a guarantee that rests on somebody else's parse is a
    // guarantee about somebody else (standing rule 14).
    if (proposal.evidence.length === 0) {
      return refuse(
        proposal,
        'the proposal cites no merge request or ticket, and product/19 §18 makes a citation a precondition of the queue',
      );
    }

    const unresolved = proposal.evidence.filter((entry) => !links.has(entry.url));
    if (unresolved.length > 0) {
      const named = unresolved.map((entry) => entry.ref).join(', ');
      return refuse(
        proposal,
        `the citation ${named} is not one of the ${links.size} merge requests and tickets this run was shown, so the platform cannot resolve it`,
      );
    }

    if (proposal.finding === 'convention' && proposal.occurrences < MIN_CONVENTION_OCCURRENCES) {
      return refuse(
        proposal,
        `a convention is recorded once it has been observed ${MIN_CONVENTION_OCCURRENCES} times (product/19 §18) and this one reports ${proposal.occurrences}`,
      );
    }

    if (proposal.finding === 'pitfall') {
      // The rounds are the platform's count over the merge requests it collected, so this compares
      // the claim with the evidence rather than with itself. A pitfall citing only tickets has no
      // merge request to measure and is refused by name for that reason.
      const cited = proposal.evidence
        .map((entry) => roundsByUrl.get(entry.url) ?? roundsByRef.get(entry.ref) ?? null)
        .filter((rounds): rounds is number => rounds !== null);
      const deepest = cited.length === 0 ? 0 : Math.max(...cited);
      if (deepest < MIN_PITFALL_REVIEW_ROUNDS) {
        return refuse(
          proposal,
          `a pitfall comes from a merge request with at least ${MIN_PITFALL_REVIEW_ROUNDS} review rounds (product/19 §18); the deepest one cited has ${deepest}`,
        );
      }
    }

    return {
      proposal,
      librarian: {
        // Always `add`: `curateProposals` turns it into an `update` when the index already holds
        // the page, which is fresher than anything a first look at a repository could know
        // (`onboarding/record.ts` takes the same line for a drafted page).
        action: 'add' as const,
        kind: proposal.kind,
        type: proposal.type,
        target_path: proposal.target_path,
        delta: proposal.delta,
        evidence: proposal.evidence.map(citationLine),
        significance: proposal.significance,
        reason: proposal.reason,
      },
      refusedReason: null,
    };
  });
};
