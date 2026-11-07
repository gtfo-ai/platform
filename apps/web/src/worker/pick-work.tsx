/**
 * **What this machine takes, and the runs it may pick** (WP-293; since S-26.7 the M26 UX spec § 1
 * and § 6): two sections of the worker's local page.
 *
 * - **What this machine takes** — `ui/claim-policy-card.tsx`, the card the platform's Workers screen
 *   draws too: the claim **policy** (*My tasks and unassigned ones*, *Only my tasks*, *Everything*,
 *   *Only what I pick*) over the project scope (*All projects you can see*, or *Only these:*). It is
 *   read with `?vocabulary=policy`, so a *pick only* machine's stored projects come back as they
 *   are, and a save **always** sends the policy and the projects — `null` for every project, never
 *   `[]` (`client.ts`). The sentence is the stored setting's: what the worker answered, never the
 *   draft. It is read again whenever the polled state's `claim_policy` moves (another screen's
 *   change).
 * - **Runs waiting for a machine** — the open offers this worker could take **now** (the claim's own
 *   eligibility, the scope ignored). A task nobody owns reads *Take this one* with "Assigns DEMO-1 to
 *   you." (a pick assigns, S-26.4); the reader's own task reads *Run it here* with no such line;
 *   another person's task reads "Vojtěch’s task" with **nothing to press**. An ask is labelled by
 *   its **asker** (`mine`), never by its task's owner (BACKLOG 1432), and a pick of one assigns
 *   nothing. A stale press the core refuses says the owner by name: `task_taken_by_another` and
 *   `task_owned_by_another` in the spec's words. The list's `as_of` goes back with every pick. The
 *   list is polled every {@link OFFERS_POLL_MS} **only while the page is visible**.
 *
 * Every string a tracker or a person wrote (the ticket key, the title, a project's or a person's
 * name) is a React text node through `ui/untrusted.tsx` (BD-022). An ask is listed as a question on
 * its task — never the question's text, which the core does not send.
 */
import type { WorkerClaimPolicy, WorkerLocalClaimScope, WorkerOffer } from '@platform/contracts';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button.js';
import { ClaimPolicyCard, type ClaimPolicyValue } from '../ui/claim-policy-card.js';
import { Flash } from '../ui/flash.js';
import { Skeleton } from '../ui/skeleton.js';
import { UntrustedText } from '../ui/untrusted.js';
import { MACHINE_TAKES_WORDS, PICK_WORDS as P } from '../ui/words/claim-policy.js';
import { ROLE_LABEL } from '../ui/words/roles.js';
import { stageLabel } from '../ui/words/stages.js';
import { LocalCallError, type LocalClient } from './client.js';
import { storedClaimPolicyOf } from './model.js';

/** How often the list of waiting runs is asked for while the page is visible (amendment §4). */
export const OFFERS_POLL_MS = 10_000;

/** An offer's subject line: its project and ticket, as the run cards name them. */
const subjectOf = (offer: WorkerOffer): string =>
  [offer.project_key, offer.ticket_key].filter((part) => part !== null).join(' · ') || offer.run_id;

/** What the run would do: the stage, or — for an ask — a question on the task. */
const workOf = (offer: WorkerOffer): string =>
  offer.kind === 'ask'
    ? `A question to the ${ROLE_LABEL[offer.role]}`
    : `${offer.stage === null ? ROLE_LABEL[offer.role] : stageLabel(offer.stage)} · ${ROLE_LABEL[offer.role]}`;

/**
 * What a row offers (the spec § 6):
 * - `take` — nobody owns the task (or the core said nothing of owners): *Take this one*, and for a
 *   stage of a task the core said nobody owns **and** is not held elsewhere, "Assigns DEMO-1 to
 *   you." — a task its tracker assigns to a person the platform cannot match is claimed without
 *   assigning, and a core that does not say (`held_elsewhere` absent) gets no promise;
 * - `run_here` — the reader's own task, or an ask they asked: *Run it here*;
 * - `someones` — a stage of a task another person owns: their name, nothing to press.
 */
