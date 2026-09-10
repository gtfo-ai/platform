/**
 * Markdown ⇄ **Atlassian Document Format** for the Jira Cloud provider (technical/06: "Markdown →
 * provider format converter (ADF for Jira Cloud, wiki markup for DC) lives in the provider
 * module"; TD-024: "markdown→ADF via `marklassian`").
 *
 * Both directions are needed and they are not symmetric.
 *
 *  - **Outbound** is `marklassian`, per TD-024. The platform authors the markdown (workpad,
 *    questions, linter output), so the input is ours and the output is a document Jira accepts.
 *  - **Inbound** is the renderer below, and it is ours because there is no library for it. A
 *    ticket description or a comment arrives as ADF and the port hands the application ring
 *    *markdown* (`ticketSchema.description`, `ticketCommentSchema.body`). It is **untrusted text**
 *    either way (BD-022): the renderer never executes, never fetches and never interprets a node —
 *    it only prints, and a node type it has never heard of degrades to its own children rather
 *    than throwing, because a comment the platform cannot render is still a comment a human wrote.
 *
 * ## The marker (BD-023)
 *
 * `upsertWorkpad` finds its comment again by a marker id, and `TicketComment.marker_id` says
 * providers "find it in the comment body". ADF has no comment syntax — `marklassian` drops an HTML
 * comment entirely (verified: `markdownToAdf('a\n\n<!-- x -->')` yields one paragraph) — so the
 * marker is a **visible** trailing paragraph holding `[agentic:marker:<id>]` in a `code` mark.
 * `adfToMarkdown` strips exactly that node again, so a caller reading the comment back gets the
 * markdown it wrote and not the bookkeeping.
 *
 * The alternative, a Jira *comment property*, is invisible and cannot be typed by a human — but
 * `GET /rest/api/3/issue/{key}/comment` documents `expand` as accepting only `renderedBody`
 * (swagger-v3.v3.json, retrieved 2026-09-10), so reading a marker back would cost a second
 * `POST /rest/api/3/comment/list?expand=properties` on every ticket read. The visible marker is
 * the cheaper half of that trade; its cost — a human can *type* a marker — is why
 * `upsertWorkpad` also requires the candidate comment to have been written by the account the
 * adapter authenticates as (see `index.ts`).
 */
import { markdownToAdf } from 'marklassian';
import * as z from 'zod';

// ── The document ─────────────────────────────────────────────────────────────

export interface AdfMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface AdfNode {
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly AdfNode[];
  readonly marks?: readonly AdfMark[];
}

export interface AdfDocument {
  readonly version: 1;
  readonly type: 'doc';
  readonly content: readonly AdfNode[];
}

/**
 * A *lenient* node schema, and deliberately so.
 *
 * Boundary schemas are strict (CLAUDE.md) with one stated exception: "opaque provider payloads".
 * ADF is that exception — Atlassian ships new node types (`bodiedSyncBlock`, `multiBodiedExtension`
 * in the current node list) without a version bump, and a strict schema would turn every new
 * Atlassian feature into a failed ticket read. What is checked is what the renderer walks: a node
 * has a string `type`, and its optional members have the right kinds.
 */
export const adfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    text: z.string().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(adfNodeSchema).optional(),
    marks: z
      .array(
        z.object({ type: z.string().min(1), attrs: z.record(z.string(), z.unknown()).optional() }),
      )
      .optional(),
  }),
);

export const adfDocumentSchema: z.ZodType<AdfDocument> = z.object({
  version: z.literal(1),
  type: z.literal('doc'),
  content: z.array(adfNodeSchema).default([]),
});

// ── Marker ───────────────────────────────────────────────────────────────────

export const MARKER_PREFIX = 'agentic:marker:';

/** `[agentic:marker:agentic:workpad]` — the id may itself contain colons, so the match is greedy. */
const MARKER_PATTERN = new RegExp(`^\\[${MARKER_PREFIX}(.+)\\]$`);

