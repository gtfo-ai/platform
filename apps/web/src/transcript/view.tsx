/**
 * The transcript itself: blocks, follow-tail, the "paused updates" indicator and search.
 *
 * **Drawn as a log** (S-23.10, research/19 § 5.2 "Run"), as GitHub Actions draws a job: a tool call
 * is a collapsed **log step** — chevron, status icon, the tool, the argument summary, the duration
 * right-aligned (`steps.ts`) — that opens onto the renderer registry's body (`renderers.tsx`), open
 * on arrival while it runs or after it failed; the model's text is prose lines; thinking and the
 * CLI's start-up notice are collapsed; everything else is one row. The scroller is its own pane —
 * the run page sizes it to the viewport through `scrollerClassName` — and following its end is
 * keyed on the tail's signature, so a result folded into a call or a streaming block's next words
 * are followed too, not only a new block.
 *
 * **Not virtualised.** technical/09 asks for TanStack Virtual in chat mode, and this ships a plain
 * list instead, for a reason worth stating rather than hiding: a virtualiser measures the DOM, and
 * the `ui` tier runs in happy-dom, where every element is zero-high. A virtualised list under that
 * renderer draws *nothing*, so every positive assertion about transcript content would have to be
 * dropped and replaced by "no error appeared" — the vacuous pass of standing rule 4. Virtualisation
 * is a performance change that needs the browser-mode tier technical/10 describes; it is recorded
 * as follow-up with the tier it needs, not skipped silently.
 *
 * Everything rendered here is untrusted (BD-022) and goes through `ui/untrusted.tsx`.
 */
import { ChevronRightIcon } from '@primer/octicons-react/ChevronRightIcon';
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { terminalReasonLabel } from '../ui/humanize.js';
import { Badge, Button, formatInteger, formatUsd } from '../ui/kit.js';
import { StatusIcon } from '../ui/status.js';
import { CodeText, JsonView, UntrustedProse, UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import type { ToolBlock, TranscriptBlock } from './blocks.js';
import { ToolBody } from './renderers.js';
import { stepOpenByDefault, stepStatus, stepSummary, stepTiming, stepTitle } from './steps.js';

/** Everything a block says, as one searchable string. Pure, so search is testable. */
export const blockText = (block: TranscriptBlock): string => {
  switch (block.kind) {
    case 'text':
    case 'thinking':
      return block.text;
    case 'user':
      return block.text;
    case 'tool':
      return [block.toolName, JSON.stringify(block.input), block.result?.content ?? '']
        .concat(block.children.map(blockText))
        .join('\n');
    case 'hook':
      return [block.hook, block.toolName ?? '', block.decision ?? '', block.reason ?? ''].join(' ');
    case 'steer':
      return block.message;
    case 'compaction':
      return `compaction ${block.phase}`;
    case 'system':
      return `${block.subtype} ${block.model ?? ''}`;
    case 'result':
      return block.terminalReason;
    case 'progress':
      return block.summary;
  }
};

export const filterBlocks = (
  blocks: readonly TranscriptBlock[],
  query: string,
): readonly TranscriptBlock[] => {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return blocks;
  }
  return blocks.filter((block) => blockText(block).toLowerCase().includes(needle));
};

/** A one-line row of the log: what happened, in platform words, and the run's text beside it. */
const LogRow = ({
  kind,
  label,
  children,
  tone,
}: {
  readonly kind: string;
  readonly label: ReactNode;
  readonly children?: ReactNode;
  readonly tone?: string;
}): ReactElement => (
  <article
    data-block-kind={kind}
    className={cx('flex flex-wrap items-baseline gap-x-2 gap-y-1 px-2 py-1 text-sm', tone)}
  >
    <span className="text-xs font-semibold text-fg-muted">{label}</span>
    {children}
  </article>
);

/**
 * A disclosure row of the log — a tool call's step, a thinking block, the CLI's own start-up
 * notice. A native `<details>`, so the keyboard and the expanded state come from the browser.
 *
 * **Open follows `defaultOpen` until the reader toggles it**: a step open because it was running
 * closes when it succeeds, and one somebody opened or closed stays as they left it — a frame
 * arriving never folds or unfolds it under them. The browser fires `toggle` for the attribute React
 * sets as well as for a click, so only a toggle that disagrees with what this render asked for is
 * the reader's.
 *
 * Nothing interactive goes inside `<summary>`: a link there is nested interactive content and takes
 * the click that should toggle the step, so the summary's words are plain text.
 */
