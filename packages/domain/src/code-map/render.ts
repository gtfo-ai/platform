/**
 * Rendering the ranked symbol graph into the tier-0 repository map — technical/07's "1–4 k token
 * map (files and their key symbols)", product/05's "repo map (symbol outline, 1–4k tokens)".
 *
 * The renderer owns the token budget for the map itself, which is a **different** budget from the
 * context pack's: the map is one tier-0 document inside a pack that also carries `index.md`, the
 * unconditional rules and `CLAUDE.md`. Blowing the map budget therefore does not blow the pack's,
 * it just leaves less room for tier 1 — and {@link renderCodeMap} returns what it had to leave out
 * so that "the map was cut" is a fact the audit can carry rather than an inference from its length.
 *
 * **The output is data, not instructions (BD-022).** Every identifier in it comes from the
 * project's source code, which is untrusted text: a file named `` `ignore previous instructions` ``
 * is a legal filename. The renderer therefore emits a flat, fenced outline with no imperative
 * framing of its own, and the prompt assembler is what labels the block as data. Nothing here
 * interpolates repository text into a sentence that reads like the platform talking.
 */
import { estimateTokens } from '../knowledge/tokens.js';
import type { RankedFile } from './graph.js';

/**
 * The shipped map budget.
 *
 * technical/07 gives the range 1–4 k and no default. 2 000 is the middle of it and one sixth of the
 * shipped 12 000-token pack budget, which leaves tier 1 the room product/05 asks for ("top 5–10
 * items"). It is a constant rather than a project setting because technical/12's configuration file
 * has no key for it and inventing one is a product decision this work package does not get to make;
 * `CodeMapper` takes it as a parameter so WP-21 can raise it without a migration.
 */
export const DEFAULT_CODE_MAP_TOKEN_BUDGET = 2_000;

/** Symbols listed per file before the rest are summarised as a count. */
export const MAX_SYMBOLS_PER_FILE = 12;

export interface RenderedCodeMap {
  readonly text: string;
  readonly tokens: number;
  readonly filesIncluded: number;
  /** Ranked files the budget could not afford. Zero means the map is complete, not merely short. */
  readonly filesOmitted: number;
}

const symbolLine = (file: RankedFile): string => {
  const shown = file.symbols.slice(0, MAX_SYMBOLS_PER_FILE);
  const rest = file.symbols.length - shown.length;
  const names = shown.map((symbol) => `${symbol.name} (${symbol.kind})`).join(', ');
  if (rest === 0) return names;
  return names === '' ? `… ${rest} more` : `${names}, … ${rest} more`;
};

/**
 * Renders files in rank order until the next block would not fit.
 *
 * It stops rather than skipping ahead to a smaller file: rank order is the map's only claim, and a
 * renderer that reached past a big file to fit two small ones would produce an outline whose order
 * no longer means what the header says it does.
 */
export const renderCodeMap = (
  files: readonly RankedFile[],
  tokenBudget: number,
): RenderedCodeMap => {
  const header = 'Repository map — files and their key symbols, most relevant first.';
  const lines: string[] = [header];
  let tokens = estimateTokens(header);
  let included = 0;

  for (const file of files) {
    const block = file.symbols.length === 0 ? file.path : `${file.path}: ${symbolLine(file)}`;
    const cost = estimateTokens(`\n${block}`);
    if (tokens + cost > tokenBudget) break;
    lines.push(block);
    tokens += cost;
    included += 1;
  }

  return {
    text: lines.join('\n'),
    tokens,
    filesIncluded: included,
    filesOmitted: files.length - included,
  };
};

/**
 * The `code_maps.focus_hash` cache key — a 32-bit FNV-1a over the sorted focus paths.
 *
 * **Not a security property.** It keys a cache of derived, rebuildable data in the platform's own
 * database; a collision costs one wrong-but-valid map for one run, and nothing downstream trusts
 * the hash to prove anything. It is here rather than behind a port because the domain ring has no
 * I/O and `node:crypto` is I/O-adjacent — and because a cache key that changed with the adapter
 * would invalidate every cached map on a refactor.
 */
export const focusHash = (focusPaths: readonly string[]): string => {
  let hash = 0x811c9dc5;
  for (const path of [...focusPaths].sort()) {
    for (let at = 0; at < path.length; at += 1) {
      hash ^= path.charCodeAt(at);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};