export const markerFooterText = (markerId: string): string => `[${MARKER_PREFIX}${markerId}]`;

/** What a quoted marker is rewritten to, so that a human reading the comment can see what happened. */
export const QUOTED_MARKER_PREFIX = 'quoted:';

const ESCAPED_MARKER_PREFIX = MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Every `[agentic:marker:` a caller wrote, whatever its case. */
const QUOTABLE_MARKER = new RegExp(`\\[(?=${ESCAPED_MARKER_PREFIX})`, 'gi');

/**
 * Defuses any marker the **caller's** markdown carries, before the platform appends its own.
 *
 * BD-022: agent-authored markdown is derived from ticket text an attacker can write, so "the bot
 * posted it" is not "the platform wrote it". WP-08 review round 1 posted a comment ending in
 * `` `[agentic:marker:agentic:workpad]` `` through `addComment` — bot-authored, so the author
 * check passed — and the next `upsertWorkpad` adopted and overwrote it. Rewriting the bracket to
 * `[quoted:agentic:marker:…]` leaves the text readable and makes it no longer a marker.
 *
 * The match is case-**in**sensitive while `adfMarkerId` is case-sensitive: neutralising more than
 * the reader recognises is the safe direction (standing rule 15).
 */
export const neutraliseQuotedMarkers = (markdown: string): string =>
  markdown.replace(QUOTABLE_MARKER, `[${QUOTED_MARKER_PREFIX}`);

/**
 * The node the platform appends to carry a marker id.
 *
 * It is built here rather than written as markdown and converted, because markdown is a *structure*
 * and an appended line joins whatever structure precedes it. WP-08 review round 2:
 * `` "a\n\n```js\nconst x = 1;" `` — an unclosed fence, which a model produces by accident
 * regularly and which BD-022 makes attacker-influenced — runs to the end of the document under
 * CommonMark, so the appended footer landed *inside the code block* (verified against
 * marklassian 1.2.1) and the conversion threw. Appending the node after conversion puts the marker
 * somewhere markdown syntax cannot reach.
 */
const markerNode = (markerId: string): AdfNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text: markerFooterText(markerId), marks: [{ type: 'code' }] }],
});

/** The marker node, if this node is one: a paragraph whose only child is the marked text. */
const markerOfNode = (node: AdfNode): string | null => {
  if (node.type !== 'paragraph' || node.content?.length !== 1) {
    return null;
  }
  const [child] = node.content;
  if (child === undefined || child.type !== 'text' || typeof child.text !== 'string') {
    return null;
  }
  if (!(child.marks ?? []).some((mark) => mark.type === 'code')) {
    return null;
  }
  return MARKER_PATTERN.exec(child.text)?.[1] ?? null;
};

/**
 * The marker id carried by a document, or `null`.
 *
 * Only the **last** node is considered: a marker anywhere else is text a human wrote, and reading
 * it as bookkeeping is how a quoted marker in a discussion would hijack the workpad.
 */
export const adfMarkerId = (value: unknown): string | null => {
  const document = adfDocumentSchema.safeParse(value);
  if (!document.success) {
    return null;
  }
  const last = document.data.content.at(-1);
  return last === undefined ? null : markerOfNode(last);
};

// ── Markdown → ADF ───────────────────────────────────────────────────────────

export class AdfConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdfConversionError';
  }
}

