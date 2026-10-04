/**
 * A GitLab CI file → plain data, for the readiness CI-rules notice (WP-143) — the `CiDocumentParser`
 * port over the `yaml` package.
 *
 * Not `yamlConfigCodec`: that parser refuses every tag and every merge key because
 * `.agentic/config.yml` needs neither, while a CI file routinely uses both — `<<: *anchor` to share a
 * job template and `!reference [.x, rules]` to share rules (Autix's file does both). So:
 *
 *  - `merge: true` — a `<<` merge key is resolved, because GitLab resolves it before reading the
 *    job; leaving it unresolved would hide a template's `stage:` or `rules:`;
 *  - `!reference` is a **custom tag** whose sequence becomes `{ '!reference': [...] }`
 *    (`CI_REFERENCE_KEY`), which the evaluator reads as *unknown* wherever it appears and never
 *    resolves;
 *  - any **other** tag is a refusal (the package reports it as a warning, and every warning is
 *    one), so the notice says the file could not be parsed and gives no warning;
 *  - the configuration codec's alias ceiling, for the same exponential-expansion reason.
 *
 * The file is untrusted (anyone who can merge to the default branch writes it). It is bounded before
 * it gets here (`MAX_REPOSITORY_FILE_BYTES`) and redacted by the caller before it is parsed, and a
 * refusal's reason keeps the parser's first line and the position only — never a source line.
 */
import type { CiDocumentParser } from '@platform/application';
import { CI_REFERENCE_KEY } from '@platform/domain';
import {
  type CollectionTag,
  type Document,
  isAlias,
  isCollection,
  isPair,
  parseDocument,
  YAMLError,
  YAMLSeq,
} from 'yaml';
import { MAX_YAML_ALIASES } from './yaml-codec.js';

const MAX_REASON_CHARS = 200;

const positionOf = (text: string, offset: number | undefined): string =>
  offset === undefined
    ? ''
    : ` at line ${text.slice(0, offset).split('\n').length}, column ${offset - text.lastIndexOf('\n', offset - 1)}`;

const refusal = (reason: string): { readonly ok: false; readonly reason: string } => ({
  ok: false,
  reason: reason.slice(0, MAX_REASON_CHARS),
});

/**
 * A `!reference` sequence; its JS value is the marker, never the list it would be resolved to. The
 * package types `toJSON` as an array, so the marker is returned through a cast it never inspects.
 */
class ReferenceSeq extends YAMLSeq {
  override toJSON(key?: unknown, context?: Parameters<YAMLSeq['toJSON']>[1]): unknown[] {
    return { [CI_REFERENCE_KEY]: super.toJSON(key, context) } as unknown as unknown[];
  }
}

const referenceTag: CollectionTag = {
  tag: '!reference',
  collection: 'seq',
  nodeClass: ReferenceSeq,
  identify: () => false,
  resolve: (seq) => {
    const reference = new ReferenceSeq();
    reference.items = (seq as YAMLSeq).items;
    return reference;
  },
};

/**
 * Nodes the document may expand to once every alias (and every `<<` merge over aliases) is
 * followed. The alias ceiling alone does not bound it: a chain of `<<: [*a, *a, …]` mappings grows
 * by its width per level in a few hundred bytes (WP-143 review round 1 measured 7 levels in 369
 * bytes at 157 ms, ~8x a level). A real CI file expands to a few thousand.
 */
export const MAX_CI_EXPANDED_NODES = 100_000;

/**
 * The expanded node count, computed with one memo per node so the walk itself is linear in the
 * document; `Infinity` for an alias that reaches itself.
 */
const expandedNodeCount = (document: Document): number => {
  const memo = new Map<unknown, number>();
  const visiting = new Set<unknown>();
  const count = (node: unknown): number => {
    if (node === null || typeof node !== 'object') return 1;
    const known = memo.get(node);
    if (known !== undefined) return known;
    if (visiting.has(node)) return Number.POSITIVE_INFINITY;
    visiting.add(node);
    let total = 1;
    if (isAlias(node)) {
      total = count(node.resolve(document));
    } else if (isPair(node)) {
      total = count(node.key) + count(node.value);
    } else if (isCollection(node)) {
      for (const item of node.items) {
        total += count(item);
        if (total > MAX_CI_EXPANDED_NODES) break;
      }
    }
    visiting.delete(node);
    memo.set(node, total);
    return total;
  };
  return count(document.contents);
};

export const yamlCiParser: CiDocumentParser = {
  parse: (text) => {
    try {
      const document = parseDocument(text, {
        merge: true,
        uniqueKeys: true,
        prettyErrors: false,
        // Never `process.emitWarning`: a warning quotes the document (see yaml-codec.ts).
        logLevel: 'error',
        customTags: [referenceTag],
      });
      const error = document.errors[0];
      if (error !== undefined) {
        return refusal(`${error.message.split('\n')[0] ?? ''}${positionOf(text, error.pos[0])}`);
      }
      const warning = document.warnings[0];
      if (warning !== undefined) {
        return refusal(
          `${warning.message.split('\n')[0] ?? ''}${positionOf(text, warning.pos[0])}`,
        );
      }
      const expanded = expandedNodeCount(document);
      if (expanded > MAX_CI_EXPANDED_NODES) {
        return refusal(
          `the document expands to more than ${MAX_CI_EXPANDED_NODES} nodes through its aliases and merge keys, so it is not read`,
        );
      }
      return { ok: true, value: document.toJS({ maxAliasCount: MAX_YAML_ALIASES }) as unknown };
    } catch (error) {
      if (!(error instanceof Error)) return refusal('the document could not be parsed');
      const offset = error instanceof YAMLError ? error.pos[0] : undefined;
      return refusal(`${error.message.split('\n')[0] ?? ''}${positionOf(text, offset)}`);
    }
  },
};
