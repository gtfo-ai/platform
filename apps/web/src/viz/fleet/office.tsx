/**
 * The office (TD-033 decision 8 (c)): the fleet as a pixel room per seat — the fun view, and never
 * the only one that tells the truth (the list and every desk's name do).
 *
 * - **A room per seat.** A worker is a team room with its name on the door plate (its owner and its
 *   slots beside it); the platform server's claimant is the *Platform room*. Each run a seat holds is
 *   a **desk** (`ui/bot/seat.tsx`): the mascot posed by the run's activity (`ACTIVITY_META.pose` —
 *   typing, thinking with its dots, a raised hand with a `!`, scratching its head with a `?`, a
 *   coffee while paused or starting, a cheer for a run that just finished, slumped for one that
 *   failed), a speech bubble with the "Now: …" line, and a nameplate (ticket key · stage). A free
 *   slot is a desk with a sleeping bot (`Z`), or a coffee on a paused worker.
 * - **The lobby.** A bench by the door for the runs no seat holds yet, and a beacon-lit **help desk**
 *   where what needs you stands with a raised hand — each a link to its task.
 *
 * **Every desk is a button** whose name says everything the drawing does, in words: "DEMO-1 · Code
 * review · working: Reading files · worker jan-mbp". The drawings are `aria-hidden`; the bubble and
 * the nameplate are text. Pressing a desk opens the run's dialog, as on the map and in the list.
 *
 * **The dark brand room**, on its own night floor, its text in the one dark theme's tokens (the
 * scope it once needed went with theme switching). `prefers-reduced-motion` gives every bot its
 * first frame (`animated={false}`, beside `bot.css`'s own media rule); each run's bot
 * takes the phase of its id, so a room of typing bots does not type in lockstep.
 *
 * A lazy chunk of its own (`features/agents.tsx` imports it with `import()`). Pure DOM and SVG: no
 * image, no URL attribute, no `style` attribute beyond `Seat`'s width; the sprites are text grids.
 * Every string a person, a tracker or an agent wrote is a sanitised React text node (BD-022).
 */
import './office.css';
import { Link } from '@tanstack/react-router';
import { type ReactElement, type ReactNode, useSyncExternalStore } from 'react';
import { BotLayers } from '../../ui/bot/bot.js';
import { BOT_STAGE_COLS, BOT_STAGE_ROWS, type BotPose } from '../../ui/bot/poses.js';
import { Seat } from '../../ui/bot/seat.js';
import { SPRITE_INKS, spriteRuns } from '../../ui/bot/sprite.js';
import { cx, FOCUS_RING } from '../../ui/cx.js';
import { formatDateTime } from '../../ui/kit.js';
import { sanitiseUntrusted } from '../../ui/untrusted-text.js';
import type { QueueWait } from './fleet-canvas.js';
import {
  botPhaseOf,
  type Fleet,
  type FleetNeed,
  type FleetRun,
  type FleetSeat,
  runSentence,
  seatTitle,
  slotsWords,
} from './model.js';
import {
  benchGrid,
  counterGrid,
  DOOR,
  DOOR_COLS,
  DOOR_ROWS,
  LAMP,
  LAMP_COLS,
  LAMP_GLOW,
  LAMP_ROWS,
} from './office-sprites.js';

/** Free desks drawn per room; the plate says the whole number. */
export const OFFICE_FREE_DESKS_SHOWN = 4;
/** Bots on the bench and at the help desk; the label says how many more. */
export const OFFICE_LOBBY_SHOWN = 6;

const REDUCED = '(prefers-reduced-motion: reduce)';

const subscribeReduced = (onChange: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const list = window.matchMedia(REDUCED);
  list.addEventListener('change', onChange);
  return () => {
    list.removeEventListener('change', onChange);
  };
};

const readReduced = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(REDUCED).matches;

/** Whether the reader asked for reduced motion: the bots then hold their first frame. */
export const useReducedMotion = (): boolean =>
  useSyncExternalStore(subscribeReduced, readReduced, () => false);