/**
 * Refuses a converted document whose **own last node** is already a marker.
 *
 * *Deliberately unreachable from {@link markdownToAdfDocument}, and this is the seam that lets a
 * test say so.* The outer layer of the guard is {@link neutraliseQuotedMarkers}, which rewrites
 * every `[agentic:marker:` in the caller's markdown before conversion and is complete: eleven
 * routes were tried at WP-08 review round 2 (HTML entities, split code spans, raw HTML, backslash
 * escapes, ZWSP, NFD, trailing whitespace, a doubled marker) and none produced a marker node. An
 * inner layer that no input can reach is not evidence that it holds (standing rule 3), so it lives
 * in its own exported function and `adf.test.ts` drives it with a document `markdownToAdf` cannot
 * produce.
 *
 * Why keep it at all: `neutraliseQuotedMarkers` works on markdown text, `markerOfNode` reads a
 * converted node, and the two only agree as long as marklassian keeps mapping one to the other. A
 * comment that ends in a marker nobody asked for is a comment claiming to be the workpad
 * (BD-022/BD-023), and the platform must not post one.
 *
 * @throws {AdfConversionError} — a constant string. The refused marker id is caller-derived text
 * and this throws *outside* the action executor, so nothing of it is interpolated (docs/TODO.md).
 */
export const assertNoCallerMarker = (document: AdfDocument): void => {
  if (adfMarkerId(document) !== null) {
    throw new AdfConversionError(
      'refusing to post a comment whose own text ends in a platform marker',
    );
  }
};

/**
 * Converts platform-authored markdown into an ADF document, appending the marker when there is one.
 *
 * The marker is appended as a **node** (see {@link markerNode}), never as a line of markdown: the
 * caller's markdown is converted alone, so no markdown structure it opens — an unclosed code fence
 * above all — can capture the platform's bookkeeping.
 *
 * @throws {AdfConversionError} when the markdown renders to nothing, which covers both blank input
 * and input that is all comment (`<!-- x -->` converts to zero nodes).
 * `{version:1,type:'doc',content:[]}` is a legal ADF document
 * (developer.atlassian.com/cloud/jira/platform/apis/document/structure/, retrieved 2026-09-10) but
 * an empty comment is a caller's bug, and posting one loses the evidence of which call was wrong.
 * @throws {AdfConversionError} when the caller's own markdown ends in a marker node — see
 * {@link assertNoCallerMarker}.
 */
export const markdownToAdfDocument = (
  markdown: string,
  options: { readonly markerId?: string | null } = {},
): AdfDocument => {
  const converted = markdownToAdf(neutraliseQuotedMarkers(markdown.trim()));
  const document = adfDocumentSchema.parse(converted);
  if (document.content.length === 0) {
    throw new AdfConversionError('refusing to render an empty markdown document to ADF');
  }
  assertNoCallerMarker(document);
  const markerId = options.markerId ?? null;
  return markerId === null
    ? document
    : { ...document, content: [...document.content, markerNode(markerId)] };
};

// ── ADF → markdown ───────────────────────────────────────────────────────────

const MARK_WRAPPERS: Readonly<Record<string, string>> = {
  strong: '**',
  em: '*',
  code: '`',
  strike: '~~',
};

const renderText = (node: AdfNode): string => {
  let text = node.text ?? '';
  let href: string | null = null;
  for (const mark of node.marks ?? []) {
    const wrapper = MARK_WRAPPERS[mark.type];
    if (wrapper !== undefined) {
      text = `${wrapper}${text}${wrapper}`;
      continue;
    }
    if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
      href = mark.attrs.href;
    }
  }
  return href === null ? text : `[${text}](${href})`;
};

const attrString = (node: AdfNode, name: string): string | null => {
  const value = node.attrs?.[name];
  return typeof value === 'string' ? value : null;
};

/** Inline content of one block, concatenated in document order (ADF is an ordered document). */
const renderInline = (nodes: readonly AdfNode[]): string =>
  nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return renderText(node);
        case 'hardBreak':
          return '\n';
        case 'mention':
          return `@${attrString(node, 'text')?.replace(/^@/, '') ?? attrString(node, 'id') ?? 'unknown'}`;
        case 'emoji':
          return attrString(node, 'text') ?? attrString(node, 'shortName') ?? '';
        case 'inlineCard':
          return attrString(node, 'url') ?? '';
        case 'date':
          return attrString(node, 'timestamp') ?? '';
        case 'status':
          return attrString(node, 'text') ?? '';
        case 'mediaInline':
          return `[media:${attrString(node, 'id') ?? 'unknown'}]`;
        default:
          // Unknown inline node: print what it contains rather than dropping a human's words.
          return renderInline(node.content ?? []);
      }
    })
    .join('');