export type OfferAction =
  | { readonly kind: 'take'; readonly assigns: boolean }
  | { readonly kind: 'run_here' }
  | { readonly kind: 'someones'; readonly name: string | null };

export const offerActionOf = (offer: WorkerOffer): OfferAction => {
  if (offer.mine === true) return { kind: 'run_here' };
  // An ask's owner is its task's, not its asker (BACKLOG 1432): a pick of one is never refused for
  // it and assigns nothing.
  if (offer.kind === 'ask') return { kind: 'take', assigns: false };
  // Nobody owns it: a pick assigns it only when it is not held elsewhere (its tracker assignee a
  // person the platform cannot match, TD-031's amendment item 7) — and only when the core said so.
  if (offer.owner === null || offer.owner === undefined) {
    return { kind: 'take', assigns: offer.owner === null && offer.held_elsewhere === false };
  }
  return { kind: 'someones', name: offer.owner.name.trim() || null };
};

/**
 * What a pick's answer leaves on the page: a starting line (`success`), a refusal that names the
 * task's owner in the spec's words (`warning`), or any other refusal (`danger`). The text may carry
 * a person's name or a ticket key, so it is rendered through `UntrustedText`.
 */
interface Outcome {
  readonly tone: 'success' | 'warning' | 'danger';
  readonly text: string;
}

const visibleNow = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible';

export interface PickWorkProps {
  readonly client: LocalClient;
  /** The worker can take nothing now (paused, draining, not connected): *Take* is disabled. */
  readonly takeBlocked: string | null;
  /**
   * What an empty list says (S-22.19, R-L7): why this worker sees nothing — the core lists nothing
   * to a worker that cannot take work — or where runs that never reach a worker wait.
   */
  readonly emptyWords: string;
  /** Called once a take started a run, so the page shows it at once. */
  readonly onTaken: () => void;
  /** The stored setting, each time it is read or saved — the page header's sentence. */
  readonly onScope?: (scope: WorkerLocalClaimScope) => void;
  /**
   * The policy the polled state carries (`WorkerLocalState.claim_policy`): whenever it moves, the
   * setting is read again — after a save here, or when another screen changed it.
   */
  readonly statePolicy?: WorkerClaimPolicy | null;
  readonly pollMs?: number;
  /** Test seam: whether the page is visible. */
  readonly visible?: () => boolean;
}

