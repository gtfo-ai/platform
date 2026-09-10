/**
 * The tool renderer registry (technical/09 § "Transcript model").
 *
 * `Edit/Write/MultiEdit` → diff, `Bash` → terminal block, `Read/Grep/Glob` → code with line
 * numbers, `Task` (the SDK's sub-agent tool) → nested transcript, `WebFetch/WebSearch` → link card,
 * `mcp__*` → JSON viewer, `AskUserQuestion` / the platform's `ask_human` → question card,
 * everything else → generic card.
 *
 * `toolRendererKind` is a pure function so the *routing* can be asserted without rendering — the
 * part that drifts when the SDK renames a tool is the mapping, not the markup.
 *
 * **Every string in here is untrusted** (BD-022): the tool name comes from the model, the input is
 * whatever it invented, and the result is the output of a program running in the agent's
 * workspace. Nothing is rendered as HTML — see `ui/untrusted-text.ts`. The diff renderer shows the
 * `old_string`/`new_string` of the SDK's `Edit` input as two labelled code blocks rather than as a
 * computed diff; `@pierre/diffs` behind a lazy `<Diff>` component is TD-013's answer and is
 * recorded as follow-up.
 */
import type { ReactElement, ReactNode } from 'react';
import { Badge, cx } from '../ui/kit.js';
import { CodeText, JsonView, NumberedCode, TerminalText, UntrustedText } from '../ui/untrusted.js';
import type { ToolBlock } from './blocks.js';

export type ToolRendererKind =
  | 'diff'
  | 'terminal'
  | 'file'
  | 'agent'
  | 'link'
  | 'json'
  | 'question'
  | 'generic';

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TERMINAL_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell']);
const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const LINK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ask_human']);

export const toolRendererKind = (toolName: string): ToolRendererKind => {
  if (DIFF_TOOLS.has(toolName)) {
    return 'diff';
  }
  if (TERMINAL_TOOLS.has(toolName)) {
    return 'terminal';
  }
  if (FILE_TOOLS.has(toolName)) {
    return 'file';
  }
  if (AGENT_TOOLS.has(toolName)) {
    return 'agent';
  }
  if (LINK_TOOLS.has(toolName)) {
    return 'link';
  }
  if (QUESTION_TOOLS.has(toolName)) {
    return 'question';
  }
  // The platform's own MCP tools and every server an operator adds (technical/04).
  if (toolName.startsWith('mcp__')) {
    return 'json';
  }
  return 'generic';
};

/** Reads a string field off a tool input, which the model composed and nothing validated. */
const text = (input: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = input[key];
  return typeof value === 'string' ? value : null;
};

const Labelled = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement => (
  <div className="flex flex-col gap-1">
    <span className="font-mono text-[11px] text-fg-muted">{label}</span>
    {children}
  </div>
);

const DiffBody = ({ block }: { readonly block: ToolBlock }): ReactElement => {
  const path = text(block.input, 'file_path') ?? text(block.input, 'notebook_path');
  const oldString = text(block.input, 'old_string');
  const newString = text(block.input, 'new_string') ?? text(block.input, 'content');
  return (
    <div className="flex flex-col gap-2">
      {path === null ? null : (
        <p className="font-mono text-xs">
          <UntrustedText value={path} />
        </p>
      )}
      {oldString === null ? null : (
        <Labelled label="removed">
          <CodeText value={oldString} className="border-l-2 border-danger" />
        </Labelled>
      )}
      {newString === null ? (
        <JsonView value={block.input} />
      ) : (
        <Labelled label="added">
          <CodeText value={newString} className="border-l-2 border-success" />
        </Labelled>
      )}
    </div>
  );
};

const TerminalBody = ({ block }: { readonly block: ToolBlock }): ReactElement => (
  <div className="flex flex-col gap-2">
    <Labelled label="command">
      <CodeText value={text(block.input, 'command') ?? JSON.stringify(block.input)} />
    </Labelled>
    {block.result === null ? null : (
      <Labelled label={block.result.isError ? 'stderr' : 'stdout'}>
        <TerminalText value={block.result.content} />
      </Labelled>
    )}
  </div>
);

const FileBody = ({ block }: { readonly block: ToolBlock }): ReactElement => (
  <div className="flex flex-col gap-2">
    <p className="font-mono text-xs">
      <UntrustedText
        value={
          text(block.input, 'file_path') ??
          text(block.input, 'pattern') ??
          text(block.input, 'path') ??
          '(no path)'
        }
      />
    </p>
    {block.result === null ? null : <NumberedCode value={block.result.content} />}
  </div>
);

const LinkBody = ({ block }: { readonly block: ToolBlock }): ReactElement => (
  <div className="flex flex-col gap-2">
    <p className="text-sm">
      <UntrustedText value={text(block.input, 'url') ?? text(block.input, 'query') ?? ''} />
    </p>
    {block.result === null ? null : <CodeText value={block.result.content} />}
  </div>
);

const QuestionBody = ({ block }: { readonly block: ToolBlock }): ReactElement => (
  <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
    <p className="text-sm">
      <UntrustedText value={text(block.input, 'question') ?? text(block.input, 'prompt') ?? ''} />
    </p>
    <JsonView value={block.input} />
    {block.result === null ? null : <CodeText value={block.result.content} />}
  </div>
);

const GenericBody = ({ block }: { readonly block: ToolBlock }): ReactElement => (
  <div className="flex flex-col gap-2">
    <Labelled label="input">
      <JsonView value={block.input} />
    </Labelled>
    {block.result === null ? null : (
      <Labelled label={block.result.isError ? 'error' : 'output'}>
        <CodeText value={block.result.content} />
      </Labelled>
    )}
  </div>
);

export interface ToolBodyProps {
  readonly block: ToolBlock;
  /** Rendered for the `agent` kind; the parent supplies it to avoid a cycle between modules. */
  readonly renderChildren: (block: ToolBlock) => ReactNode;
}

export const ToolBody = ({ block, renderChildren }: ToolBodyProps): ReactElement => {
  switch (toolRendererKind(block.toolName)) {
    case 'diff':
      return <DiffBody block={block} />;
    case 'terminal':
      return <TerminalBody block={block} />;
    case 'file':
      return <FileBody block={block} />;
    case 'link':
      return <LinkBody block={block} />;
    case 'question':
      return <QuestionBody block={block} />;
    case 'json':
      return <GenericBody block={block} />;
    case 'agent':
      return (
        <div className="flex flex-col gap-2">
          <Labelled label="prompt">
            <CodeText value={text(block.input, 'prompt') ?? JSON.stringify(block.input)} />
          </Labelled>
          <section
            data-testid="nested-transcript"
            className="border-l-2 border-line pl-3"
            aria-label="sub-agent transcript"
          >
            {renderChildren(block)}
          </section>
          {block.result === null ? null : <CodeText value={block.result.content} />}
        </div>
      );
    case 'generic':
      return <GenericBody block={block} />;
  }
};

export const ToolHeader = ({ block }: { readonly block: ToolBlock }): ReactElement => (
  <div className="flex items-center gap-2">
    <span
      className={cx(
        'font-mono text-xs font-semibold',
        block.result?.isError === true && 'text-danger',
      )}
    >
      {/* The tool name comes from the model: text node, never an attribute or a class. */}
      <UntrustedText value={block.toolName} />
    </span>
    <Badge tone={block.result === null ? 'accent' : block.result.isError ? 'danger' : 'success'}>
      {block.result === null ? 'running' : block.result.isError ? 'error' : 'done'}
    </Badge>
    <span className="ml-auto font-mono text-[11px] text-fg-muted">#{block.seq}</span>
  </div>
);
