/**
 * **What this worker picks up** (WP-293, TD-031's 2026-11-05 claim-scope amendment): two sections of
 * the worker's local page.
 *
 * - **What it takes by itself** — the claim scope: *every project you work on* (the default),
 *   *only these projects*, or *only what you pick* (`[]`). Stored on the core, per worker; a
 *   preference the claim enforces, never a boundary — it only narrows what the platform already
 *   lets this worker take.
 * - **Runs waiting for a worker** — the open offers this worker could take **now** (the claim's own
 *   eligibility, the scope ignored), each with *Take this one*. A pick is an ordering choice inside
 *   the same eligibility: it never jumps the platform's own turn on a project its administrator
 *   prefers the server for, nor another developer's head start (Q127 (a)), so a run that is not
 *   listed is not this worker's to take yet. The list is polled every {@link OFFERS_POLL_MS} **only
 *   while the page is visible**.
 *
 * Every string a tracker or a person wrote (the ticket key, the title, a project's name) is a React
 * text node through `ui/untrusted.tsx` (BD-022). An ask is listed as a question on its task — never
 * the question's text, which the core does not send.
 */
import type { WorkerLocalClaimScope, WorkerOffer } from '@platform/contracts';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/button.js';
import { Flash } from '../ui/flash.js';
import { ROLE_LABEL, stageLabel } from '../ui/humanize.js';
import { Skeleton } from '../ui/skeleton.js';
import { UntrustedText } from '../ui/untrusted.js';
import { LocalCallError, type LocalClient } from './client.js';

/** How often the list of waiting runs is asked for while the page is visible (amendment §4). */
export const OFFERS_POLL_MS = 10_000;

/** The three answers to *what does this worker take by itself*. */
export type ScopeMode = 'every' | 'some' | 'pick_only';

export const scopeModeOf = (ids: readonly string[] | null): ScopeMode =>
  ids === null ? 'every' : ids.length === 0 ? 'pick_only' : 'some';

/** The scope as one sentence, for the line under the section's heading. */
export const scopeWords = (scope: WorkerLocalClaimScope): string => {
  const ids = scope.claim_project_ids;
  if (ids === null) return 'It takes runs of every project you work on by itself.';
  if (ids.length === 0) return 'It takes nothing by itself: only the runs you pick below.';
  const keys = ids.map(
    (id) => scope.projects.find((project) => project.id === id)?.key ?? 'a project you left',
  );
  return `It takes runs of ${keys.join(', ')} by itself.`;
};

/** An offer's subject line: its project and ticket, as the run cards name them. */
const subjectOf = (offer: WorkerOffer): string =>
  [offer.project_key, offer.ticket_key].filter((part) => part !== null).join(' · ') || offer.run_id;

/** What the run would do: the stage, or — for an ask — a question on the task. */
const workOf = (offer: WorkerOffer): string =>
  offer.kind === 'ask'
    ? `A question to the ${ROLE_LABEL[offer.role]}`
    : `${offer.stage === null ? ROLE_LABEL[offer.role] : stageLabel(offer.stage)} · ${ROLE_LABEL[offer.role]}`;

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
  readonly emptyWords?: string;
  /** Called once a take started a run, so the page shows it at once. */
  readonly onTaken: () => void;
  readonly pollMs?: number;
  /** Test seam: whether the page is visible. */
  readonly visible?: () => boolean;
}