export const PickWork = ({
  client,
  takeBlocked,
  emptyWords,
  onTaken,
  onScope,
  statePolicy,
  pollMs = OFFERS_POLL_MS,
  visible = visibleNow,
}: PickWorkProps): ReactElement => {
  const [scope, setScope] = useState<WorkerLocalClaimScope | null>(null);
  const [offers, setOffers] = useState<readonly WorkerOffer[] | null>(null);
  const [asOf, setAsOf] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [taking, setTaking] = useState<string | null>(null);
  // The caller's callback by reference: an inline arrow must not re-run the read on every render.
  const onScopeRef = useRef(onScope);
  onScopeRef.current = onScope;

  const adopt = useCallback((answer: WorkerLocalClaimScope): void => {
    setScope(answer);
    onScopeRef.current?.(answer);
  }, []);

  // Read at mount, and again whenever the polled state's policy moves — a save here, or another
  // screen (the platform's Workers page) changing it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `statePolicy` is the trigger, not an input.
  useEffect(() => {
    let stopped = false;
    client.claimScope().then(
      (answer) => {
        if (!stopped) adopt(answer);
      },
      (caught: unknown) => {
        if (!stopped) setError((caught as Error).message);
      },
    );
    return () => {
      stopped = true;
    };
  }, [client, adopt, statePolicy]);

  const refreshOffers = useCallback(async (): Promise<void> => {
    try {
      const answer = await client.offers();
      setOffers(answer.offers);
      setAsOf(answer.as_of);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [client]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      // Hidden: nothing is scheduled; becoming visible asks at once and resumes the cadence.
      if (!stopped && visible()) timer = setTimeout(() => void tick(), pollMs);
    };
    const tick = async (): Promise<void> => {
      if (visible()) await refreshOffers();
      schedule();
    };
    const onVisibility = (): void => {
      if (visible()) void tick();
      else if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    void tick();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [refreshOffers, pollMs, visible]);

  /** The card's *Save*: the policy and the projects, always both; a refusal is thrown to the card. */
  const save = async (next: ClaimPolicyValue): Promise<void> => {
    adopt(await client.setClaimScope(next.policy, next.projectIds));
    setError(null);
    await refreshOffers();
  };

  const take = async (offer: WorkerOffer, action: OfferAction): Promise<void> => {
    setTaking(offer.run_id);
    setOutcome(null);
    try {
      await client.take(offer.run_id, asOf);
      setError(null);
      setOutcome({
        tone: 'success',
        text: action.kind === 'take' && action.assigns ? P.takenAssigned : P.taken,
      });
      onTaken();
    } catch (caught) {
      const code = caught instanceof LocalCallError ? caught.code : null;
      // The core named the owner; a nameless one (or none) is "another person".
      const name = (caught as LocalCallError).owner?.name.trim() || null;
      const ticket = offer.ticket_key ?? P.thisTask;
      setOutcome(
        code === 'task_taken_by_another'
          ? { tone: 'warning', text: P.takenByAnother(name ?? P.namelessStart, ticket) }
          : code === 'task_owned_by_another'
            ? { tone: 'warning', text: P.ownedByAnother(name ?? P.nameless, ticket) }
            : {
                tone: 'danger',
                text: code === 'offer_not_claimable' ? P.noLonger : (caught as Error).message,
              },
      );
    } finally {
      setTaking(null);
      await refreshOffers();
    }
  };

  return (
    <>
      {error === null ? null : (
        <Flash tone="danger" title="That did not work">
          <UntrustedText value={error} />
        </Flash>
      )}
      {scope === null ? (
        <Skeleton label={MACHINE_TAKES_WORDS.title} lines={2} />
      ) : (
        <ClaimPolicyCard
          stored={storedClaimPolicyOf(scope)}
          projects={scope.projects}
          onSave={save}
        />
      )}

      <section aria-label={P.heading} className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-fg">{P.heading}</h2>
        {takeBlocked === null ? null : (
          <p data-take-blocked="" className="text-sm text-fg-muted">
            {takeBlocked}
          </p>
        )}
        {outcome === null ? null : (
          <Flash tone={outcome.tone} live="status">
            <UntrustedText value={outcome.text} />
          </Flash>
        )}
        {offers === null ? (
          <Skeleton label="Asking the platform which runs are waiting…" lines={2} />
        ) : offers.length === 0 ? (
          <p data-offers-empty="" className="text-sm text-fg-muted">
            {emptyWords}
          </p>
        ) : (
          <ul aria-label="Waiting runs" className="flex flex-col gap-2">
            {offers.map((offer) => {
              const action = offerActionOf(offer);
              return (
                <li
                  key={offer.run_id}
                  data-offer={offer.run_id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface p-3"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-mono text-xs text-fg-muted">
                      <UntrustedText value={subjectOf(offer)} />
                    </span>
                    <span className="min-w-0 truncate text-sm font-semibold text-fg">
                      <UntrustedText value={offer.title ?? 'A task with no title'} />
                    </span>
                    <span className="text-xs text-fg-muted">
                      {workOf(offer)}
                      {offer.kind === 'ask' && offer.mine === true ? P.yourQuestion : ''}
                      {offer.automatic ? P.automatic : ''}
                    </span>
                  </div>
                  {action.kind === 'someones' ? (
                    <span className="text-sm text-fg-muted">
                      <UntrustedText value={P.someones(action.name ?? P.namelessStart)} />
                    </span>
                  ) : (
                    <div className="flex flex-col items-end gap-0.5">
                      <Button
                        size="sm"
                        disabled={takeBlocked !== null || taking !== null}
                        onClick={() => void take(offer, action)}
                      >
                        {action.kind === 'run_here' ? P.runHere : P.take}
                      </Button>
                      {action.kind === 'take' && action.assigns ? (
                        <span className="text-xs text-fg-muted">
                          <UntrustedText value={P.assigns(offer.ticket_key ?? P.thisTask)} />
                        </span>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
};
