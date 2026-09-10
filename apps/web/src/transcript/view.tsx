/**
 * The transcript itself: blocks, follow-tail, the "paused updates" indicator and search.
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
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, formatInteger, formatUsd } from '../ui/kit.js';
import { CodeText, JsonView, UntrustedProse, UntrustedText } from '../ui/untrusted.js';
import type { ToolBlock, TranscriptBlock } from './blocks.js';
import { ToolBody, ToolHeader } from './renderers.js';

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

const Frame = ({
  kind,
  label,
  tone,
  children,
}: {
  readonly kind: string;
  readonly label: ReactNode;
  readonly tone?: string;
  readonly children: ReactNode;
}): ReactElement => (
  <article
    data-block-kind={kind}
    className={`rounded-lg border border-line bg-surface p-3 ${tone ?? ''}`}
  >
    <div className="pb-2 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
      {label}
    </div>
    {children}
  </article>
);

const BlockView = ({ block }: { readonly block: TranscriptBlock }): ReactElement => {
  switch (block.kind) {
    case 'text':
      return (
        <Frame kind="text" label={block.streaming ? 'assistant · streaming' : 'assistant'}>
          <UntrustedProse value={block.text} />
        </Frame>
      );
    case 'thinking':
      return (
        <Frame kind="thinking" label="thinking">
          {/* product/10: thinking blocks are collapsed by default. `<details>` is the native
              disclosure widget, so keyboard and screen-reader behaviour come for free. */}
          <details>
            <summary className="cursor-pointer text-xs text-fg-muted">show reasoning</summary>
            <div className="pt-2">
              <UntrustedProse value={block.text} />
            </div>
          </details>
        </Frame>
      );
    case 'user':
      return (
        <Frame kind="user" label="user">
          <UntrustedProse value={block.text} />
        </Frame>
      );
    case 'tool':
      return (
        <Frame kind="tool" label={<ToolHeader block={block} />}>
          <ToolBody
            block={block}
            renderChildren={(parent: ToolBlock) => (
              <div className="flex flex-col gap-2">
                {parent.children.map((child) => (
                  <BlockView key={child.id} block={child} />
                ))}
              </div>
            )}
          />
        </Frame>
      );
    case 'hook':
      return (
        <Frame kind="hook" label={`hook · ${block.hook}`}>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {block.toolName === null ? null : (
              <span className="font-mono">
                <UntrustedText value={block.toolName} />
              </span>
            )}
            {block.decision === null ? null : (
              <Badge tone={block.decision === 'deny' ? 'danger' : 'warning'}>
                {block.decision}
              </Badge>
            )}
          </div>
          {block.reason === null ? null : (
            <p className="pt-1 text-sm">
              <UntrustedText value={block.reason} />
            </p>
          )}
        </Frame>
      );
    case 'steer':
      return (
        <Frame kind="steer" label="steer" tone="border-accent/50">
          <UntrustedProse value={block.message} />
        </Frame>
      );
    case 'compaction':
      return (
        <Frame kind="compaction" label={`compaction · ${block.phase}`}>
          <p className="text-xs text-fg-muted">
            {block.preTokens === null ? '—' : formatInteger(block.preTokens)} →{' '}
            {block.postTokens === null ? '—' : formatInteger(block.postTokens)} tokens
          </p>
        </Frame>
      );
    case 'system':
      return (
        <Frame kind="system" label={`system · ${block.subtype}`}>
          <JsonView value={block.data} />
        </Frame>
      );
    case 'result':
      return (
        <Frame kind="result" label="result">
          <div className="flex flex-wrap gap-4 text-xs">
            <span>
              reason: <UntrustedText value={block.terminalReason} />
            </span>
            <span>turns: {formatInteger(block.numTurns)}</span>
            <span>
              cost: {formatUsd(block.costUsd)}
              {block.isEstimate ? ' (estimated)' : ''}
            </span>
          </div>
        </Frame>
      );
  }
};

export interface TranscriptViewProps {
  readonly blocks: readonly TranscriptBlock[];
  readonly emptyHint?: string;
}

export const TranscriptView = ({ blocks, emptyHint }: TranscriptViewProps): ReactElement => {
  const [query, setQuery] = useState('');
  const [following, setFollowing] = useState(true);
  const [seen, setSeen] = useState(blocks.length);
  const scroller = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => filterBlocks(blocks, query), [blocks, query]);

  useEffect(() => {
    if (!following) {
      return;
    }
    setSeen(blocks.length);
    const element = scroller.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [blocks.length, following]);

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
          className="w-56 rounded-md border border-line bg-surface px-2 py-1 text-sm"
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
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
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
