/**
 * The reader half of the data-block contract: *what a party that was handed the prompt and nothing
 * else can work out from it.*
 *
 * It exists so that "the hostile document is inside the delimiter" is a statement about the
 * **assembled prompt** rather than about the assembler's intentions (the acceptance criterion of
 * WP-17 says exactly that), and so that every tier — domain, application, e2e — reads a prompt the
 * same way instead of each growing its own regex.
 *
 * ## Deliberately sloppier than the writer (standing rule 65)
 *
 * An oracle that audits a writer must **over**-approximate it, or the two agree precisely when both
 * are wrong. Three ways this one is looser than `data-block.ts`:
 *
 *  - it is **not told** the nonce — it derives it from the first opening marker, which is what a
 *    reader of the prompt has to do;
 *  - it accepts a nonce of **8 or more** hex characters where the writer emits exactly 32, so a
 *    writer that shortened the nonce is still read (and the shortening is then visible as a
 *    measurement rather than as a parse failure);
 *  - it ignores attribute *syntax* entirely for the purpose of finding blocks: anything from
 *    `<untrusted-data-<nonce>` to the next `>` is the marker.
 *
 * It also reports what it is **not** asked about: every marker-shaped substring whose nonce is not
 * this prompt's ({@link PromptReading.spoofedMarkers}) and every opening that never closed
 * ({@link PromptReading.unterminated}). A negative test that cannot see the attack it claims to
 * survive proves nothing (standing rule 43), so a fixture that plants a fake marker can assert the
 * fake was *present* as well as ineffective.
 *
 * **The assumption it cannot shed**, stated here rather than left for the next reader to find: it
 * reads the marker on one line, as a literal substring. A writer that wrapped a marker across lines
 * or emitted it in a different case would be invisible to this reader *and* to the rule layer 1
 * states, which is the same shape rule 65 records for the citation guard. The mitigation is that
 * the marker is produced by one function whose output is pinned by `data-block.test.ts`.
 */
import { DATA_BLOCK_TAG } from './data-block.js';

export interface ReadDataBlock {
  readonly kind: string;
  readonly attributes: Readonly<Record<string, string>>;
  /** Byte-identical to what the writer was given. */
  readonly body: string;
}

export interface PromptReading {
  /** The nonce this prompt's blocks use, or null when it carries no block at all. */
  readonly nonce: string | null;
  readonly blocks: readonly ReadDataBlock[];
  /**
   * Everything that is *not* inside a block — the platform's own voice, in order.
   *
   * The property the tests assert over this: swapping a benign document for a hostile one must
   * leave it **byte-identical**. That is the operational meaning of "untrusted text cannot open the
   * platform's own voice".
   */
  readonly platformVoice: readonly string[];
  /** Marker-shaped substrings carrying some other nonce — an attempted spoof, ineffective. */
  readonly spoofedMarkers: readonly string[];
  /** Openings with this prompt's nonce that never closed. Always 0 for a well-formed prompt. */
  readonly unterminated: number;
}

const OPEN_SHAPE = new RegExp(`<${DATA_BLOCK_TAG}-([0-9a-f]{8,})([^>]*)>`, 'g');
const CLOSE_SHAPE = new RegExp(`</${DATA_BLOCK_TAG}-([0-9a-f]{8,})>`, 'g');
const ATTRIBUTE = /([a-z][a-z0-9_]*)="([^"]*)"/g;

interface Marker {
  readonly at: number;
  readonly end: number;
  readonly nonce: string;
  readonly kind: 'open' | 'close';
  readonly text: string;
  readonly attributes: Readonly<Record<string, string>>;
}

const markersIn = (prompt: string): Marker[] => {
  const found: Marker[] = [];
  for (const match of prompt.matchAll(OPEN_SHAPE)) {
    const attributes: Record<string, string> = {};
    for (const attribute of (match[2] ?? '').matchAll(ATTRIBUTE)) {
      attributes[attribute[1] as string] = attribute[2] as string;
    }
    found.push({
      at: match.index,
      end: match.index + match[0].length,
      nonce: match[1] as string,
      kind: 'open',
      text: match[0],
      attributes,
    });
  }
  for (const match of prompt.matchAll(CLOSE_SHAPE)) {
    found.push({
      at: match.index,
      end: match.index + match[0].length,
      nonce: match[1] as string,
      kind: 'close',
      text: match[0],
      attributes: {},
    });
  }
  return found.sort((left, right) => left.at - right.at);
};

/**
 * Read a prompt the way the party holding it has to: find the nonce, then apply the stated rule —
 * *a block ends only at the closing marker carrying its opening nonce.*
 */
export const readDataBlocks = (prompt: string): PromptReading => {
  const markers = markersIn(prompt);
  const opening = markers.find((marker) => marker.kind === 'open');
  const nonce = opening?.nonce ?? null;
  if (nonce === null) {
    return {
      nonce: null,
      blocks: [],
      platformVoice: [prompt],
      spoofedMarkers: markers.map((marker) => marker.text),
      unterminated: 0,
    };
  }

  const blocks: ReadDataBlock[] = [];
  const platformVoice: string[] = [];
  const spoofedMarkers: string[] = [];
  let unterminated = 0;
  let cursor = 0;
  let index = 0;

  while (index < markers.length) {
    const marker = markers[index] as Marker;
    if (marker.nonce !== nonce) {
      // Not this prompt's marker: it is data, wherever it sits. Recorded and stepped over.
      spoofedMarkers.push(marker.text);
      index += 1;
      continue;
    }
    if (marker.kind === 'close') {
      // A close with no open before it: the platform never writes one, so it is text.
      spoofedMarkers.push(marker.text);
      index += 1;
      continue;
    }
    const close = markers
      .slice(index + 1)
      .find((candidate) => candidate.kind === 'close' && candidate.nonce === nonce);
    if (close === undefined) {
      unterminated += 1;
      index += 1;
      continue;
    }
    platformVoice.push(prompt.slice(cursor, marker.at));
    // Marker-shaped text *inside* the body is data — recorded so a fixture can prove it planted an
    // attack, which is what makes the negative assertion capable of failing (standing rule 43).
    for (const inside of markers.slice(index + 1, markers.indexOf(close))) {
      spoofedMarkers.push(inside.text);
    }
    // The frame's own two newlines, and only those.
    const inner = prompt.slice(marker.end, close.at);
    blocks.push({
      kind: marker.attributes.kind ?? '',
      attributes: marker.attributes,
      body: inner.startsWith('\n') && inner.endsWith('\n') ? inner.slice(1, -1) : inner,
    });
    cursor = close.end;
    index = markers.indexOf(close) + 1;
  }
  platformVoice.push(prompt.slice(cursor));
  return { nonce, blocks, platformVoice, spoofedMarkers, unterminated };
};