/** One text grid as SVG runs, at (`x`, `y`) in sprite pixels. */
const SpriteLayer = ({
  grid,
  cols,
  rows,
  x = 0,
  y = 0,
  label,
  className,
}: {
  readonly grid: readonly string[];
  readonly cols: number;
  readonly rows: number;
  readonly x?: number;
  readonly y?: number;
  readonly label: string;
  readonly className?: string;
}): ReactElement => (
  <g
    {...(className === undefined ? {} : { className })}
    {...(x === 0 && y === 0 ? {} : { transform: `translate(${x} ${y})` })}
  >
    {spriteRuns(grid, cols, rows, label).map((run) => (
      <rect
        key={`${run.x}:${run.y}`}
        x={run.x}
        y={run.y}
        width={run.width}
        height={1}
        className={SPRITE_INKS[run.ink]}
      />
    ))}
  </g>
);

const SCALE = 3;

/** The words in a desk's speech bubble. */
export const bubbleWords = (run: FleetRun): string => {
  if (run.ended) {
    return run.activity.activity === 'done' ? 'Done!' : `${run.meta.label}`;
  }
  return run.activity.detail === null ? run.meta.label : `Now: ${run.activity.detail}`;
};

const BUBBLE_TONE: Readonly<Record<FleetRun['meta']['tone'], string>> = {
  running: 'text-running',
  attention: 'text-attention',
  success: 'text-success',
  danger: 'text-danger',
  muted: 'text-fg-muted',
  subtle: 'text-fg-subtle',
};

const nameplateWords = (run: FleetRun): string =>
  run.ticketKey === null ? run.stageName : `${sanitiseUntrusted(run.ticketKey)} · ${run.stageName}`;

const Desk = ({
  run,
  seat,
  animated,
  onOpen,
}: {
  readonly run: FleetRun;
  readonly seat: FleetSeat | null;
  readonly animated: boolean;
  readonly onOpen: (runId: string) => void;
}): ReactElement => (
  <li
    data-desk={run.id}
    data-pose={run.meta.pose}
    data-activity={run.activity.activity}
    className={cx('office-desk relative', run.ended ? 'office-desk--ended' : null)}
  >
    <Seat
      pose={run.meta.pose}
      scale={SCALE}
      phase={run.botPhase}
      animated={animated}
      mug={run.botPhase % 2 === 0}
      plant={run.botPhase === 3}
      bubble={
        <span className={cx('font-medium', BUBBLE_TONE[run.meta.tone])}>{bubbleWords(run)}</span>
      }
      nameplate={<span className="font-mono">{nameplateWords(run)}</span>}
    />
    <button
      type="button"
      aria-label={runSentence(run, seat)}
      aria-haspopup="dialog"
      onClick={() => {
        onOpen(run.id);
      }}
      className={cx('office-hit absolute inset-0 rounded-md', FOCUS_RING)}
    />
  </li>
);

const FreeDesk = ({
  pose,
  words,
  phase,
  animated,
}: {
  readonly pose: BotPose;
  readonly words: string;
  readonly phase: 0 | 1 | 2 | 3;
  readonly animated: boolean;
}): ReactElement => (
  <li data-desk="free" data-pose={pose} className="office-desk office-desk--free">
    <Seat
      pose={pose}
      scale={SCALE}
      phase={phase}
      animated={animated}
      plant={phase === 1}
      nameplate={<span>{words}</span>}
    />
  </li>
);

const Door = (): ReactElement => (
  <svg
    aria-hidden="true"
    className="block shrink-0"
    width={DOOR_COLS * SCALE}
    height={DOOR_ROWS * SCALE}
    viewBox={`0 0 ${DOOR_COLS} ${DOOR_ROWS}`}
    shapeRendering="crispEdges"
  >
    <SpriteLayer grid={DOOR} cols={DOOR_COLS} rows={DOOR_ROWS} label="door" />
  </svg>
);

