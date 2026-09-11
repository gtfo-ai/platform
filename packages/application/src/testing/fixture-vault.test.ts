/**
 * The fixture vault's own claims, enforced.
 *
 * A fixture's docblock is a claim about the corpus, and review found one of this file's to be
 * false: the padding paragraph said it "contains none of the query terms the retrieval tests search
 * for", and the intersection with the acceptance query is `["a", "its", "the"]`. The claim was
 * narrowed to the true one — none of them is ever a *keyword*, because all are shorter than
 * `MIN_QUERY_TERM_LENGTH` — and standing rule 44 says a narrowed claim still needs the check that
 * enforces it, or the next edit makes it false again.
 */

import { extractQueryTerms, MIN_QUERY_TERM_LENGTH, parseKbDocument } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { vaultRelativePath } from '../knowledge/indexer.js';
import {
  FIXTURE_HOSTILE_PATH,
  FIXTURE_HOSTILE_PHRASES,
  FIXTURE_INVALID_PATH,
  FIXTURE_KNOWLEDGE_DIR,
  FIXTURE_PROJECT_KEY,
  FIXTURE_VAULT,
  PADDING_PARAGRAPH,
} from './fixture-vault.js';

/** Every query the retrieval tests put to the vault. Kept beside the claim it constrains. */
const RETRIEVAL_QUERIES: readonly string[] = [
  'the session service fails its tests with a foreign key violation',
  'Fix the flaky billing invoice tax rounding for EUR',
  'seeded fixture user session tests',
  'seed:users foreign-key',
  'legacy importer timestamps',
  'JWT session tokens opaque superseded',
  'schema change proposal for the architecture stage',
  'invoice tax rounding currency locale',
  'notes on untrusted content maintenance mode runbook drain',
];

describe('the padding paragraph cannot be the reason a document ranks', () => {
  it('shares no keyword with any query the retrieval tests use', () => {
    const padding = new Set(extractQueryTerms(PADDING_PARAGRAPH));
    const shared = RETRIEVAL_QUERIES.flatMap((query) =>
      extractQueryTerms(query).filter((term) => padding.has(term)),
    );
    expect(shared).toEqual([]);
  });

  it('shares only sub-keyword tokens, which is the narrowed claim rather than the old one', () => {
    // The measurement review made, reproduced here so the docblock's correction is checkable: the
    // paragraph *does* share words with the acceptance query, and every shared word is too short to
    // survive `extractQueryTerms`.
    const words = (text: string): readonly string[] =>
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((word) => word !== '');
    const padding = new Set(words(PADDING_PARAGRAPH));
    const shared = [
      ...new Set(
        words('the session service fails its tests with a foreign key violation').filter((word) =>
          padding.has(word),
        ),
      ),
    ];
    // Review's figure was `["the", "its"]` over the same query; the third, `a`, is the article
    // review's own tokenisation dropped. All three are sub-keyword, which is the claim.
    expect(shared.sort()).toEqual(['a', 'its', 'the']);
    for (const word of shared) expect(word.length).toBeLessThan(MIN_QUERY_TERM_LENGTH);
  });
});

describe('the vault is what its docblock says it is', () => {
  it('parses every document except the one named as invalid', () => {
    const invalid = FIXTURE_VAULT.filter((document) => {
      const parse = parseKbDocument({
        path: document.path,
        vaultRelativePath: vaultRelativePath(document.path, FIXTURE_KNOWLEDGE_DIR),
        source: document.source,
        projectKey: FIXTURE_PROJECT_KEY,
      });
      return parse.status === 'invalid';
    });
    expect(invalid.map((document) => document.path)).toEqual([FIXTURE_INVALID_PATH]);
  });

  it('carries exactly one hostile document, and it really is hostile', () => {
    // Standing rule 45: a fixture named for the property under test guarantees the property is
    // never tested. This asserts the fixture deserves its name — that it contains the attacks the
    // consumers are tested against, rather than being called hostile and being ordinary prose.
    const hostile = FIXTURE_VAULT.find((document) => document.path === FIXTURE_HOSTILE_PATH);
    expect(hostile).toBeDefined();
    for (const phrase of FIXTURE_HOSTILE_PHRASES) {
      expect(hostile?.source).toContain(phrase);
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the assertion.
    expect(hostile?.source).toMatch(/[\u{0000}-\u{0008}\u{000B}-\u{001F}\u{007F}-\u{009F}]/u);
    // The NUL specifically, and not merely "some control character": it is the one with a
    // correctness consequence rather than a rendering one — PostgreSQL refuses it in a `text`
    // column, so `context-pack.integration.test.ts` only proves anything while this is here.
    expect(hostile?.source).toContain('\u{0000}');
    // And the escape sequence, which is the rendering one.
    expect(hostile?.source).toContain('\u{001B}[31m');
    expect(hostile?.source).toMatch(/[\u{202A}-\u{202E}\u{2066}-\u{2069}]/u);
    expect(hostile?.source).toContain(`${FIXTURE_PROJECT_KEY} / ${FIXTURE_KNOWLEDGE_DIR}`);
  });

  it('has a unique path per document', () => {
    const paths = FIXTURE_VAULT.map((document) => document.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