const Step = ({
  kind,
  summary,
  children,
  defaultOpen = false,
}: {
  readonly kind: string;
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
}): ReactElement => {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? defaultOpen;
  const rendered = useRef(open);
  rendered.current = open;
  return (
    <article data-block-kind={kind}>
      <details
        data-log-step={kind}
        open={open}
        onToggle={(event) => {
          const now = event.currentTarget.open;
          if (now !== rendered.current) {
            setChosen(now);
          }
        }}
        className="group rounded-md"
      >
        <summary
          className={cx(
            'flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-subtle [&::-webkit-details-marker]:hidden',
            FOCUS_RING,
          )}
        >
          <span
            aria-hidden="true"
            className="inline-flex text-fg-muted transition-transform group-open:rotate-90"
          >
            <ChevronRightIcon size={16} />
          </span>
          {summary}
        </summary>
        <div className="ml-8 border-l border-line py-2 pr-2 pl-3">{children}</div>
      </details>
    </article>
  );
};

/** A tool call: the step's summary line, the existing renderer when it is opened. */
const ToolStep = ({ block }: { readonly block: ToolBlock }): ReactElement => {
  const status = stepStatus(block);
  const summary = stepSummary(block);
  return (
    <Step
      kind="tool"
      defaultOpen={stepOpenByDefault(block)}
      summary={
        <>
          <StatusIcon status={status} size={16} />
          <span
            className={cx(
              'shrink-0 font-mono text-xs font-semibold',
              status === 'failure' ? 'text-danger' : 'text-fg',
            )}
          >
            {/* The tool's name comes from the model: filtered plain text, never a link, an
                attribute or a class — a link inside <summary> would take the toggle's click. */}
            {sanitiseUntrusted(stepTitle(block.toolName))}
          </span>
          {summary === '' ? null : (
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
              {sanitiseUntrusted(summary)}
            </span>
          )}
          <span
            data-step-timing=""
            className="ml-auto shrink-0 pl-2 font-mono text-xs text-fg-muted tabular-nums"
          >
            {stepTiming(block)}
          </span>
        </>
      }
    >
      <ToolBody
        block={block}
        renderChildren={(parent: ToolBlock) => (
          <div className="flex flex-col gap-1">
            {parent.children.map((child) => (
              <BlockView key={child.id} block={child} />
            ))}
          </div>
        )}
      />
    </Step>
  );
};

const BlockView = ({ block }: { readonly block: TranscriptBlock }): ReactElement => {
  switch (block.kind) {
    case 'text':
      // The model's words stay prose lines, as an Actions log prints a step's output.
      return (
        <article data-block-kind="text" className="px-2 py-1">
          {block.streaming ? (
            <p className="pb-1 text-xs text-fg-muted">Assistant · writing…</p>
          ) : null}
          <UntrustedProse value={block.text} />
        </article>
      );
    case 'thinking':
      // product/10: thinking blocks are collapsed by default.
      return (
        <Step
          kind="thinking"
          summary={<span className="text-xs text-fg-muted">Thinking — show reasoning</span>}
        >
          <UntrustedProse value={block.text} />
        </Step>
      );
    case 'user':
      return (
        <LogRow kind="user" label="User">
          <div className="w-full">
            <UntrustedProse value={block.text} />
          </div>
        </LogRow>
      );
    case 'tool':
      return <ToolStep block={block} />;
    case 'hook':
      return (
        <LogRow kind="hook" label={`Hook · ${block.hook}`}>
          {block.toolName === null ? null : (
            <span className="font-mono text-xs">
              <UntrustedText value={block.toolName} />
            </span>
          )}
          {block.decision === null ? null : (
            <Badge tone={block.decision === 'deny' ? 'danger' : 'warning'}>{block.decision}</Badge>
          )}
          {block.reason === null ? null : (
            <span className="text-sm">
              <UntrustedText value={block.reason} />
            </span>
          )}
        </LogRow>
      );
    case 'steer':
      return (
        <LogRow kind="steer" label="Steer" tone="border-l-2 border-link">
          <div className="w-full">
            <UntrustedProse value={block.message} />
          </div>
        </LogRow>
      );
    case 'compaction':
      return (
        <LogRow kind="compaction" label={`Compaction · ${block.phase}`}>
          <span className="text-xs text-fg-muted">
            {block.preTokens === null ? '—' : formatInteger(block.preTokens)} →{' '}
            {block.postTokens === null ? '—' : formatInteger(block.postTokens)} tokens
          </span>
        </LogRow>
      );
    case 'system':
      return (
        <Step
          kind="system"
          summary={
            <span className="text-xs text-fg-muted">
              {`System · ${sanitiseUntrusted(block.subtype)}`}
            </span>
          }
        >
          <JsonView value={block.data} />
        </Step>
      );
    case 'progress':
      return (
        <LogRow kind="progress" label="Progress" tone="border-l-2 border-link">
          {block.percentComplete === null ? null : (
            <Badge tone="accent">{`${formatInteger(block.percentComplete)}%`}</Badge>
          )}
          <span>
            <UntrustedText value={block.summary} />
          </span>
          {block.truncated ? (
            <span className="text-xs text-fg-muted">(shortened by the platform)</span>
          ) : null}
        </LogRow>
      );
    case 'result':
      return (
        <LogRow kind="result" label="The run ended" tone="border-t border-line pt-2">
          <span className="flex flex-wrap gap-4 text-xs">
            <span>
              {/* A reason this build has no word for is the producer's own string, title-cased. */}
              Ended because: <UntrustedText value={terminalReasonLabel(block.terminalReason)} />
            </span>
            <span>turns: {formatInteger(block.numTurns)}</span>
            <span>
              cost: {formatUsd(block.costUsd)}
              {block.isEstimate ? ' (estimated)' : ''}
            </span>
          </span>
        </LogRow>
      );
  }
};

