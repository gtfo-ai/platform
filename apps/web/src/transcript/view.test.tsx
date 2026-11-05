import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolBlock, TranscriptBlock } from './blocks.js';
import { toolRendererKind } from './renderers.js';
import { blockText, filterBlocks, TranscriptView } from './view.js';

afterEach(() => {
  cleanup();
});

const AT = '2026-11-05T10:00:00.000Z';

const tool = (overrides: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: 'tool',
  id: 't1',
  seq: 1,
  at: AT,
  startedAt: AT,
  toolUseId: 'toolu_1',
  toolName: 'Bash',
  input: { command: 'pnpm test' },
  result: { isError: false, content: 'ok' },
  children: [],
  ...overrides,
});

describe('toolRendererKind', () => {
  it.each([
    ['Edit', 'diff'],
    ['Write', 'diff'],
    ['MultiEdit', 'diff'],
    ['NotebookEdit', 'diff'],
    ['Bash', 'terminal'],
    ['BashOutput', 'terminal'],
    ['Read', 'file'],
    ['Grep', 'file'],
    ['Glob', 'file'],
    ['Task', 'agent'],
    ['Agent', 'agent'],
    ['WebFetch', 'link'],
    ['WebSearch', 'link'],
    ['AskUserQuestion', 'question'],
    ['ask_human', 'question'],
    ['mcp__sentry__issue', 'json'],
    ['mcp__platform__kb_search', 'json'],
    ['SomethingNobodyHasWrittenYet', 'generic'],
    ['', 'generic'],
  ])('routes %j to the %s renderer', (name, kind) => {
    expect(toolRendererKind(name)).toBe(kind);
  });
});

describe('blockText and filterBlocks', () => {
  it('searches a tool call by its name, its input and its output', () => {
    const text = blockText(tool());
    expect(text).toContain('Bash');
    expect(text).toContain('pnpm test');
    expect(text).toContain('ok');
  });

  it('searches a subagent’s nested blocks too', () => {
    const nested = tool({
      toolName: 'Task',
      children: [
        { kind: 'text', id: 'c1', seq: 2, at: AT, text: 'buried treasure', streaming: false },
      ],
    });
    expect(blockText(nested)).toContain('buried treasure');
  });

  it('returns the same array when the query is empty', () => {
    const blocks: TranscriptBlock[] = [tool()];
    expect(filterBlocks(blocks, '  ')).toBe(blocks);
  });

  it('filters case-insensitively', () => {
    const blocks: TranscriptBlock[] = [
      tool(),
      { kind: 'text', id: 'x', seq: 2, at: AT, text: 'unrelated', streaming: false },
    ];
    expect(filterBlocks(blocks, 'PNPM')).toHaveLength(1);
    expect(filterBlocks(blocks, 'nothing here')).toHaveLength(0);
  });
});

