/**
 * Post-processing for the `$defs` block of a generated JSON Schema document.
 *
 * Internal to the JSON Schema renderer (`schemas.ts`) — deliberately **not** re-exported from
 * `index.ts`, because it is a detail of how documents are written, not part of the contract.
 */

const ANONYMOUS_DEF = /^__schema\d+$/;
const ANONYMOUS_REF = /#\/\$defs\/__schema\d+/g;
const REF_PREFIX = '#/$defs/';

/** JSON with object keys sorted, so two structurally equal definitions hash the same. */
const canonicalise = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as object).sort(([a], [b]) => (a < b ? -1 : 1)))
      : inner,
  );

/** FNV-1a, 32-bit. Only needs to be stable and collision-free over a few dozen definitions. */
const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * Give the definitions zod hoisted anonymously a content-derived name and sort `$defs`.
 *
 * `reused: 'ref'` numbers anonymous definitions in traversal order, so inserting one event
 * renumbers the rest of the file. Naming them after their content — and sorting the block —
 * keeps a regenerated document diffable.
 *
 * Two anonymous definitions share a name only when they are byte-for-byte the same definition:
 * zod hoists a fresh instance per call site, so `idSchema.nullish()` written in six payloads
 * arrives as six identical definitions and collapses to one. The hash seed normalises references
 * to *other* anonymous definitions (whose numbering is what we are removing), which means two
 * definitions that differ only in which anonymous definition they point at would hash the same.
 * That would be a silent, wrong merge, so the guard compares the exact definition behind a name
 * and throws instead. It is unreachable in the current publication set — no anonymous definition
 * references another — and exists so it stays that way.
 */
export const stabiliseDefs = (document: Record<string, unknown>): Record<string, unknown> => {
  const defs = document.$defs as Record<string, unknown> | undefined;
  if (!defs) return document;

  const renames = new Map<string, string>();
  const contentByName = new Map<string, string>();
  for (const key of Object.keys(defs).filter((name) => ANONYMOUS_DEF.test(name))) {
    const content = canonicalise(defs[key]);
    const name = `anon_${fnv1a(content.replace(ANONYMOUS_REF, `${REF_PREFIX}__anon`))}`;
    const claimed = contentByName.get(name);
    if (claimed !== undefined && claimed !== content) {
      throw new Error(
        `anonymous definition name ${name} would merge two different definitions: ${claimed} vs ${content}`,
      );
    }
    contentByName.set(name, content);
    renames.set(key, name);
  }

  const rewritten = JSON.parse(
    JSON.stringify(document).replace(ANONYMOUS_REF, (match) => {
      // A reference with no definition behind it is left exactly as it was: this function
      // renames definitions, it does not invent them, and a dangling `$ref` is the caller's bug
      // to see rather than one to paper over with a mangled pointer.
      const renamed = renames.get(match.slice(REF_PREFIX.length));
      return renamed === undefined ? match : `${REF_PREFIX}${renamed}`;
    }),
  ) as Record<string, unknown>;

  const rewrittenDefs = rewritten.$defs as Record<string, unknown>;
  rewritten.$defs = Object.fromEntries(
    Object.entries(rewrittenDefs)
      .map(([key, value]) => [renames.get(key) ?? key, value] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return rewritten;
};