export const PickWork = ({
  client,
  takeBlocked,
  emptyWords = 'Nothing is waiting for this worker right now.',
  onTaken,
  pollMs = OFFERS_POLL_MS,
  visible = visibleNow,
}: PickWorkProps): ReactElement => {
  const [scope, setScope] = useState<WorkerLocalClaimScope | null>(null);
  const [mode, setMode] = useState<ScopeMode>('every');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [offers, setOffers] = useState<readonly WorkerOffer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [taking, setTaking] = useState<string | null>(null);

  const adopt = useCallback((answer: WorkerLocalClaimScope): void => {
    setScope(answer);
    setMode(scopeModeOf(answer.claim_project_ids));
    // A stale id — a project the user has left — is not offered back: saving it would be a 422.
    setChosen(
      (answer.claim_project_ids ?? []).filter((id) =>
        answer.projects.some((project) => project.id === id),
      ),
    );
  }, []);

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
  }, [client, adopt]);

  const refreshOffers = useCallback(async (): Promise<void> => {
    try {
      const answer = await client.offers();
      setOffers(answer.offers);
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

  const wanted: readonly string[] | null =
    mode === 'every' ? null : mode === 'pick_only' ? [] : chosen;
  const unchanged =
    scope !== null &&
    JSON.stringify(
      scope.claim_project_ids === null ? null : [...scope.claim_project_ids].sort(),
    ) === JSON.stringify(wanted === null ? null : [...wanted].sort());
  const incomplete = mode === 'some' && chosen.length === 0;

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      adopt(await client.setClaimScope(wanted));
      setSaved('Saved. The platform applies it to this worker’s next claim.');
      setError(null);
      await refreshOffers();
    } catch (caught) {
      setError((caught as Error).message);
      setSaved(null);
    } finally {
      setBusy(false);
    }
  };

  const take = async (runId: string): Promise<void> => {
    setTaking(runId);
    try {
      await client.take(runId);
      setError(null);
      onTaken();
    } catch (caught) {
      setError(
        caught instanceof LocalCallError && caught.code === 'offer_not_claimable'
          ? 'That run is no longer this worker’s to take — another worker or the platform took it, or it is not ready for workers yet. The list is refreshed.'
          : (caught as Error).message,
      );
    } finally {
      setTaking(null);
      await refreshOffers();
    }
  };

  const toggle = (id: string): void =>
    setChosen((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  return (
    <>
      {error === null ? null : (
        <Flash tone="danger" title="That did not work">
          <UntrustedText value={error} />
        </Flash>
      )}
      <section aria-label="What this worker takes" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-fg">What this worker takes by itself</h2>
        {scope === null ? (
          <Skeleton label="Asking the platform what this worker takes…" lines={2} />
        ) : (
          <>
            <p data-scope-words="" className="text-sm text-fg">
              <UntrustedText value={scopeWords(scope)} />
            </p>
            <fieldset className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4">
              <legend className="px-1 text-sm font-medium text-fg">Take by itself</legend>
              {(
                [
                  ['every', 'Every project you work on'],
                  ['some', 'Only these projects'],
                  ['pick_only', 'Nothing — only the runs I pick below'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-sm text-fg">
                  <input
                    type="radio"
                    name="claim-scope"
                    value={value}
                    checked={mode === value}
                    onChange={() => {
                      setMode(value);
                      setSaved(null);
                    }}
                  />
                  {label}
                </label>
              ))}
              {mode === 'some' ? (
                scope.projects.length === 0 ? (
                  <p className="ml-6 text-sm text-fg-muted">
                    You take runs in no project yet: ask an administrator to add you to one.
                  </p>
                ) : (
                  <ul aria-label="Projects" className="ml-6 flex flex-col gap-1">
                    {scope.projects.map((project) => (
                      <li key={project.id}>
                        <label className="flex items-center gap-2 text-sm text-fg">
                          <input
                            type="checkbox"
                            value={project.id}
                            checked={chosen.includes(project.id)}
                            onChange={() => {
                              toggle(project.id);
                              setSaved(null);
                            }}
                          />
                          <span className="font-mono">
                            <UntrustedText value={project.key} />
                          </span>
                          <span className="text-fg-muted">
                            <UntrustedText value={project.name} />
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button
                  size="sm"
                  tone="primary"
                  disabled={busy || unchanged || incomplete}
                  onClick={() => void save()}
                >
                  Save
                </Button>
                {incomplete ? (
                  <span className="text-xs text-fg-muted">
                    Choose at least one project, or pick only.
                  </span>
                ) : saved === null ? null : (
                  <span className="text-xs text-fg-muted">{saved}</span>
                )}
              </div>
            </fieldset>
            <p className="text-xs text-fg-muted">
              This only narrows what the platform already lets this worker take. Your other machines
              keep their own setting.
            </p>
          </>
        )}
      </section>

      <section aria-label="Runs waiting for a worker" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-fg">Runs waiting for a worker</h2>
        <p className="text-xs text-fg-muted">
          Take one and this worker claims it now. A pick never jumps the platform’s own turn on a
          project its administrator prefers the server for, nor another developer’s head start: a
          run that is not listed here is not this worker’s to take yet.
        </p>
        {takeBlocked === null ? null : (
          <p data-take-blocked="" className="text-sm text-fg-muted">
            {takeBlocked}
          </p>
        )}
        {offers === null ? (
          <Skeleton label="Asking the platform which runs are waiting…" lines={2} />
        ) : offers.length === 0 ? (
          <p data-offers-empty="" className="text-sm text-fg-muted">
            {emptyWords}
          </p>
        ) : (
          <ul aria-label="Waiting runs" className="flex flex-col gap-2">
            {offers.map((offer) => (
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
                    {offer.automatic ? ' · this worker would take it by itself' : ''}
                  </span>
                </div>
                <Button
                  size="sm"
                  disabled={takeBlocked !== null || taking !== null}
                  onClick={() => void take(offer.run_id)}
                >
                  {taking === offer.run_id ? 'Taking…' : 'Take this one'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
};
