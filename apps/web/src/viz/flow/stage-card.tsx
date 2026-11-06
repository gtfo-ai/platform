/**
 * One stage as a card (TD-033 decision 8 (a)): a real `<button>`, so the graph is reachable from the
 * keyboard and a click, Enter or Space opens the stage's dialog.
 *
 * What it shows, top to bottom: the stage's human name and its kind (an agent, a gate, a person,
 * a system step — a human stage is marked, a gate is a smaller card), the attempt when it is not
 * the first ("Attempt 2"), the role; the status dot and word — *done*, *upcoming*, *sent back*,
 * *failed*, *skipped*, *disabled*, or on the current stage the activity's own ("● Working"); on the
 * current stage the "Now: Reading files" pill; the model and effort; and, for a stage that is done,
 * how long it took and what its latest run cost.
 *
 * The status is **icon + colour + word**, never colour alone (WCAG 1.4.1). Every string here is the
 * platform's (the model id is the run's or the configuration's, never provider text), and the card
 * imports nothing from `@xyflow/react`: the canvas wraps it, and the list fallback and the tests
 * render it without the canvas's chunk.
 */

import type { BuiltinGateStageId } from '@platform/contracts';
import { CheckCircleFillIcon } from '@primer/octicons-react/CheckCircleFillIcon';
import { CircleIcon } from '@primer/octicons-react/CircleIcon';
import { CircleSlashIcon } from '@primer/octicons-react/CircleSlashIcon';
import { DependabotIcon } from '@primer/octicons-react/DependabotIcon';
import { DotFillIcon } from '@primer/octicons-react/DotFillIcon';
import { GearIcon } from '@primer/octicons-react/GearIcon';
import { PersonIcon } from '@primer/octicons-react/PersonIcon';
import { ShieldCheckIcon } from '@primer/octicons-react/ShieldCheckIcon';
import { SkipIcon } from '@primer/octicons-react/SkipIcon';
import type { Icon } from '@primer/octicons-react/types';
import { UndoIcon } from '@primer/octicons-react/UndoIcon';
import { XCircleFillIcon } from '@primer/octicons-react/XCircleFillIcon';
import type { ReactElement } from 'react';
import { ACTIVITY_META } from '../../ui/activity.js';
import { cx, FOCUS_RING } from '../../ui/cx.js';
import { ARTIFACT_TYPE_LABEL, ROLE_LABEL } from '../../ui/humanize.js';
import { formatElapsed, formatRunCost } from '../../ui/kit.js';
import { StatusIcon } from '../../ui/status.js';
import type { FlowNode, FlowState, StageKind } from './model.js';

interface StateLook {
  readonly icon: Icon;
  readonly fg: string;
  readonly word: string;
}

/** Each state's glyph, colour and word — exhaustive, so a new state fails `typecheck` here. */
export const FLOW_STATE_LOOK: Readonly<Record<FlowState, StateLook>> = {
  done: { icon: CheckCircleFillIcon, fg: 'text-success', word: 'Done' },
  current: { icon: DotFillIcon, fg: 'text-running', word: 'Current' },
  upcoming: { icon: CircleIcon, fg: 'text-fg-subtle', word: 'Upcoming' },
  returned: { icon: UndoIcon, fg: 'text-attention', word: 'Sent back' },
  failed: { icon: XCircleFillIcon, fg: 'text-danger', word: 'Failed' },
  skipped: { icon: SkipIcon, fg: 'text-fg-muted', word: 'Skipped' },
  disabled: { icon: CircleSlashIcon, fg: 'text-fg-subtle', word: 'Disabled' },
};

export const KIND_LOOK: Readonly<
  Record<StageKind, { readonly icon: Icon; readonly word: string }>
> = {
  agent: { icon: DependabotIcon, word: 'Agent stage' },
  gate: { icon: ShieldCheckIcon, word: 'Automatic check' },
  human: { icon: PersonIcon, word: 'Waits for a person' },
  system: { icon: GearIcon, word: 'Automatic step' },
};

/**
 * What a gate waits for, in one line — a gate card has no role to show, and an empty card reads
 * as a stage with nothing in it. The platform's three gates by name (exhaustive over
 * `BUILTIN_GATE_STAGE_IDS`), and a project's own gate in general words.
 */
export const GATE_BODY: Readonly<Record<BuiltinGateStageId, string>> = {
  ci_gate: 'Waits for the CI pipeline',
  rebase_gate: 'Checks the branch is up to date with the default branch',
  merged_gate: 'Waits for the merge request to merge',
};

/** The line under a card's name: the role, a gate's body, or the kind in words. */
export const cardBody = (node: Pick<FlowNode, 'id' | 'kind' | 'role'>): string =>
  node.role !== null
    ? ROLE_LABEL[node.role]
    : node.kind === 'gate'
      ? Object.hasOwn(GATE_BODY, node.id)
        ? GATE_BODY[node.id as BuiltinGateStageId]
        : 'Waits for an event to settle it'
      : KIND_LOOK[node.kind].word;

/** "Attempt 2", or `null` for a first one — the one spelling (S-23.23, the UX audit's § 4). */
export const attemptLabel = (attempt: number | null): string | null =>
  attempt === null || attempt < 2 ? null : `Attempt ${attempt}`;

/** The epoch-relative duration as the app prints elapsed time ("12m 3s"). */
export const formatDuration = (ms: number): string => formatElapsed(new Date(0).toISOString(), ms);

