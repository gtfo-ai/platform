/**
 * Untrusted prose, rendered as **markdown made of React elements** (S-28.9, the M28 ruling).
 *
 * `ui/markdown-parse.ts` reads a string into a tree of plain objects; this module maps the tree to
 * React elements, and React escapes every string it writes into a text node. No step produces
 * markup — no HTML string, no sink — so `no-html.test.ts` holds this module unchanged, and every
 * link goes through `MarkdownLink` (and so through `safeHref`) in `ui/untrusted.tsx`, the one module
 * allowed to write a URL attribute. Text outside a link still goes through `UntrustedText`, so a
 * bare `https://` URL in a paragraph is still a link.
 *
 * The typography is a card's, not a document's: headings are scaled down (a `#` is an `h3` at
 * `text-base`), code is mono on a muted ground, a table scrolls sideways on a narrow screen rather
 * than widening the page, a long word wraps, and a numbered list shows the source's own numbers and
 * delimiter (`1)` stays `1)`) with room between the points, so a plan reads as steps.
 *
 * Two entry points:
 * - {@link UntrustedProse} — a document: what assistant text, artifact bodies, questions, briefs and
 *   knowledge pages render as.
 * - {@link UntrustedInline} — one line inside other text (a list item, a summary): the inline marks
 *   only, never a block element, so it is valid inside a `<p>` or an `<li>`.
 *
 * A one-line preview **inside a control** (the Inbox row's toggle) takes `markdownToPlainText`
 * instead: marks off, words kept, and no link — an anchor inside a button is two controls in one.
 */
import { Fragment, type ReactElement, type ReactNode } from 'react';
import {
  type Alignment,
  type Block,
  type Inline,
  inlineText,
  type ListItem,
  parseInlineMarkdown,
  parseMarkdown,
} from './markdown-parse.js';
import { CodeText, MarkdownLink, type UntrustedProps, UntrustedText } from './untrusted.js';

const INLINE_CODE =
  'rounded bg-surface-muted px-1 py-0.5 font-mono text-[0.85em] break-words [overflow-wrap:anywhere]';

/** `inLink`: inside a link's label, where a nested link or a linkified URL would be an anchor in an anchor. */
const renderInline = (nodes: readonly Inline[], inLink: boolean): ReactNode[] =>
  nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return inLink ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: inline runs are positional and never reordered.
          <Fragment key={index}>{node.value}</Fragment>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: inline runs are positional and never reordered.
          <UntrustedText key={index} value={node.value} />
        );
      case 'strong':
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: inline runs are positional and never reordered.
          <strong key={index} className="font-semibold">
            {renderInline(node.children, inLink)}
          </strong>
        );
      case 'emphasis':
        // biome-ignore lint/suspicious/noArrayIndexKey: inline runs are positional and never reordered.
        return <em key={index}>{renderInline(node.children, inLink)}</em>;
      case 'strikethrough':
        // biome-ignore lint/suspicious/noArrayIndexKey: inline runs are positional and never reordered.
        return <del key={index}>{renderInline(node.children, inLink)}</del>;
      case 'code':
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: inline runs are positional and never reordered.
          <code key={index} className={INLINE_CODE}>
            {node.value}
          </code>
        );
      case 'link':
        return inLink ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: inline runs are positional and never reordered.
          <Fragment key={index}>{node.source}</Fragment>
        ) : (
          <MarkdownLink
            // biome-ignore lint/suspicious/noArrayIndexKey: inline runs are positional and never reordered.
            key={index}
            url={node.url}
            source={node.source}
            labelText={inlineText(node.label)}
          >
            {renderInline(node.label, true)}
          </MarkdownLink>
        );
      case 'image':
        // Never an image: its description, as a link under the same rule as any other.
        return inLink ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: inline runs are positional and never reordered.
          <Fragment key={index}>{node.source}</Fragment>
        ) : (
          <MarkdownLink
            // biome-ignore lint/suspicious/noArrayIndexKey: inline runs are positional and never reordered.
            key={index}
            url={node.url}
            source={node.source}
            labelText=""
          >
            {`Image: ${node.alt.trim() === '' ? 'no description' : node.alt}`}
          </MarkdownLink>
        );
      default:
        return null;
    }
  });