describe('TranscriptView', () => {
  it('renders one article per block, tagged with its kind', () => {
    const { container } = render(
      <TranscriptView
        blocks={[
          { kind: 'text', id: 'a', seq: 1, at: AT, text: 'assistant says hello', streaming: false },
          tool(),
          {
            kind: 'result',
            id: 'r',
            seq: 3,
            at: AT,
            terminalReason: 'success',
            numTurns: 2,
            durationMs: 10,
            costUsd: 1.5,
            isEstimate: false,
          },
        ]}
      />,
    );

    expect(container.querySelectorAll('[data-block-kind]')).toHaveLength(3);
    expect(container.querySelector('[data-block-kind="tool"]')).not.toBeNull();
    expect(screen.getByText('assistant says hello')).toBeTruthy();
    expect(screen.getByText('$1.50', { exact: false })).toBeTruthy();
  });

  it('renders a progress line as untrusted text, with its percentage and a cut marked (backlog 496)', () => {
    const summary = '<b>slice 2</b> pushed';
    const { container } = render(
      <TranscriptView
        blocks={[
          {
            kind: 'progress',
            id: 'p',
            seq: 4,
            at: AT,
            summary,
            percentComplete: 40,
            truncated: true,
          },
        ]}
      />,
    );
    const block = container.querySelector('[data-block-kind="progress"]');
    expect(block?.textContent).toContain(summary);
    expect(block?.textContent).toContain('40%');
    expect(block?.textContent).toContain('(shortened by the platform)');
    expect(block?.querySelector('b')).toBeNull();
    expect(
      blockText({
        kind: 'progress',
        id: 'p',
        seq: 4,
        at: AT,
        summary,
        percentComplete: null,
        truncated: false,
      }),
    ).toBe(summary);
  });

  it('renders a Bash tool as a terminal block with the ANSI stripped', () => {
    render(
      <TranscriptView
        blocks={[tool({ result: { isError: false, content: '\u001B[32mpassed\u001B[0m' } })]}
      />,
    );
    expect(screen.getByTestId('terminal-block').textContent).toBe('passed');
  });

  it('renders a sub-agent’s transcript nested inside its tool call', () => {
    render(
      <TranscriptView
        blocks={[
          tool({
            toolName: 'Task',
            input: { prompt: 'investigate' },
            children: [
              { kind: 'text', id: 'c1', seq: 2, at: AT, text: 'nested finding', streaming: false },
            ],
          }),
        ]}
      />,
    );

    const nested = screen.getByTestId('nested-transcript');
    expect(nested.textContent).toContain('nested finding');
  });

  it('collapses a thinking block behind a disclosure', () => {
    const { container } = render(
      <TranscriptView
        blocks={[
          {
            kind: 'thinking',
            id: 'k',
            seq: 1,
            at: AT,
            text: 'private reasoning',
            streaming: false,
          },
        ]}
      />,
    );

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('teaches in its empty state instead of showing nothing', () => {
    render(<TranscriptView blocks={[]} />);
    expect(screen.getByText(/Entries appear here as the agent works/)).toBeTruthy();
  });

  it('reports how many blocks a search matched', () => {
    render(
      <TranscriptView
        blocks={[
          { kind: 'text', id: 'a', seq: 1, at: AT, text: 'alpha', streaming: false },
          { kind: 'text', id: 'b', seq: 2, at: AT, text: 'beta', streaming: false },
        ]}
      />,
    );
    expect(screen.getByText('2 of 2 blocks')).toBeTruthy();
  });

  it('draws a tool call as a log step: status, tool, argument summary and duration on one line', () => {
    const { container } = render(
      <TranscriptView
        blocks={[
          tool({ at: '2026-11-05T10:00:01.500Z', startedAt: AT }),
          tool({
            id: 't2',
            seq: 2,
            toolName: 'mcp__platform__kb_search',
            input: { query: 'vat rates' },
            result: null,
          }),
          tool({ id: 't3', seq: 3, result: { isError: true, content: 'exit 1' } }),
        ]}
      />,
    );
    const steps = [...container.querySelectorAll('[data-log-step="tool"]')];
    expect(steps).toHaveLength(3);
    const [done, running, failed] = steps;
    // Collapsed once answered; the running and the failed one open on arrival, as Actions does.
    expect(done?.hasAttribute('open')).toBe(false);
    expect(running?.hasAttribute('open')).toBe(true);
    expect(failed?.hasAttribute('open')).toBe(true);
    const line = done?.querySelector('summary');
    expect(line?.querySelector('[data-status="success"]')).not.toBeNull();
    expect(line?.textContent).toContain('Bash');
    expect(line?.textContent).toContain('pnpm test');
    expect(line?.querySelector('[data-step-timing]')?.textContent).toBe('1.5s');
    // A platform tool reads in the vocabulary's words.
    expect(running?.querySelector('summary')?.textContent).toContain(
      'Searching the knowledge base',
    );
    expect(running?.querySelector('[data-step-timing]')?.textContent).toBe('running');
    expect(failed?.querySelector('summary [data-status="failure"]')).not.toBeNull();
  });

  it('pauses when the reader scrolls up, counts what arrived since, and follows again', () => {
    const text = (id: string, seq: number) => ({
      kind: 'text' as const,
      id,
      seq,
      at: AT,
      text: id,
      streaming: false,
    });
    const view = render(<TranscriptView blocks={[text('a', 1), text('b', 2)]} />);
    const scroller = screen.getByTestId('transcript-scroller');
    // happy-dom lays nothing out: give the pane a size so "scrolled up" means something.
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: 'Follow tail' })).toBeTruthy();

    view.rerender(
      <TranscriptView blocks={[text('a', 1), text('b', 2), text('c', 3), text('d', 4)]} />,
    );
    expect(screen.getByTestId('paused-updates').textContent).toBe('Paused updates, 2 behind');
    // Not followed while paused: the reader's place is kept.
    expect(scroller.scrollTop).toBe(0);

    act(() => {
      screen.getByRole('button', { name: 'Follow tail' }).click();
    });
    expect(screen.queryByTestId('paused-updates')).toBeNull();
    expect(screen.getByRole('button', { name: 'Following' })).toBeTruthy();
    expect(scroller.scrollTop).toBe(1000);
  });
});