/** The status word a card shows: the activity's on the current stage, else the state's. */
export const statusWord = (node: FlowNode): string | null => {
  if (node.state === null) {
    return null;
  }
  if (node.state === 'current' && node.activity !== null) {
    return ACTIVITY_META[node.activity.activity].label;
  }
  return FLOW_STATE_LOOK[node.state].word;
};

/** The model and effort chip's words: "claude-opus-5 · high". */
export const modelChip = (node: Pick<FlowNode, 'model' | 'effort'>): string | null =>
  node.model === null ? null : node.effort === null ? node.model : `${node.model} · ${node.effort}`;

/** "12m 3s · $4.25" for a stage that is done; `null` otherwise. */
export const doneFacts = (node: FlowNode): string | null => {
  if (node.state !== 'done') {
    return null;
  }
  const parts = [
    node.durationMs === null ? null : formatDuration(node.durationMs),
    node.run === null ? null : formatRunCost(node.run.cost, { estimate: true }),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
};

/**
 * The card's accessible name, which a screen reader hears and a test asks for: it opens with the
 * visible name (WCAG 2.5.3) and says everything the card shows, in reading order.
 */
export const stageCardName = (node: FlowNode): string =>
  [
    node.label,
    cardBody(node),
    statusWord(node),
    node.activity?.detail === null || node.activity?.detail === undefined
      ? null
      : `Now: ${node.activity.detail}`,
    attemptLabel(node.attempt),
    modelChip(node),
    doneFacts(node),
  ]
    .filter((part): part is string => part !== null)
    .join(', ');

export const StageCard = ({
  node,
  onOpen,
  className,
  tabbable = true,
}: {
  readonly node: FlowNode;
  readonly onOpen: (id: string) => void;
  readonly className?: string;
  /**
   * `false` for the screen-reader copy beside the canvas: a screen reader still reaches and
   * presses it, but Tab does not land on a card nobody can see — the canvas's own card is the stop.
   */
  readonly tabbable?: boolean;
}): ReactElement => {
  const Kind = KIND_LOOK[node.kind].icon;
  const word = statusWord(node);
  const attempt = attemptLabel(node.attempt);
  const chip = modelChip(node);
  const facts = doneFacts(node);
  const current = node.state === 'current';
  const look = node.state === null ? null : FLOW_STATE_LOOK[node.state];
  const Glyph = look?.icon ?? null;
  const small = node.kind === 'gate' || node.kind === 'system';
  return (
    <button
      type="button"
      data-stage-card={node.id}
      data-stage-state={node.state ?? 'configured'}
      data-stage-kind={node.kind}
      aria-label={stageCardName(node)}
      aria-haspopup="dialog"
      {...(tabbable ? {} : { tabIndex: -1 })}
      onClick={() => {
        onOpen(node.id);
      }}
      className={cx(
        // `nodrag nopan`: the canvas does not start a pan or a drag on a press that opens a card.
        'nodrag nopan flex h-full w-full min-w-0 flex-col gap-1 overflow-hidden rounded-lg border bg-subtle text-left text-fg transition-colors hover:bg-muted',
        small ? 'px-2.5 py-2' : 'px-3 py-2.5',
        current
          ? 'border-running shadow-[0_0_0_3px_var(--running-bg)]'
          : node.state === 'failed'
            ? 'border-danger'
            : node.state === 'disabled'
              ? 'border-dashed border-line opacity-70'
              : 'border-line',
        node.kind === 'human' ? 'border-l-4 border-l-done' : null,
        FOCUS_RING,
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" className="inline-flex shrink-0 text-fg-muted">
          <Kind size={small ? 12 : 16} />
        </span>
        <span className={cx('truncate font-semibold', small ? 'text-xs' : 'text-sm')}>
          {node.label}
        </span>
        {attempt === null ? null : (
          <span className="ml-auto shrink-0 rounded-full border border-attention/40 bg-attention-bg px-1.5 text-[11px] text-attention">
            {attempt}
          </span>
        )}
      </span>
      {node.kind === 'system' ? null : (
        <span
          className={cx(
            'text-fg-muted',
            small ? 'line-clamp-2 text-[11px] leading-tight' : 'truncate text-xs',
          )}
        >
          {cardBody(node)}
        </span>
      )}
      {word === null || look === null || Glyph === null ? null : (
        <span className={cx('flex min-w-0 items-center gap-1 text-xs font-medium', look.fg)}>
          {current && node.activity !== null ? (
            <StatusIcon status={ACTIVITY_META[node.activity.activity].icon} decorative size={12} />
          ) : (
            <span aria-hidden="true" className="inline-flex">
              <Glyph size={12} />
            </span>
          )}
          <span className="truncate">{word}</span>
        </span>
      )}
      {current && node.activity?.detail !== null && node.activity?.detail !== undefined ? (
        <span
          data-stage-now=""
          className="self-start truncate rounded-full border border-running/40 bg-running-bg px-2 py-px text-[11px] font-medium text-running"
        >
          {`Now: ${node.activity.detail}`}
        </span>
      ) : null}
      {node.state === null && node.produces !== null && !small ? (
        <span className="truncate text-[11px] text-fg-muted">
          {`Writes ${ARTIFACT_TYPE_LABEL[node.produces].toLowerCase()}`}
        </span>
      ) : null}
      {chip === null && facts === null ? null : (
        <span className="mt-auto flex min-w-0 items-center gap-1.5 text-[11px] text-fg-muted">
          {chip === null ? null : (
            <span className="truncate rounded border border-line bg-default px-1 font-mono">
              {chip}
            </span>
          )}
          {facts === null ? null : <span className="shrink-0">{facts}</span>}
        </span>
      )}
    </button>
  );
};