const listItemLines = (item: AdfNode, bullet: string, indent: string): string => {
  const rendered = renderBlocks(item.content ?? [], `${indent}  `).trimEnd();
  const [first = '', ...rest] = rendered.split('\n');
  const head = `${indent}${bullet} ${first.trimStart()}`;
  return [head, ...rest].join('\n');
};

const renderTableRow = (row: AdfNode): string =>
  `| ${(row.content ?? [])
    .map((cell) =>
      renderBlocks(cell.content ?? [], '')
        .trim()
        .replace(/\n+/g, ' '),
    )
    .join(' | ')} |`;

const renderTable = (node: AdfNode): string => {
  const rows = node.content ?? [];
  const [header, ...body] = rows;
  if (header === undefined) {
    return '';
  }
  const columns = (header.content ?? []).length;
  const separator = `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`;
  return [renderTableRow(header), separator, ...body.map(renderTableRow)].join('\n');
};

const renderBlock = (node: AdfNode, indent: string): string => {
  switch (node.type) {
    case 'paragraph':
      return `${indent}${renderInline(node.content ?? [])}`;
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${renderInline(node.content ?? [])}`;
    }
    case 'bulletList':
      return (node.content ?? []).map((item) => listItemLines(item, '-', indent)).join('\n');
    case 'orderedList':
      return (node.content ?? [])
        .map((item, index) => listItemLines(item, `${index + 1}.`, indent))
        .join('\n');
    case 'codeBlock': {
      const language = attrString(node, 'language') ?? '';
      const code = (node.content ?? []).map((child) => child.text ?? '').join('');
      return `${'```'}${language}\n${code}\n${'```'}`;
    }
    case 'blockquote':
    case 'panel':
      return renderBlocks(node.content ?? [], '')
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n');
    case 'rule':
      return '---';
    case 'table':
      return renderTable(node);
    case 'taskList':
    case 'decisionList':
      return (node.content ?? [])
        .map((item) => {
          const done = item.attrs?.state === 'DONE';
          return `${indent}- [${done ? 'x' : ' '}] ${renderInline(item.content ?? [])}`;
        })
        .join('\n');
    case 'mediaSingle':
    case 'mediaGroup':
      return (node.content ?? [])
        .map((child) => `[media:${attrString(child, 'id') ?? 'unknown'}]`)
        .join('\n');
    case 'expand':
    case 'nestedExpand': {
      const title = attrString(node, 'title');
      const body = renderBlocks(node.content ?? [], indent);
      return title === null ? body : `**${title}**\n\n${body}`;
    }
    default:
      // Same rule as the inline fallback: an unknown block prints its children.
      return node.content === undefined ? renderInline([node]) : renderBlocks(node.content, indent);
  }
};

const renderBlocks = (nodes: readonly AdfNode[], indent: string): string =>
  nodes
    .map((node) => renderBlock(node, indent))
    .filter((block) => block.length > 0)
    .join('\n\n');

/**
 * Renders an ADF document as markdown, dropping the platform's own marker footer.
 *
 * Never throws: a value that is not an ADF document at all renders as the empty string, because
 * this runs on every comment of every ticket and a single malformed body must not fail the read.
 * The *shape* is still validated at the port boundary — `readTicket` parses the whole issue with
 * `parseProviderData` — so "not a document" here means "a document with a node we do not model".
 */
export const adfToMarkdown = (value: unknown): string => {
  const document = adfDocumentSchema.safeParse(value);
  if (!document.success) {
    return '';
  }
  const content = [...document.data.content];
  const last = content.at(-1);
  if (last !== undefined && markerOfNode(last) !== null) {
    content.pop();
  }
  return renderBlocks(content, '');
};
