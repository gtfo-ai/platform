import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  // S-23.22: the end row says why in the run page's words, never the SDK's raw reason.
  it.each([
    ['error_max_turns', 'Ended because: Ran out of turns'],
    ['a_reason_this_build_does_not_know', 'Ended because: A Reason This Build Does Not Know'],
  ])('says why the run ended in words (%s)', (reason, expected) => {
    const { container } = render(
      <TranscriptView
        blocks={[
          {
            kind: 'result',
            id: 'r',
            seq: 1,
            at: AT,
            terminalReason: reason,
            numTurns: 2,
            durationMs: 10,
            costUsd: 1.5,
            isEstimate: false,
          },
        ]}
      />,
    );
    const row = container.querySelector('[data-block-kind="result"]');
    expect(row?.textContent).toContain(expected);
    expect(row?.textContent).not.toContain(reason);
  });

  // Review of PR #51: an unknown reason is the producer's string, so it goes through UntrustedText.
  it('renders an unknown reason as untrusted text', () => {
    const { container } = render(
      <TranscriptView
        blocks={[
          {
            kind: 'result',
            id: 'r',
            seq: 1,
            at: AT,
            terminalReason: 'odd\u202Ereason',
            numTurns: 2,
            durationMs: 10,
            costUsd: 1.5,
            isEstimate: false,
          },
        ]}
      />,
    );
    const row = container.querySelector('[data-block-kind="result"]');
    expect(row?.textContent).toContain('Ended because:');
    expect(row?.textContent).not.toContain('\u202E');
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

  it('writes a step’s tool and summary as plain text, so a model’s URL or markup is no link and the step still toggles', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TranscriptView
        blocks={[
          tool({
            toolName: 'javascript:alert(1)',
            input: { command: 'curl https://evil.example.test/x <img src=x onerror=alert(1)>' },
          }),
        ]}
      />,
    );
    const step = container.querySelector('[data-log-step="tool"]') as HTMLDetailsElement;
    const summary = step.querySelector('summary') as HTMLElement;
    expect(summary.textContent).toContain('javascript:alert(1)');
    expect(summary.textContent).toContain(
      'curl https://evil.example.test/x <img src=x onerror=alert(1)>',
    );
    // Nothing interactive and no element made of it inside <summary>.
    expect(summary.querySelector('a, img, button, input')).toBeNull();
    expect(step.open).toBe(false);
    await user.click(summary);
    expect(step.open).toBe(true);
    await user.click(summary);
    expect(step.open).toBe(false);
  });

  it('closes a step that was open because it ran once it succeeds', () => {
    const view = render(<TranscriptView blocks={[tool({ result: null })]} />);
    const step = () => view.container.querySelector('[data-log-step="tool"]') as HTMLDetailsElement;
    expect(step().open).toBe(true);
    view.rerender(
      <TranscriptView
        blocks={[
          tool({ at: '2026-11-05T10:00:02.000Z', result: { isError: false, content: 'ok' } }),
        ]}
      />,
    );
    expect(step().open).toBe(false);
  });

  it('leaves a step the reader toggled as they left it when its result arrives', async () => {
    const user = userEvent.setup();
    const view = render(<TranscriptView blocks={[tool({ result: null })]} />);
    const step = () => view.container.querySelector('[data-log-step="tool"]') as HTMLDetailsElement;
    const summary = () => step().querySelector('summary') as HTMLElement;
    // Closed by hand, then opened again: from now on it is the reader's.
    await user.click(summary());
    expect(step().open).toBe(false);
    await user.click(summary());
    expect(step().open).toBe(true);
    view.rerender(
      <TranscriptView
        blocks={[
          tool({ at: '2026-11-05T10:00:02.000Z', result: { isError: false, content: 'ok' } }),
        ]}
      />,
    );
    expect(step().open).toBe(true);
  });

  it('keeps following when only the last call’s result arrives or a streaming block grows', () => {
    const streaming = (text: string) => ({
      kind: 'text' as const,
      id: 's',
      seq: 2,
      at: AT,
      text,
      streaming: true,
    });
    const running = tool({ result: null });
    const view = render(<TranscriptView blocks={[running]} />);
    const scroller = screen.getByTestId('transcript-scroller');
    const grow = (height: number) => {
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: height });
    };
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 });
    grow(1000);
    view.rerender(<TranscriptView blocks={[{ ...running }]} />);

    // The same count, the same last block: only its result and its time moved.
    grow(1400);
    view.rerender(
      <TranscriptView
        blocks={[
          { ...running, at: '2026-11-05T10:00:05.000Z', result: { isError: false, content: 'x' } },
        ]}
      />,
    );
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(scroller.scrollTop).toBe(1400);

    // A streaming block's next words: one block more, then the same block longer.
    grow(1600);
    view.rerender(<TranscriptView blocks={[running, streaming('half a')]} />);
    expect(scroller.scrollTop).toBe(1600);
    grow(1900);
    view.rerender(<TranscriptView blocks={[running, streaming('half a sentence')]} />);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(scroller.scrollTop).toBe(1900);
  });
});
