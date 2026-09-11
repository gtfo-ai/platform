/**
 * Parsing one vault document into the rows technical/03 stores — `kb_documents`, `kb_chunks`,
 * `kb_links` — and nothing else. No I/O: the caller hands in the bytes and the blob sha.
 *
 * technical/07 § "Source of truth and sync" is the whole specification:
 *
 * > parse frontmatter (schema in product/05) → split into chunks by heading (each chunk prefixed
 * > with `project / path / H1 > H2`) → upsert `kb_documents`, `kb_chunks`, `kb_links`
 *
 * Three things it adds, each because the naive reading breaks somewhere real.
 *
 * **Chunks are bounded, and the bound is the database's.** `kb_chunks.search` is a *generated*
 * `tsvector` column, and PostgreSQL refuses a tsvector over 1 MB — so an unbounded chunk is not a
 * large row, it is a failed `INSERT` that takes the whole document (and, without care, the whole
 * index run) with it. An over-long section is therefore **split** at a line boundary into several
 * chunks rather than truncated, so nothing is lost, and a document that would exceed
 * {@link MAX_CHUNKS_PER_DOCUMENT} is reported `truncated` rather than quietly shortened.
 *
 * **Fenced code is not headings.** A `# comment` on the first line of a shell block inside a
 * "known pitfalls" page is not an H1, and treating it as one splits a document at nonsense
 * boundaries. The scanner tracks fences.
 *
 * **A known key with a wrong value fails the document.** `kbFrontmatterSchema` is loose about keys
 * the platform does not own (see its docblock) and strict about the ones it does, so
 * `status: activ` is an `invalid` parse and not a document that silently stops being deprecated.
 */
import {
  type JsonObject,
  type JsonValue,
  type KbFrontmatter,
  kbFrontmatterSchema,
} from '@platform/contracts';
import { type FrontmatterValue, readFrontmatter } from './frontmatter.js';
import { estimateTokens } from './tokens.js';

/**
 * Where a document sits in product/05's layer table. Derived from the path, because that is what
 * product/05 uses as the owner boundary (`business/`, `technical/`, `decisions/`, `lessons/`) and
 * what technical/07 boosts by for a stage.
 */
export const KB_LAYERS = [
  'business',
  'technical',
  'decisions',
  'lessons',
  'tasks',
  'rules',
  'root',
  'other',
] as const;

export type KbLayer = (typeof KB_LAYERS)[number];

export interface KbChunk {
  readonly ordinal: number;
  /** `H1 > H2`, empty for the text before the first heading. Stored in `kb_chunks.heading_path`. */
  readonly headingPath: string;
  /** The section body **prefixed** with `project / path / H1 > H2` (technical/07). */
  readonly text: string;
  readonly tokens: number;
}

export interface KbLinkRef {
  readonly toPath: string;
  readonly kind: 'wikilink' | 'markdown';
}

export interface ParsedKbDocument {
  readonly path: string;
  readonly layer: KbLayer;
  /** The known vocabulary, validated. */
  readonly frontmatter: KbFrontmatter;
  /** Every frontmatter key including the ones the platform does not own; `kb_documents.frontmatter`. */
  readonly rawFrontmatter: JsonObject;
  readonly chunks: readonly KbChunk[];
  readonly links: readonly KbLinkRef[];
  /** Sum over the chunks, so `kb_documents.tokens` and `sum(kb_chunks.tokens)` cannot disagree. */
  readonly tokens: number;
  /** True when {@link MAX_CHUNKS_PER_DOCUMENT} cut the document short. */
  readonly truncated: boolean;
}

export type KbDocumentParse =
  | { readonly status: 'ok'; readonly document: ParsedKbDocument }
  | { readonly status: 'invalid'; readonly reason: string; readonly line: number | null };

