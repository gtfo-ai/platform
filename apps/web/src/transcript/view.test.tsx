import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolBlock, TranscriptBlock } from './blocks.js';
import { toolRendererKind } from './renderers.js';
import { blockText, filterBlocks, TranscriptView } from './view.js';

afterEach(() => {
  cleanup();
});

const tool = (overrides: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: 'tool',
  id: 't1',
  seq: 1,
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
      children: [{ kind: 'text', id: 'c1', seq: 2, text: 'buried treasure', streaming: false }],
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
      { kind: 'text', id: 'x', seq: 2, text: 'unrelated', streaming: false },
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
          { kind: 'text', id: 'a', seq: 1, text: 'assistant says hello', streaming: false },
          tool(),
          {
            kind: 'result',
            id: 'r',
            seq: 3,
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
              { kind: 'text', id: 'c1', seq: 2, text: 'nested finding', streaming: false },
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
          { kind: 'thinking', id: 'k', seq: 1, text: 'private reasoning', streaming: false },
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
          { kind: 'text', id: 'a', seq: 1, text: 'alpha', streaming: false },
          { kind: 'text', id: 'b', seq: 2, text: 'beta', streaming: false },
        ]}
      />,
    );
    expect(screen.getByText('2 of 2 blocks')).toBeTruthy();
  });
});
