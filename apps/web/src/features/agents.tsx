/**
 * Agents (`/agents`, TD-033 decisions 6–8 (b)(c)): what every agent and worker is doing right now,
 * and what needs you — one page, three views of the same live data (`viz/fleet/`):
 *
 * - **Map** (the default): the organisation → each seat (the platform server and every worker
 *   machine, with its owner and slots) → the run cards it holds, the queue of runs waiting for a
 *   seat, and what needs you; dashed connectors animate while an agent works and turn solid amber
 *   while it waits for a person. On the flow canvas (`@xyflow/react`), a lazy chunk.
 * - **Office**: the same seats as pixel rooms, a desk per run with the mascot posed by what the
 *   agent is doing, a bench for the queue and a help desk for what needs you. A lazy chunk.
 * - **List**: every run as a row with its status, phase, activity, seat, model, elapsed time and
 *   cost, and *Cancel run*; what needs you; the seats. The view that always tells the whole truth.
 *
 * The views are switched by an UnderlineNav of toggles; the choice is the URL's `?view=` and is
 * remembered in this browser (`agents-view.ts`). A run — a card, a desk, a row — opens the same
 * dialog: the run's live activity and log, *Open run*, *Open task*.
 *
 * The header says the counts in words — "2 working · 1 needs you · 1 waiting · 3 free slots" — and
 * its one primary action is *Open inbox*, only while something needs you. With nothing live, the
 * map and the list are a blankslate that says how to start, and the office shows everyone asleep
 * under the same words. Live through `useFleet` (the `org` topic, a 15 s clock, the `run:<id>`
 * topics of the runs on screen).
 *
 * product/10's "tokens/min" is still absent: a rate computed from two samples the page happened to
 * see would be a number with no definition.
 */

import type { WorkerSummary } from '@platform/contracts';
import { DependabotIcon } from '@primer/octicons-react/DependabotIcon';
import { ListUnorderedIcon } from '@primer/octicons-react/ListUnorderedIcon';
import { WorkflowIcon } from '@primer/octicons-react/WorkflowIcon';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { lazy, type ReactElement, Suspense, useCallback, useState } from 'react';
import { useProjects } from '../app/queries.js';
import { Blankslate } from '../ui/blankslate.js';
import { buttonClassName } from '../ui/button.js';
import { Flash } from '../ui/flash.js';
import { leadingClaimBlocker, wordInSentence } from '../ui/humanize.js';
import { ErrorNotice } from '../ui/kit.js';
import type { NavItem } from '../ui/nav-item.js';
import { PageHeader } from '../ui/page-header.js';
import { Skeleton } from '../ui/skeleton.js';
import { UnderlineNav } from '../ui/underline-nav.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import type { QueueWait } from '../viz/fleet/fleet-canvas.js';
import { FleetList } from '../viz/fleet/fleet-list.js';
import type { Fleet, FleetCounts, FleetRun } from '../viz/fleet/model.js';
import { FleetRunDialog } from '../viz/fleet/run-dialog.js';
import { useFleet } from '../viz/fleet/use-fleet.js';
import { useWideViewport } from '../viz/flow/flow-view.js';
import { chosenView, type FleetView, readStoredView, storeView } from './agents-view.js';
import { setupProjectOf } from './home-setup.js';
import { useWorkerNeed } from './worker-need.js';
import { workerReadinessOf } from './worker-readiness.js';

/** The map's own chunk: `@xyflow/react` is fetched only when the map is shown. */
const FleetCanvas = lazy(() => import('../viz/fleet/fleet-canvas.js'));
/** The office's own chunk. */
const Office = lazy(() => import('../viz/fleet/office.js'));

const VIEW_LABEL: Readonly<Record<FleetView, string>> = {
  map: 'Map',
  office: 'Office',
  list: 'List',
};

const VIEW_ICON: Readonly<Record<FleetView, ReactElement>> = {
  map: <WorkflowIcon size={16} />,
  office: <DependabotIcon size={16} />,
  list: <ListUnorderedIcon size={16} />,
};

/**
 * "2 working · 1 needs you · 1 waiting · 3 free slots", with "· 1 stuck" when any is — *slot* for
 * capacity and *machine* for the host it is on (S-23.23, the UX audit's § 4).
 */
