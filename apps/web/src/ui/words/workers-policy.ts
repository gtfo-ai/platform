/**
 * **What a machine takes, on the Workers screen** (S-26.8a).
 *
 * A module of its own since S-25.13: only lazy screens show these words, and `ui/humanize.ts` —
 * which the SPA's first paint imports — does **not** re-export them, because a re-export would put
 * them back in the initial graph (TD-013's budget, `bundle:check`). Screens import this module.
 */

/**
 * **What a machine takes, on the Workers screen** (S-26.8a, the M26 UX spec § 1): the words the
 * screen adds around the shared card (`MACHINE_TAKES_WORDS`) — the muted line for the runs its
 * policy leaves for others, and the refusals the card's own words do not cover. *Machine*, never
 * *claim*, *offer* or *seat*.
 */
export const WORKERS_POLICY_WORDS = {
  /** `policy_skipped_offers` above zero: "Skipped 3 runs this machine doesn’t take". */
  skipped: (count: number, formatted: string): string =>
    count === 1
      ? `Skipped ${formatted} run this machine doesn’t take`
      : `Skipped ${formatted} runs this machine doesn’t take`,
  /** `422 claim_scope_empty`: an empty project list (*Only what I pick* is the option for none). */
  refusedEmpty:
    'Choose at least one project, or all of them. To take nothing by itself, choose Only what I pick.',
  /** A refusal none of the card's words name: the platform's sentence, never the server's text. */
  refusedOther: 'What this machine takes was not changed. Try again.',
  /** Until the project names are known: the row says nothing it would have to take back. */
  loading: 'Loading what this machine takes…',
  /** A stored project that no longer exists, on somebody else's machine (the card says *you left*). */
  removedProject: 'a removed project',
} as const;