/**
 * Maximum UTF-8 bytes in one chunk's `text`.
 *
 * PostgreSQL's hard tsvector limit is 1 048 575 bytes and this is two orders of magnitude below it,
 * because the limit is not the design target: a chunk is a retrieval unit, and a 1 MB "section"
 * retrieved into a 12 000-token pack would consume the whole budget on one page. 32 KiB is roughly
 * 8 000 estimated tokens — still more than half a default pack, which is the point at which a
 * curator should be told the page is too big rather than the platform quietly coping.
 */
export const MAX_CHUNK_BYTES = 32_768;

/** Chunks kept per document; beyond this the document is marked `truncated`. */
export const MAX_CHUNKS_PER_DOCUMENT = 500;

const encoder = new TextEncoder();
const utf8Length = (text: string): number => encoder.encode(text).length;

const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const WIKILINK = /\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g;
const MARKDOWN_LINK = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** `.agentic/rules/**`, `CLAUDE.md` and `AGENTS.md` are indexed too (technical/07). */
export const kbLayerOf = (relativePath: string): KbLayer => {
  const segments = relativePath.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return 'other';
  if (segments.length === 1) return 'root';
  const first = segments[0] as string;
  const known = KB_LAYERS.find((layer) => layer === first);
  return known === undefined || known === 'root' || known === 'other' ? 'other' : known;
};

/**
 * Split a section body into pieces no larger than {@link MAX_CHUNK_BYTES}, preferring line
 * boundaries. A single line longer than the cap is split by code unit — there is nowhere better to
 * cut, and losing the line is not an option.
 */
const splitOversized = (text: string): readonly string[] => {
  if (utf8Length(text) <= MAX_CHUNK_BYTES) return [text];
  const pieces: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current === '' ? line : `${current}\n${line}`;
    if (utf8Length(candidate) <= MAX_CHUNK_BYTES) {
      current = candidate;
      continue;
    }
    if (current !== '') {
      pieces.push(current);
      current = '';
    }
    if (utf8Length(line) <= MAX_CHUNK_BYTES) {
      current = line;
      continue;
    }
    // A single line over the cap: cut it by code unit. `MAX_CHUNK_BYTES / 4` is the worst case for
    // UTF-8, so every slice is guaranteed under the cap whatever the script.
    const stride = Math.floor(MAX_CHUNK_BYTES / 4);
    for (let at = 0; at < line.length; at += stride) pieces.push(line.slice(at, at + stride));
  }
  if (current !== '') pieces.push(current);
  return pieces;
};

interface Section {
  readonly headingPath: string;
  readonly body: string;
}

const sectionsOf = (body: string): readonly Section[] => {
  const sections: Section[] = [];
  const stack: string[] = [];
  let headingPath = '';
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text !== '' || headingPath !== '') sections.push({ headingPath, body: text });
    buffer = [];
  };

  for (const line of body.split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] as string;
      fence = fence === null ? marker : fence === marker ? null : fence;
      buffer.push(line);
      continue;
    }
    if (fence !== null) {
      buffer.push(line);
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (heading === null) {
      buffer.push(line);
      continue;
    }
    flush();
    const depth = (heading[1] as string).length;
    stack.length = Math.min(stack.length, depth - 1);
    stack[depth - 1] = heading[2] as string;
    for (let level = 0; level < depth; level += 1) stack[level] ??= '';
    headingPath = stack
      .slice(0, depth)
      .filter((title) => title !== '')
      .join(' > ');
  }
  flush();
  return sections;
};

const linksOf = (body: string): readonly KbLinkRef[] => {
  const links: KbLinkRef[] = [];
  const seen = new Set<string>();
  const add = (target: string, kind: KbLinkRef['kind']): void => {
    const trimmed = target.trim();
    if (trimmed === '') return;
    const key = `${kind}:${trimmed}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ toPath: trimmed, kind });
  };
  for (const match of body.matchAll(WIKILINK)) add(match[1] as string, 'wikilink');
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const target = match[1] as string;
    // Only intra-vault Markdown links are graph edges. An `https://` reference is evidence, not a
    // link between documents, and product/05's link graph is explicitly about the vault.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    add(target, 'markdown');
  }
  return links;
};