/**
 * What changes when the log grows — a new block, a result folded into a call, a streaming block's
 * next words — so following the end follows all of it, not only a new block.
 */
const tailSignature = (blocks: readonly TranscriptBlock[]): string => {
  const last = blocks.at(-1);
  if (last === undefined) {
    return '0';
  }
  const size = last.kind === 'text' || last.kind === 'thinking' ? last.text.length : 0;
  return `${blocks.length}:${last.id}:${last.at}:${size}`;
};

export interface TranscriptViewProps {
  readonly blocks: readonly TranscriptBlock[];
  readonly emptyHint?: string;
  /**
   * The log pane's own size. The run page sizes it to the viewport, so the pane scrolls and the
   * page does not grow (technical/09's follow-tail); the task page's panel bounds it by its box.
   */
  readonly scrollerClassName?: string;
}

export const TranscriptView = ({
  blocks,
  emptyHint,
  scrollerClassName,
}: TranscriptViewProps): ReactElement => {
  const [query, setQuery] = useState('');
  const [following, setFollowing] = useState(true);
  const [seen, setSeen] = useState(blocks.length);
  const scroller = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => filterBlocks(blocks, query), [blocks, query]);
  const tail = tailSignature(blocks);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tail` is the trigger — the log grew.
  useEffect(() => {
    if (!following) {
      return;
    }
    setSeen(blocks.length);
    const element = scroller.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [tail, blocks.length, following]);

  const behind = Math.max(0, blocks.length - seen);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder="Search transcript"
          aria-label="Search transcript"
          className="w-56 rounded-md border border-line-input bg-inset px-2 py-1 text-sm"
        />
        <Button
          tone={following ? 'primary' : 'default'}
          aria-pressed={following}
          onClick={() => {
            setFollowing((current) => !current);
          }}
        >
          {following ? 'Following' : 'Follow tail'}
        </Button>
        {behind > 0 && !following ? (
          <span data-testid="paused-updates" role="status" aria-live="polite">
            <Badge tone="warning">{`Paused updates, ${formatInteger(behind)} behind`}</Badge>
          </span>
        ) : null}
        <span className="ml-auto text-xs text-fg-muted">
          {formatInteger(visible.length)} of {formatInteger(blocks.length)} blocks
        </span>
      </div>

      <div
        ref={scroller}
        data-testid="transcript-scroller"
        className={cx(
          'flex min-h-0 flex-col gap-0.5 overflow-y-auto rounded-md border border-line bg-default py-1',
          scrollerClassName ?? 'flex-1',
        )}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
          setFollowing(atBottom);
          if (atBottom) {
            setSeen(blocks.length);
          }
        }}
      >
        {visible.length === 0 ? (
          <p className="p-4 text-sm text-fg-muted">
            {query.trim() === ''
              ? (emptyHint ??
                'Nothing yet. Entries appear here as the agent works — the stream is live.')
              : 'No block matches that search.'}
          </p>
        ) : (
          visible.map((block) => <BlockView key={block.id} block={block} />)
        )}
      </div>
    </div>
  );
};

/** Exported for the run screen's "raw" tab, which shows what the stream actually delivered. */
export const RawEvents = ({ value }: { readonly value: unknown }): ReactElement => (
  <CodeText value={JSON.stringify(value, null, 2)} />
);
