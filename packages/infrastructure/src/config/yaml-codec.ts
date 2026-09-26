/**
 * `.agentic/config.yml` in and out — the `ConfigDocumentCodec` port over the `yaml` package (WP-63).
 *
 * The file is **untrusted input** (anyone who can merge to the default branch writes it), so the
 * parser is configured for a hostile document rather than a friendly one, and each option is a
 * decision:
 *
 *  - `schema: 'core'` — YAML 1.2's core schema: `yes`, `on` and `09:00` are strings, not a boolean
 *    and a sexagesimal number, so the value a human wrote is the value the strict schema sees.
 *  - `maxAliasCount` — an alias ceiling, because a few lines of anchors expand exponentially (the
 *    "billion laughs" shape); measured, the package refuses such a document by name.
 *  - `uniqueKeys` (the default, stated) — a key written twice is an error rather than whichever
 *    one the parser met last.
 *  - `merge: false` — no `<<` merge keys: a key that means "copy another mapping here" is a second
 *    way to spell a value, and the strict schema would see the result without the reader seeing
 *    where it came from.
 *  - `prettyErrors: false` — the package's pretty errors quote the offending **source lines**, and
 *    a refusal is stored and published; only the message and the line/column are kept.
 *  - `logLevel: 'error'` and **every explicit tag refused** — see {@link firstTagged}; a warning the
 *    parser collects is a refusal too, never a value quietly coerced.
 *
 * The file is bounded before it gets here (`MAX_REPOSITORY_FILE_BYTES`, checked against the blob
 * size), so this module does not bound it again.
 */
import type { ConfigDocumentCodec } from '@platform/application';
import type { JsonObject } from '@platform/contracts';
import { parseDocument, stringify, visit, YAMLError } from 'yaml';

/** Aliases one document may use. A configuration needs none; fifty is generous and still safe. */
export const MAX_YAML_ALIASES = 50;

/** Longest parser message kept — a sentence and a position. */
const MAX_REASON_CHARS = 200;

/** The position of an offset in the text, as a human reads it. */
const positionOf = (text: string, offset: number | undefined): string =>
  offset === undefined
    ? ''
    : ` at line ${text.slice(0, offset).split('\n').length}, column ${offset - text.lastIndexOf('\n', offset - 1)}`;

const refusal = (reason: string): { readonly ok: false; readonly reason: string } => ({
  ok: false,
  reason: reason.slice(0, MAX_REASON_CHARS),
});

/**
 * The first explicitly tagged node, or `null` (WP-63 review round 1).
 *
 * A configuration needs no tag at all, and a tag is where YAML stops meaning JSON: an unknown one
 * (`!custom`, `!!js/function`) is resolved to a string with a warning the package would otherwise
 * print on stderr — outside pino and the redactor — and `!!binary`/`!!set` resolve to a `Buffer`
 * and an object the document never spelled. So **every** explicit tag is refused by name.
 */
const firstTagged = (
  document: ReturnType<typeof parseDocument>,
): { tag: string; offset?: number } | null => {
  let found: { tag: string; offset?: number } | null = null;
  visit(document, {
    Node: (_key, node) => {
      if (node.tag !== undefined && found === null) {
        found = {
          tag: node.tag,
          ...(node.range === undefined || node.range === null ? {} : { offset: node.range[0] }),
        };
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return found;
};

export const yamlConfigCodec: ConfigDocumentCodec = {
  parse: (text) => {
    try {
      const document = parseDocument(text, {
        schema: 'core',
        uniqueKeys: true,
        merge: false,
        prettyErrors: false,
        // Never `process.emitWarning`: a warning quotes the document, and stderr is outside pino
        // and the redactor. Warnings are read off the document below and refused instead.
        logLevel: 'error',
      });
      const error = document.errors[0];
      if (error !== undefined) {
        return refusal(`${error.message.split('\n')[0] ?? ''}${positionOf(text, error.pos[0])}`);
      }
      const tagged = firstTagged(document);
      if (tagged !== null) {
        return refusal(
          `an explicit YAML tag (${JSON.stringify(tagged.tag.slice(0, 40))}) is refused: a configuration is plain mappings, lists and scalars${positionOf(text, tagged.offset)}`,
        );
      }
      const warning = document.warnings[0];
      if (warning !== undefined) {
        return refusal(
          `${warning.message.split('\n')[0] ?? ''}${positionOf(text, warning.pos[0])}`,
        );
      }
      return { ok: true, value: document.toJS({ maxAliasCount: MAX_YAML_ALIASES }) as unknown };
    } catch (error) {
      if (!(error instanceof Error)) {
        return refusal('the document could not be parsed');
      }
      // `prettyErrors: false` leaves `linePos` unset, so the position is computed from the offset.
      const offset = error instanceof YAMLError ? error.pos[0] : undefined;
      return refusal(`${error.message.split('\n')[0] ?? ''}${positionOf(text, offset)}`);
    }
  },
  /**
   * The header lines as YAML comments, then the document. `lineWidth: 0` never folds a long string
   * onto a second line, so a command pattern stays one greppable line. The round trip — this
   * output parsed by `parse` above is the document — is a property test beside this file.
   */
  stringify: (document: JsonObject, header: readonly string[]) =>
    `${header.map((line) => `# ${line}`.trimEnd()).join('\n')}${header.length === 0 ? '' : '\n'}${stringify(document, { lineWidth: 0 })}`,
};
