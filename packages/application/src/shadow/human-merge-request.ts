/**
 * Finding the merge request a human wrote for a ticket — Q82 (b) (WP-34).
 *
 * > *"Find the human merge request by the ticket's own links first, then by a scan, and record
 * > which matched."*
 *
 * Two lookups, in order, and the report says which one answered so *"a reader can judge the
 * comparison rather than trust it"*:
 *
 *  1. **`ticket_link`** — a link on the ticket itself (Jira's remote links, `Ticket.links`). This is
 *     the authoritative answer when it exists, because a human put it there.
 *  2. **`title_scan`** — the ticket key appearing as a whole token in a merged merge request's
 *     **title** or **source branch**, which is the convention BD-025's own branch namespace
 *     assumes. The listing is the caller's, read once for the whole batch.
 *
 * ## Why the link path still asks the provider, and what the second read is for
 *
 * A link is a URL a human typed into somebody else's system (BD-022): it may point at another
 * project, at a merge request that was closed rather than merged, or at nothing. So the iid is
 * parsed out of it and the merge request is **read**, and the read is only accepted when the
 * provider's own `ref.url` matches the link that produced it. That is what stops a link naming
 * `other/project!12` from being resolved against *this* project's `!12` — the platform addresses
 * merge requests by iid within the bound project (`addressed`), so without the comparison a
 * cross-project link would silently compare against the wrong change.
 *
 * ## What it cannot do, stated rather than discovered
 *
 * - **The URL shapes it recognises are GitLab's and GitHub's** (`…/merge_requests/<n>`,
 *   `…/pull/<n>`, with an optional trailing slash, query or fragment). A provider that numbers its
 *   merge requests differently falls through to the scan, which is a degradation and not a failure.
 * - **The scan sees only what the listing carries.** A merge request merged before the batch's
 *   window, or past its page limit, is invisible; the caller chooses both.
 * - **The key match is textual.** `PROJ-1` does not match `PROJ-12` (the token boundary is
 *   enforced), but a merge request whose description — not its title or branch — names the ticket
 *   is missed. Widening to the description would match a merge request that merely *mentions* the
 *   ticket, which is the wrong direction for a number the whole feature exists to publish.
 * - **The most recently merged wins** when several match. A ticket implemented across three merge
 *   requests is compared against the last one, which understates the human's size and therefore
 *   *overstates* the agent — the direction a reader must know about, so {@link
 *   HumanMergeRequestMatch.candidates} is **carried**: `startShadowBatch` writes it onto the
 *   ticket row (`shadow_batch_tickets.human_mr_candidates`) and `buildShadowReport` says so in
 *   `notes` whenever it is more than one. Until WP-34's review round 2 the count was computed and
 *   discarded while this sentence claimed the report carried it (standing rule 86).
 */
import type { MergeRequestRef, ShadowHumanMrSource } from '@platform/contracts';
import type { gitReads } from '../pipeline/integrations.js';
import type { MergedMergeRequest } from '../ports/integrations/git-provider.js';

export interface HumanMergeRequestMatch {
  readonly mergeRequest: MergeRequestRef;
  readonly source: ShadowHumanMrSource;
  /** Q82 (a)'s comparison anchor; `null` when the provider publishes none. */
  readonly baseSha: string | null;
  readonly mergedAt: string | null;
  /** How many merged merge requests the scan matched, so the report can say so. */
  readonly candidates: number;
}

/** One link on a ticket, as `Ticket.links` carries it. */
export interface TicketLinkLike {
  readonly url?: string | null | undefined;
}

/**
 * The merge-request iid inside a provider URL, or `null`.
 *
 * Deliberately anchored at the **end** of the path so that a URL naming a note or a diff
 * (`…/merge_requests/7/diffs`) does not resolve — a link to a sub-page is a link somebody made to
 * something more specific than the merge request, and guessing which merge request they meant is
 * the kind of guess this module exists not to make. The fragment and query are dropped first,
 * because `…/merge_requests/7#note_1` is the ordinary shape of a link a reviewer copies.
 */