/** Frontmatter values are JSON already — the restricted grammar produces nothing else. */
const toJson = (value: FrontmatterValue): JsonValue =>
  Array.isArray(value) ? [...value] : (value as JsonValue);

export interface ParseKbDocumentInput {
  /** Repository-relative, e.g. `.agentic/knowledge/lessons/L-2026-08-28-redis.md`. */
  readonly path: string;
  /** Path relative to the vault root, used for the layer and the chunk prefix. */
  readonly vaultRelativePath: string;
  readonly source: string;
  /** Prefixed onto every chunk so a retrieved fragment says which project it came from. */
  readonly projectKey: string;
}

export const parseKbDocument = (input: ParseKbDocumentInput): KbDocumentParse => {
  const block = readFrontmatter(input.source);
  if (block.kind === 'malformed') {
    return { status: 'invalid', reason: `frontmatter: ${block.reason}`, line: block.line };
  }

  const rawFields = block.kind === 'present' ? block.fields : {};
  const parsed = kbFrontmatterSchema.safeParse(rawFields);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? 'frontmatter' : `frontmatter "${issue.path.join('.')}"`;
    return {
      status: 'invalid',
      reason: `${where}: ${issue?.message ?? 'does not match the knowledge vocabulary'}`,
      line: null,
    };
  }

  const rawFrontmatter: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(rawFields)) rawFrontmatter[key] = toJson(value);

  const sections = sectionsOf(block.body);
  const chunks: KbChunk[] = [];
  let truncated = false;

  /**
   * `title` and `trigger` are searchable text, and they live in the frontmatter the body does not
   * contain.
   *
   * Without this they are in no chunk at all, and the trigger half of technical/07 step 2 — its
   * "Trigger/full-text match" — cannot fire: `trigger` is product/05's whole mechanism for matching
   * a lesson against a task description ("the description used for matching", following Devin's
   * trigger descriptions), and a `tsvector` built only from the body would never see it. They are prepended to the first
   * chunk rather than given a chunk of their own so that a document's best-ranking section is a
   * section of the document and not its metadata.
   */
  const searchableFrontmatter = [parsed.data.title, parsed.data.trigger]
    .filter((value): value is string => value !== undefined)
    .join('\n');

  const withMetadata = (body: string, index: number): string =>
    index === 0 && searchableFrontmatter !== ''
      ? body === ''
        ? searchableFrontmatter
        : `${searchableFrontmatter}\n\n${body}`
      : body;

  for (const section of sections) {
    for (const piece of splitOversized(section.body)) {
      if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) {
        truncated = true;
        break;
      }
      const prefix =
        section.headingPath === ''
          ? `${input.projectKey} / ${input.vaultRelativePath}`
          : `${input.projectKey} / ${input.vaultRelativePath} / ${section.headingPath}`;
      const body = withMetadata(piece, chunks.length);
      const text = body === '' ? prefix : `${prefix}\n\n${body}`;
      chunks.push({
        ordinal: chunks.length,
        headingPath: section.headingPath,
        text,
        tokens: estimateTokens(text),
      });
    }
    if (truncated) break;
  }

  if (chunks.length === 0 && searchableFrontmatter !== '') {
    // A document that is nothing but frontmatter still has searchable text, and a document with no
    // chunks is a document `kb_search` and the pack can never reach.
    const prefix = `${input.projectKey} / ${input.vaultRelativePath}`;
    const text = `${prefix}\n\n${searchableFrontmatter}`;
    chunks.push({ ordinal: 0, headingPath: '', text, tokens: estimateTokens(text) });
  }

  return {
    status: 'ok',
    document: {
      path: input.path,
      layer: kbLayerOf(input.vaultRelativePath),
      frontmatter: parsed.data,
      rawFrontmatter,
      chunks,
      links: linksOf(block.body),
      tokens: chunks.reduce((total, chunk) => total + chunk.tokens, 0),
      truncated,
    },
  };
};