const HEADING_CLASS: Readonly<Record<number, string>> = {
  1: 'text-base font-semibold',
  2: 'text-sm font-semibold',
  3: 'text-sm font-semibold',
};

/** Scaled down for a card: `#` is an `h3`, and nothing is ever an `h1`/`h2` of the page. */
const Heading = ({
  level,
  children,
}: {
  readonly level: number;
  readonly children: ReactNode;
}): ReactElement => {
  const className = `${HEADING_CLASS[level] ?? 'text-xs font-semibold text-fg-muted'} leading-snug`;
  switch (level) {
    case 1:
      return <h3 className={className}>{children}</h3>;
    case 2:
      return <h4 className={className}>{children}</h4>;
    case 3:
      return <h5 className={className}>{children}</h5>;
    default:
      return <h6 className={className}>{children}</h6>;
  }
};

const ALIGN_CLASS: Readonly<Record<NonNullable<Alignment>, string>> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

const alignClass = (align: Alignment | undefined): string =>
  align === null || align === undefined ? 'text-left' : ALIGN_CLASS[align];

const ItemBody = ({ item }: { readonly item: ListItem }): ReactElement => (
  <div className="flex min-w-0 flex-col gap-1">{renderBlocks(item.blocks)}</div>
);

const renderBlock = (block: Block, key: number): ReactElement | null => {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p key={key} className="whitespace-pre-wrap text-sm leading-relaxed">
          {renderInline(block.content, false)}
        </p>
      );
    case 'heading':
      return (
        <Heading key={key} level={block.level}>
          {renderInline(block.content, false)}
        </Heading>
      );
    case 'code':
      return (
        <figure key={key} className="m-0">
          {block.language === null ? null : (
            <figcaption className="pb-1 font-mono text-[11px] text-fg-muted">
              {block.language}
            </figcaption>
          )}
          <CodeText value={block.value} />
        </figure>
      );
    case 'list':
      return block.ordered ? (
        <ol key={key} className="flex flex-col gap-2 text-sm leading-relaxed">
          {block.items.map((item, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional and never reordered.
              key={index}
              value={item.number ?? undefined}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2"
            >
              <span aria-hidden="true" className="font-medium text-fg-muted tabular-nums">
                {`${item.number ?? ''}${item.delimiter ?? '.'}`}
              </span>
              <ItemBody item={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed">
          {block.items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional and never reordered.
            <li key={index}>
              <ItemBody item={item} />
            </li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <blockquote
          key={key}
          className="m-0 flex flex-col gap-2 border-l-2 border-line pl-3 text-fg-muted"
        >
          {renderBlocks(block.blocks)}
        </blockquote>
      );
    case 'rule':
      return <hr key={key} className="border-line" />;
    case 'table':
      return (
        <div key={key} className="max-w-full overflow-x-auto" data-markdown-table="">
          <table className="border-collapse text-sm">
            <thead>
              <tr>
                {block.header.map((cell, column) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: a table's columns are positional.
                    key={column}
                    scope="col"
                    className={`border-b border-line px-2 py-1 font-semibold ${alignClass(block.align[column])}`}
                  >
                    {renderInline(cell, false)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a table's rows are positional.
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: a table's columns are positional.
                      key={column}
                      className={`border-b border-line px-2 py-1 align-top ${alignClass(block.align[column])}`}
                    >
                      {renderInline(cell, false)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
};

const renderBlocks = (blocks: readonly Block[]): (ReactElement | null)[] =>
  blocks.map((block, index) => renderBlock(block, index));

/** A markdown document of untrusted text: blocks, inline marks and links, never markup. */
export const UntrustedProse = ({ value, className }: UntrustedProps): ReactElement => (
  <div className={`flex min-w-0 flex-col gap-2 break-words ${className ?? ''}`} data-markdown="">
    {renderBlocks(parseMarkdown(value))}
  </div>
);

/** One line of untrusted text with inline markdown — marks, code and links, no block element. */
export const UntrustedInline = ({ value, className }: UntrustedProps): ReactElement => (
  <span className={className}>{renderInline(parseInlineMarkdown(value), false)}</span>
);