export const parseMergeRequestIid = (url: string): number | null => {
  const withoutFragment = url.split('#')[0]?.split('?')[0] ?? '';
  const path = withoutFragment.replace(/\/+$/, '');
  const match = /\/(?:merge_requests|pull|pulls)\/(\d+)$/.exec(path);
  const raw = match?.[1];
  if (raw === undefined) {
    return null;
  }
  const iid = Number(raw);
  return Number.isSafeInteger(iid) && iid > 0 ? iid : null;
};

/** `https://host/x/-/merge_requests/7/` and `https://host/x/-/merge_requests/7` are one URL. */
const sameUrl = (left: string, right: string): boolean =>
  left.split('#')[0]?.replace(/\/+$/, '') === right.split('#')[0]?.replace(/\/+$/, '');

/**
 * Does `title` name `key` as a whole token?
 *
 * Case-insensitive, because a branch is `feature/proj-12-totals` as often as `PROJ-12`.
 *
 * The boundary is *not* `\b` and it is *not* "any non-alphanumeric", and both halves were measured
 * rather than reasoned:
 *
 *  - `\b` sits between `J` and `-` inside `PROJ-1`, so `\bPROJ-1\b` matches inside **`PROJ-12`** at
 *    the hyphen — a ticket compared against another ticket's merge request;
 *  - treating `-` as part of the key makes `feature/proj-1-totals` — BD-025's own branch shape, and
 *    the convention this scan exists for — **miss** `PROJ-1`.
 *
 * So the boundary character class is `[A-Za-z0-9_]`: a hyphen ends the key and a digit does not.
 * `PROJ-1` therefore misses `PROJ-12` (next char `2`) and matches `proj-1-totals` (next char `-`).
 * The residual is stated: a scheme whose keys are themselves hyphen-separated numbers
 * (`PROJ-1-2`) would match `PROJ-1`, and no provider this build ships issues one.
 */
export const mentionsTicketKey = (text: string, key: string): boolean => {
  const haystack = text.toLowerCase();
  const needle = key.toLowerCase();
  if (needle === '') {
    return false;
  }
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) {
      return false;
    }
    const before = at === 0 ? '' : haystack[at - 1];
    const after = haystack[at + needle.length] ?? '';
    if (!isKeyChar(before) && !isKeyChar(after)) {
      return true;
    }
    from = at + 1;
  }
};

const isKeyChar = (char: string | undefined): boolean =>
  char !== undefined && /[a-z0-9_]/.test(char);

type GitReads = ReturnType<typeof gitReads>;
type CallContext = Parameters<GitReads['mergeRequest']>[1];

export const findHumanMergeRequest = async (
  provider: { readonly reads: GitReads; readonly context: CallContext },
  input: {
    readonly ticketKey: string;
    readonly links: readonly TicketLinkLike[];
    readonly merged: readonly MergedMergeRequest[];
  },
): Promise<HumanMergeRequestMatch | null> => {
  for (const link of input.links) {
    const url = link.url ?? null;
    if (url === null || url === '') {
      continue;
    }
    const iid = parseMergeRequestIid(url);
    if (iid === null) {
      continue;
    }
    const mr = await provider.reads.mergeRequest({ iid, url }, provider.context);
    if (mr === null || !sameUrl(mr.ref.url, url)) {
      // Either no git binding at all, or the iid resolved inside *this* project to a merge request
      // that is not the one the link names. Both fall through to the scan.
      continue;
    }
    return {
      mergeRequest: mr.ref,
      source: 'ticket_link',
      baseSha: mr.base_sha ?? null,
      mergedAt: mr.merged_at ?? null,
      candidates: 1,
    };
  }

  const matches = input.merged.filter(
    (entry) =>
      mentionsTicketKey(entry.title, input.ticketKey) ||
      mentionsTicketKey(entry.ref.branch ?? '', input.ticketKey),
  );
  const best = [...matches].sort(
    (left, right) => Date.parse(right.merged_at) - Date.parse(left.merged_at),
  )[0];
  if (best === undefined) {
    return null;
  }
  // The listing does not carry a merge base — GitLab publishes `diff_refs` on the single merge
  // request and not on the list — so the winner is read once to get it. One request per matched
  // ticket, which is what Q82 (a) costs.
  const full = await provider.reads.mergeRequest(best.ref, provider.context);
  return {
    mergeRequest: best.ref,
    source: 'title_scan',
    baseSha: full?.base_sha ?? null,
    mergedAt: best.merged_at,
    candidates: matches.length,
  };
};