export const countsSentence = (counts: FleetCounts): string =>
  [
    `${counts.working} working`,
    `${counts.needsYou} ${counts.needsYou === 1 ? 'needs' : 'need'} you`,
    `${counts.waiting} waiting`,
    `${counts.freeSeats} free slot${counts.freeSeats === 1 ? '' : 's'}`,
    counts.stuck === 0 ? null : `${counts.stuck} stuck`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

/** Every run the page can open: the live ones and those that just ended at a desk. */
const runById = (fleet: Fleet, id: string | null): FleetRun | null => {
  if (id === null) {
    return null;
  }
  for (const seat of fleet.seats) {
    const found = [...seat.runs, ...seat.endings].find((run) => run.id === id);
    if (found !== undefined) {
      return found;
    }
  }
  return fleet.queue.find((run) => run.id === id) ?? null;
};

/**
 * What the queue waits for (S-23.20, S-23.24), and — when it waits for nobody — why, in the blocker
 * words: on a platform where nothing on the server runs agent work (`need`), a worker when none is
 * registered, **nobody** when workers are and none would take a run by itself (`can_claim`, the
 * server's answer), and otherwise a seat. The reason names the first worker (by name) and its first
 * blocker; with several, how many more there are. A name is its owner's text, sanitised here
 * because the sentence is a plain string.
 */
export const queueWaitOf = (
  need: boolean | 'pending' | null,
  workers: readonly WorkerSummary[] | null,
): { readonly wait: QueueWait; readonly reason: string | null } => {
  if (need !== true || workers === null) {
    return { wait: 'seat', reason: null };
  }
  const active = workers
    .filter((worker) => worker.state === 'active')
    .sort((a, b) => a.name.localeCompare(b.name));
  if (active.length === 0) {
    return { wait: 'worker', reason: null };
  }
  if (active.some((worker) => workerReadinessOf(worker).takes === 'automatically')) {
    return { wait: 'seat', reason: null };
  }
  const [first] = active;
  // Its first blocker — or *updating now…* when that is an update in progress (S-23.27).
  const blocker =
    first === undefined ? undefined : leadingClaimBlocker(workerReadinessOf(first).claim_blockers);
  if (first === undefined || blocker === undefined) {
    return { wait: 'nobody', reason: null };
  }
  const more = active.length - 1;
  return {
    wait: 'nobody',
    reason: `${sanitiseUntrusted(first.name)}: ${wordInSentence(blocker.word)}${
      more === 0 ? '' : more === 1 ? ', and 1 more worker' : `, and ${more} more workers`
    }`,
  };
};

/** A sentence's full stop — none after a reason that already ends in "…" (*updating now…*). */
export const endStop = (reason: string | null): string => (reason?.endsWith('…') ? '' : '.');

const NothingRuns = ({
  inOffice = false,
  wait,
  reason,
}: {
  readonly inOffice?: boolean;
  /** What the queue waits for (`queueWaitOf`). */
  readonly wait: QueueWait;
  readonly reason: string | null;
}): ReactElement =>
  wait === 'nobody' ? (
    <Blankslate
      title="No worker can take work"
      hint={`Nothing on the platform server runs this project’s agents, and no worker you can see can take work now${
        reason === null ? '' : `: ${reason}`
      }${endStop(reason)}`}
      action={
        <Link to="/workers" className={buttonClassName('default')}>
          See why
        </Link>
      }
      {...(inOffice ? { className: 'border-0' } : {})}
    />
  ) : wait === 'worker' ? (
    <Blankslate
      title="Waiting for a worker"
      hint="Nothing on the platform server runs this project’s agents, so they run on developers’ own computers — and none you can see is connected. Add yours and its runs start here."
      action={
        <Link to="/workers/new" className={buttonClassName('default')}>
          Add a worker
        </Link>
      }
      {...(inOffice ? { className: 'border-0' } : {})}
    />
  ) : (
    <Blankslate
      title="No agent is working"
      hint={
        inOffice
          ? 'Everyone is asleep. Start a ticket on a board and an agent takes a desk here the moment its stage starts.'
          : 'Start a ticket on a board: an agent appears here the moment its stage starts, on the platform server or on a worker.'
      }
      action={
        <Link to="/projects" className={buttonClassName('default')}>
          Choose a board
        </Link>
      }
      {...(inOffice ? { className: 'border-0' } : {})}
    />
  );

export const AgentsScreen = (): ReactElement => {
  const search = useSearch({ strict: false }) as { readonly view?: unknown };
  const navigate = useNavigate();
  const [stored, setStored] = useState(() => readStoredView(globalThis.localStorage));
  const view = chosenView(search.view, stored);
  const choose = (next: FleetView): void => {
    storeView(globalThis.localStorage, next);
    setStored(next);
    void navigate({ to: '/agents', search: { view: next }, replace: true });
  };

  const { fleet, now, agents, workers } = useFleet();
  // S-23.20: on a platform where nothing on the server runs agent work, an empty page or a queue
  // waits for a worker — and says so, with the way to add one; S-23.24: or for nobody, when the
  // workers there are cannot take work, and then it says why.
  const projects = useProjects();
  const need = useWorkerNeed(setupProjectOf(projects.data?.items ?? [])?.id ?? null);
  const { wait, reason } = queueWaitOf(need, workers.isSuccess ? workers.data.items : null);
  const wide = useWideViewport();
  const [openId, setOpenId] = useState<string | null>(null);
  const [last, setLast] = useState<FleetRun | null>(null);
  const onOpen = useCallback(
    (runId: string) => {
      setOpenId(runId);
      setLast(runById(fleet, runId));
    },
    [fleet],
  );
  // The dialog follows the run while it is on screen, and keeps its last frame once it is not.
  const shown = runById(fleet, openId) ?? last;

  const nothing =
    agents.isSuccess &&
    fleet.counts.live === 0 &&
    fleet.needs.length === 0 &&
    fleet.seats.every((seat) => seat.endings.length === 0);

  const items: NavItem[] = (['map', 'office', 'list'] as const).map((id) => ({
    id,
    label: VIEW_LABEL[id],
    icon: VIEW_ICON[id],
    current: id === view,
    onSelect: () => {
      choose(id);
    },
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <PageHeader
          title="Agents"
          divider={false}
          meta={
            agents.isSuccess ? (
              <span data-fleet-counts="">{countsSentence(fleet.counts)}</span>
            ) : undefined
          }
          {...(fleet.counts.needsYou > 0
            ? {
                actions: (
                  <Link to="/inbox" className={buttonClassName('primary')}>
                    Open inbox
                  </Link>
                ),
              }
            : {})}
        />
        <UnderlineNav label="Agents views" items={items} />
      </div>

      {agents.isPending ? <Skeleton label="Loading agents…" lines={3} /> : null}
      {agents.isError ? (
        <ErrorNotice title="Agents could not be loaded." error={agents.error} />
      ) : null}
      {workers.isError ? (
        <p className="text-xs text-fg-muted">
          Your workers could not be loaded: each machine shows only what its runs say.
        </p>
      ) : null}

      {wait === 'nobody' && !nothing && fleet.queue.length > 0 ? (
        <Flash tone="warning" live="status">
          <p data-nobody-takes="">
            {`${fleet.queue.length === 1 ? '1 run is' : `${fleet.queue.length} runs are`} waiting and no worker can take them${
              reason === null ? '' : `: ${reason}`
            }${endStop(reason)} `}
            <Link to="/workers" className="text-link underline">
              See why
            </Link>
          </p>
        </Flash>
      ) : null}

      {agents.isSuccess && view === 'map' ? (
        nothing ? (
          <NothingRuns wait={wait} reason={reason} />
        ) : wide ? (
          <div
            data-testid="fleet-canvas-frame"
            className="h-[min(calc(100dvh-var(--app-sticky-height)-4rem),680px)] min-h-[420px] overflow-hidden rounded-lg border border-line"
          >
            <Suspense fallback={<Skeleton label="Drawing the map…" className="h-full w-full" />}>
              <FleetCanvas fleet={fleet} now={now} onOpen={onOpen} waitingFor={wait} />
            </Suspense>
          </div>
        ) : (
          <>
            <p className="text-xs text-fg-muted">The map needs a wider screen; here is the list.</p>
            <FleetList fleet={fleet} now={now} onOpen={onOpen} />
          </>
        )
      ) : null}

      {agents.isSuccess && view === 'office' ? (
        <Suspense fallback={<Skeleton label="Opening the office…" lines={4} />}>
          <Office
            fleet={fleet}
            onOpen={onOpen}
            waitingFor={wait}
            {...(nothing ? { empty: <NothingRuns inOffice wait={wait} reason={reason} /> } : {})}
          />
        </Suspense>
      ) : null}

      {agents.isSuccess && view === 'list' ? (
        nothing ? (
          <NothingRuns wait={wait} reason={reason} />
        ) : (
          <FleetList fleet={fleet} now={now} onOpen={onOpen} />
        )
      ) : null}

      <FleetRunDialog
        run={shown}
        open={openId !== null}
        onClose={() => {
          setOpenId(null);
        }}
      />
    </div>
  );
};
