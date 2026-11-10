/**
 * **Why a ready machine runs nothing (more), in words** (S-28.6, the M28 ruling A) — one sentence
 * per `idle_reason` kind, with what to do next, for the Workers screen's rows, the Agents screen and
 * the worker's own local page. A module of its own and lean on purpose: the worker page's bundle has
 * almost no room (≤ 120 000 B gz), so it imports this file directly and nothing else comes with it
 * (`worker/import-graph.test.ts` names it).
 *
 * Every sentence says what holds the machine back, by which rule, with the numbers the server
 * counted — and never a raw enum. The keys a sentence names (a project's, a ticket's) are stored
 * text: the caller renders the sentence as a text node, never as markup (BD-022).
 */
import type { WorkerIdleReason } from '@platform/contracts';

/** Who reads the sentence: the machine's own person ("you", "your") or somebody else (by name). */
export interface IdleReader {
  /** The reader is the machine's person. */
  readonly self: boolean;
  /** The machine's person's name, for a reader who is not them. */
  readonly ownerName: string;
}

/** Where the sentence sends the reader next — each surface renders it as its own link. */
export type IdleNext =
  /** The project's board, by key. */
  | { readonly kind: 'board'; readonly projectKey: string; readonly label: string }
  /** What this machine takes — its claim policy (the reader's own machine only). */
  | { readonly kind: 'policy'; readonly label: string }
  /** The per-person limit (the Workers screen's *Your limit*). */
  | { readonly kind: 'limit'; readonly label: string }
  /** The Agents screen, where the runs it holds are. */
  | { readonly kind: 'agents'; readonly label: string }
  /** The projects' boards, where what is queued shows. */
  | { readonly kind: 'projects'; readonly label: string };

export interface IdleWords {
  readonly text: string;
  readonly next: IdleNext | null;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One kind's sentence and its next step. Exhaustive by type: a new kind fails to compile here. */
export const workerIdleWords = (reason: WorkerIdleReason, reader: IdleReader): IdleWords => {
  switch (reason.kind) {
    case 'slots_busy':
      return {
        text:
          reason.concurrency === 1
            ? 'Its one place is busy: it takes the next run when this one ends.'
            : `All ${reason.concurrency} of its places are busy: it takes the next run when one of them ends.`,
        next: { kind: 'agents', label: 'See what it runs' },
      };
    case 'owner_limit': {
      const who = reader.self ? 'You own' : `${reader.ownerName} owns`;
      const whose = reader.self ? 'your' : `${reader.ownerName}’s`;
      const more = reason.queued === 1 ? 'is' : 'are';
      return {
        text: `${who} ${reason.count} of ${reason.limit} tasks in flight — ${whose} limit — and ${reason.queued} more of ${whose} tasks ${more} queued. A place frees when one of them finishes, is paused, or is handed to someone else.`,
        next: { kind: 'limit', label: 'Change the limit' },
      };
    }
    case 'project_limit': {
      const queued = `${plural(reason.queued, 'task', 'tasks')} it would take ${reason.queued === 1 ? 'is' : 'are'} queued`;
      const rule =
        reason.limit_kind === 'max_tasks_in_pipeline'
          ? `Project ${reason.project_key} is full: ${reason.count} of ${reason.limit} places in its pipeline are taken (the project’s limit, not a person’s), and ${queued}.`
          : `Project ${reason.project_key} already works on ${reason.count} of ${reason.limit} tasks at once (the project’s limit, not a person’s), and ${queued}.`;
      return {
        text: `${rule}${reason.organisation_bound ? ' The limit is the organisation’s maximum.' : ''} ${
          reason.limit_kind === 'max_tasks_in_pipeline'
            ? 'A place frees when one of its tasks finishes, is paused, is cancelled or needs a person to unblock it.'
            : 'A place frees when one of them stops moving: it waits for a person, is paused, is done or is cancelled.'
        }`,
        next: { kind: 'board', projectKey: reason.project_key, label: 'Open the board' },
      };
    }
    case 'policy_skips': {
      const whose = reader.self ? 'your' : `${reader.ownerName}’s`;
      const takes =
        reason.claim_policy === 'mine'
          ? `only ${whose} tasks`
          : `only ${whose} tasks and unassigned ones`;
      const runs = plural(reason.skipped, 'waiting run belongs', 'waiting runs belong');
      return {
        text: `It takes ${takes}, and ${runs} to others.${reader.self ? '' : ' Only its owner can change what it takes.'}`,
        next: reader.self ? { kind: 'policy', label: 'Change what it takes' } : null,
      };
    }
    case 'nothing_queued':
      return {
        text: 'Nothing is queued or waiting for this machine in the projects it serves.',
        next: { kind: 'projects', label: 'Open the boards' },
      };
  }
};