/** The wall at the top of a room: its door, the plate on it, and what the plate cannot hold. */
const Wall = ({
  plate,
  children,
}: {
  readonly plate: string;
  readonly children?: ReactNode;
}): ReactElement => (
  <div className="office-wall flex items-end gap-3 px-4 pt-3">
    <Door />
    <div className="flex min-w-0 flex-col gap-1 pb-2">
      <span data-door-plate="" className="office-plate self-start truncate">
        {plate}
      </span>
      {children === undefined ? null : (
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
          {children}
        </span>
      )}
    </div>
  </div>
);

const Room = ({
  seat,
  animated,
  onOpen,
}: {
  readonly seat: FleetSeat;
  readonly animated: boolean;
  readonly onOpen: (runId: string) => void;
}): ReactElement => {
  const title = seat.kind === 'server' ? 'Platform room' : seatTitle(seat);
  const desks = [...seat.runs, ...seat.endings];
  const free = seat.state === 'revoked' ? 0 : (seat.free ?? 0);
  const shownFree = Math.min(free, OFFICE_FREE_DESKS_SHOWN);
  const idle = desks.length === 0 && free === 0;
  return (
    <section
      aria-label={seat.kind === 'server' ? 'Platform room' : `${title} room`}
      data-room={seat.id}
      className="office-room"
    >
      <Wall plate={title}>
        {seat.kind === 'server' ? (
          <span>The platform server’s own agents</span>
        ) : seat.owner === null ? null : (
          <span>{sanitiseUntrusted(seat.owner)}</span>
        )}
        <span className="tabular-nums">{slotsWords(seat)}</span>
        {seat.state === 'paused' ? (
          <span className="office-badge">
            {seat.pausedUntil === null
              ? 'Paused'
              : `Paused until ${formatDateTime(seat.pausedUntil)}`}
          </span>
        ) : null}
        {seat.state === 'revoked' ? <span className="office-badge">Revoked</span> : null}
      </Wall>
      <ul
        aria-label={`Desks in ${title}`}
        className="office-floor flex flex-wrap gap-x-5 gap-y-4 p-4"
      >
        {desks.map((run) => (
          <Desk key={run.id} run={run} seat={seat} animated={animated} onOpen={onOpen} />
        ))}
        {Array.from({ length: shownFree }, (_, index) => (
          <FreeDesk
            // biome-ignore lint/suspicious/noArrayIndexKey: free desks are interchangeable.
            key={`free-${index}`}
            pose={seat.state === 'paused' ? 'sipping' : 'sleeping'}
            words={seat.state === 'paused' ? 'Paused' : 'Free desk'}
            phase={botPhaseOf(`${seat.id}:${index}`)}
            animated={animated}
          />
        ))}
        {idle ? (
          <FreeDesk
            pose="sleeping"
            words="Nothing running here"
            phase={botPhaseOf(seat.id)}
            animated={animated}
          />
        ) : null}
        {free > shownFree ? (
          <li className="self-center text-xs text-fg-muted">{`+${free - shownFree} more free desks`}</li>
        ) : null}
      </ul>
    </section>
  );
};

/** One bot on the bench: a bench segment behind it, the bot sipping while it waits for a seat. */
const BenchBot = ({
  run,
  animated,
  onOpen,
}: {
  readonly run: FleetRun;
  readonly animated: boolean;
  readonly onOpen: (runId: string) => void;
}): ReactElement => (
  <li
    data-bench={run.id}
    data-pose="sipping"
    className="office-desk relative flex flex-col items-center"
  >
    <svg
      aria-hidden="true"
      className={cx('block', animated ? `bot-phase-${run.botPhase}` : 'bot-static')}
      width={BOT_STAGE_COLS * SCALE}
      height={BOT_STAGE_ROWS * SCALE}
      viewBox={`0 0 ${BOT_STAGE_COLS} ${BOT_STAGE_ROWS}`}
      shapeRendering="crispEdges"
    >
      <SpriteLayer
        grid={benchGrid(BOT_STAGE_COLS)}
        cols={BOT_STAGE_COLS}
        rows={BOT_STAGE_ROWS}
        label="bench"
      />
      <BotLayers pose="sipping" />
    </svg>
    <span className="max-w-[7rem] truncate font-mono text-[11px] text-fg-muted">
      {run.ticketKey === null ? run.stageName : sanitiseUntrusted(run.ticketKey)}
    </span>
    <button
      type="button"
      aria-label={runSentence(run, null)}
      aria-haspopup="dialog"
      onClick={() => {
        onOpen(run.id);
      }}
      className={cx('office-hit absolute inset-0 rounded-md', FOCUS_RING)}
    />
  </li>
);

const EmptyBench = (): ReactElement => (
  <svg
    aria-hidden="true"
    className="block"
    width={BOT_STAGE_COLS * 2 * SCALE}
    height={(BOT_STAGE_ROWS - 24) * SCALE}
    viewBox={`0 24 ${BOT_STAGE_COLS * 2} ${BOT_STAGE_ROWS - 24}`}
    shapeRendering="crispEdges"
  >
    <SpriteLayer
      grid={benchGrid(BOT_STAGE_COLS * 2)}
      cols={BOT_STAGE_COLS * 2}
      rows={BOT_STAGE_ROWS}
      label="bench"
    />
  </svg>
);

const needSentence = (need: FleetNeed): string =>
  [
    need.ticketKey === null ? 'A task' : sanitiseUntrusted(need.ticketKey),
    need.kind === 'question' ? 'asks' : need.kind === 'approval' ? 'waits for an approval' : 'asks',
    need.untrusted ? sanitiseUntrusted(need.text) : need.text,
  ].join(' · ');

/** One agent at the help desk: standing behind the counter with a raised hand — a link to its task. */
const HelpDeskBot = ({
  need,
  animated,
}: {
  readonly need: FleetNeed;
  readonly animated: boolean;
}): ReactElement => (
  <li
    data-help={need.id}
    data-pose="raise_hand"
    className="office-desk relative flex w-32 flex-col items-center gap-1"
  >
    <svg
      aria-hidden="true"
      className={cx('block', animated ? `bot-phase-${botPhaseOf(need.id)}` : 'bot-static')}
      width={BOT_STAGE_COLS * SCALE}
      height={BOT_STAGE_ROWS * SCALE}
      viewBox={`0 0 ${BOT_STAGE_COLS} ${BOT_STAGE_ROWS}`}
      shapeRendering="crispEdges"
    >
      <BotLayers pose="raise_hand" />
      <SpriteLayer
        grid={counterGrid(BOT_STAGE_COLS)}
        cols={BOT_STAGE_COLS}
        rows={BOT_STAGE_ROWS}
        label="counter"
      />
    </svg>
    <Link
      to="/tasks/$taskId"
      params={{ taskId: need.taskId }}
      aria-label={needSentence(need)}
      className={cx(
        'office-hit flex w-full flex-col items-center rounded-md text-center text-[11px] after:absolute after:inset-0 after:content-[""]',
        FOCUS_RING,
      )}
    >
      <span className="max-w-full truncate font-mono text-running">
        {need.ticketKey === null ? 'A task' : sanitiseUntrusted(need.ticketKey)}
      </span>
      <span className="line-clamp-2 max-w-full text-fg-muted">
        {need.untrusted ? sanitiseUntrusted(need.text) : need.text}
      </span>
    </Link>
  </li>
);

const Lamp = ({ lit }: { readonly lit: boolean }): ReactElement => (
  <svg
    aria-hidden="true"
    className={cx('block shrink-0', lit ? 'office-lamp--lit' : 'office-lamp--off')}
    width={LAMP_COLS * SCALE}
    height={LAMP_ROWS * SCALE}
    viewBox={`0 0 ${LAMP_COLS} ${LAMP_ROWS}`}
    shapeRendering="crispEdges"
  >
    <SpriteLayer
      grid={LAMP}
      cols={LAMP_COLS}
      rows={LAMP_ROWS}
      label="lamp"
      className="office-lamp"
    />
    {lit ? (
      <SpriteLayer
        grid={LAMP_GLOW}
        cols={LAMP_COLS}
        rows={LAMP_ROWS}
        label="lamp glow"
        className="office-lamp-glow"
      />
    ) : null}
  </svg>
);

/** The bench's label for `waiting` runs. */
const benchWords = (waitingFor: QueueWait, waiting: number): string => {
  if (waiting === 0) {
    return waitingFor === 'worker'
      ? 'Bench · waiting for a worker'
      : waitingFor === 'nobody'
        ? 'Bench · no worker can take work'
        : 'Bench · nobody is waiting for a seat';
  }
  return waitingFor === 'nobody'
    ? `Bench · ${waiting} waiting, and no worker can take them`
    : `Bench · ${waiting} waiting for a ${waitingFor}`;
};

const Lobby = ({
  fleet,
  animated,
  onOpen,
  waitingFor,
}: {
  readonly fleet: Fleet;
  readonly animated: boolean;
  readonly onOpen: (runId: string) => void;
  readonly waitingFor: QueueWait;
}): ReactElement => {
  const bench = fleet.queue.slice(0, OFFICE_LOBBY_SHOWN);
  const help = fleet.needs.slice(0, OFFICE_LOBBY_SHOWN);
  return (
    <section aria-label="Lobby" data-room="lobby" className="office-room">
      <Wall plate="Lobby">
        <span>Waiting runs and the help desk</span>
      </Wall>
      <div className="office-floor flex flex-col gap-5 p-4">
        <div className="flex flex-col gap-2">
          <h3 className="office-label">{benchWords(waitingFor, fleet.queue.length)}</h3>
          {bench.length === 0 ? (
            <EmptyBench />
          ) : (
            <ul aria-label="On the bench" className="flex flex-wrap items-end">
              {bench.map((run) => (
                <BenchBot key={run.id} run={run} animated={animated} onOpen={onOpen} />
              ))}
            </ul>
          )}
          {fleet.queue.length > bench.length ? (
            <p className="text-xs text-fg-muted">{`+${fleet.queue.length - bench.length} more on the bench`}</p>
          ) : null}
        </div>
        <div
          data-help-desk={help.length > 0 ? 'lit' : 'dark'}
          className={cx(
            'office-help flex flex-col gap-2 rounded-md p-3',
            help.length > 0 ? 'office-help--lit' : null,
          )}
        >
          <h3 className="office-label flex items-center gap-2">
            <Lamp lit={help.length > 0} />
            {fleet.needs.length === 0
              ? 'Help desk · nothing needs you'
              : `Help desk · ${fleet.needs.length} need${fleet.needs.length === 1 ? 's' : ''} you`}
          </h3>
          {help.length === 0 ? null : (
            <ul aria-label="At the help desk" className="flex flex-wrap items-start gap-2">
              {help.map((need) => (
                <HelpDeskBot key={need.id} need={need} animated={animated} />
              ))}
            </ul>
          )}
          {fleet.needs.length > help.length ? (
            <Link to="/inbox" className="text-xs text-link hover:underline">
              {`+${fleet.needs.length - help.length} more in the inbox`}
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
};

export const Office = ({
  fleet,
  onOpen,
  empty,
  waitingFor = 'seat',
}: {
  readonly fleet: Fleet;
  readonly onOpen: (runId: string) => void;
  /** Drawn over the rooms when nothing runs: everyone is asleep, and this says what to do. */
  readonly empty?: ReactNode;
  /** What the bench waits for: any seat, a worker, or nobody (`QueueWait`). */
  readonly waitingFor?: QueueWait;
}): ReactElement => {
  const reduced = useReducedMotion();
  const animated = !reduced;
  return (
    <section
      aria-label="Office"
      data-office=""
      data-motion={animated ? 'on' : 'reduced'}
      className="office flex flex-col gap-4 rounded-lg p-4 text-fg"
    >
      {empty === undefined ? null : <div className="office-empty">{empty}</div>}
      <div className="grid gap-4 xl:grid-cols-[minmax(20rem,26rem)_1fr]">
        <Lobby fleet={fleet} animated={animated} onOpen={onOpen} waitingFor={waitingFor} />
        <div className="flex min-w-0 flex-col gap-4">
          {fleet.seats.map((seat) => (
            <Room key={seat.id} seat={seat} animated={animated} onOpen={onOpen} />
          ))}
        </div>
      </div>
    </section>
  );
};

export default Office;
