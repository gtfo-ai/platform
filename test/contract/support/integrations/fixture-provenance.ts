/**
 * **Fixture provenance**, asserted rather than decorated.
 *
 * Every HTTP fixture under `test/fixtures/http/<provider>/` carries a `source` block naming where
 * its document came from, and `CLAUDE.md` makes that block the reason an adapter built without a
 * live provider can be trusted at all: "a fixture you recorded and a fixture you invented are
 * different kinds of evidence, and an adapter that conflates them passes its own tests and fails
 * in production". WP-08 review round 1 rewrote one fixture's label to `documented` and pointed its
 * `url` at `https://example.invalid`, and **157 of 157 tests still passed** — the blocks were
 * prose. This is the check that was missing.
 *
 * It is deliberately provider-agnostic: WP-09 labelled the GitLab fixtures the same way and
 * WP-10/WP-11 will follow, so the suite discovers provider directories from disk (standing rule 7
 * — ask the filesystem, do not carry a list) and needs nothing from a provider but the two files
 * it already writes: the fixtures, and the `SOURCES.md` beside them.
 *
 * ## What it asserts
 *
 *  1. the corpus is non-empty, and every provider directory has a `SOURCES.md` that names at least
 *     one documentation URL (a directory with neither fails; nothing here can pass by vacuity);
 *  2. every fixture carries a `source` object — and *every file* under the provider directory is a
 *     fixture: the walk is recursive and extension-agnostic, so a subdirectory or a `.jsonc` is
 *     checked like everything else rather than skipped (review round 2 planted both, and the
 *     first draft of this file saw neither);
 *  3. every fixture declares exactly one evidence label — `evidence` or `kind`, not both — and it
 *     is one of {@link PROVENANCE_KINDS};
 *  4. every fixture that claims a documented origin cites an `https` URL that is **not on a
 *     reserved documentation domain** (RFC 2606/6761: `.invalid`, `.example`, `.test`,
 *     `.localhost`, `example.com|net|org`) and whose **host `SOURCES.md` names**;
 *  5. every such fixture carries a `retrieved` date, `YYYY-MM-DD`, real and not in the future;
 *  6. every fixture that is *not* plain `documented` — adapted, composed, inferred, invented —
 *     carries a `note` saying what was changed or assumed, because that is the whole difference
 *     between the labels;
 *  7. an `invented` fixture cites no URL, since there is nothing to cite.
 *
 * ## What it cannot assert, and pretending otherwise would repeat the mistake
 *
 *  - **That the vendor's page still says this.** Nothing here fetches a URL; a documentation page
 *    can change or disappear and this stays green. Only a human re-reading the page can renew a
 *    `retrieved` date, and a stale one is invisible to any local check.
 *  - **That the body actually matches the cited example.** The fixture could be entirely invented
 *    under a correct URL and a correct date; a reviewer comparing the file with the page is the
 *    only thing that catches that.
 *  - **That the label is honest.** Relabelling `composed` → `documented` keeps a valid URL and a
 *    valid date and passes. What it now costs an author is a deliberate lie in a labelled field
 *    rather than an unnoticed drift, and a `note` they have to delete.
 *  - **That a non-JSON fixture is honest.** A file that does not parse as JSON cannot carry an
 *    inline `source` block, so it fails rule 2 by construction. That is the fail-closed direction
 *    and it is deliberate: a provider that needs a binary or plain-text fixture has to decide
 *    where its provenance lives (a sidecar, most likely) rather than inherit a silent skip.
 *  - **That an operating-system artefact is not a fixture.** `.DS_Store` and `Thumbs.db` are
 *    skipped by name; anything else, dot-file or not, must be a fixture with provenance.
 *  - **That `SOURCES.md` is truthful.** The host allow-list is read out of the provider's own
 *    prose; an author who adds a host there is asserting it is a vendor documentation host. Worse,
 *    it is read out of *all* of the prose: this suite's first draft allowed `example.invalid`
 *    because this very file's `SOURCES.md` mentions it while explaining the defect, and the
 *    reviewer's own mutation survived. That is what the reserved-domain deny-list is for — an
 *    allow-list scraped from prose is only as narrow as the prose, and a deny-list of domains IANA
 *    reserved for documentation is not scraped from anything.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The taxonomy. The first four are WP-08's (`test/fixtures/http/jira-cloud/SOURCES.md`);
 * `inferred` is WP-09's addition for a response whose status is documented and whose body is not.
 */
export const PROVENANCE_KINDS = [
  'documented',
  'documented-adapted',
  'composed',
  'inferred',
  'invented',
] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/** The keys a provider may declare its label under. Exactly one of them, never both. */
const LABEL_KEYS = ['evidence', 'kind'] as const;

const SOURCES_FILE = 'SOURCES.md';
/**
 * Domains reserved for documentation and testing, which no vendor's documentation lives on
 * (RFC 2606 § 2–3, RFC 6761 § 6.2–6.4). Denied whatever `SOURCES.md` happens to mention.
 */
const RESERVED_SUFFIXES = ['.invalid', '.example', '.test', '.localhost', '.local'] as const;
const RESERVED_HOSTS = ['example.com', 'example.net', 'example.org', 'localhost'] as const;

export const isReservedDocumentationHost = (host: string): boolean => {
  const lower = host.toLowerCase();
  return (
    RESERVED_HOSTS.some((reserved) => lower === reserved || lower.endsWith(`.${reserved}`)) ||
    RESERVED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  );
};
const RETRIEVED_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const URL_IN_MARKDOWN = /https?:\/\/[^\s)`"'<>]+/g;

export interface FixtureProvenance {
  readonly file: string;
  /** `null` when the file carries no `source` object at all. */
  readonly source: Readonly<Record<string, unknown>> | null;
  readonly labels: readonly string[];
  readonly label: string | null;
  readonly url: unknown;
  readonly retrieved: unknown;
  readonly note: unknown;
}

/**
 * Files an operating system writes into any directory it opens, which are not fixtures and are not
 * committed. Named rather than pattern-matched: everything else must be a fixture with provenance,
 * so an unexpected file fails loudly instead of being skipped (standing rule 7 — this list only
 * ever *adds* failures for files git would not track anyway).
 */
const OS_ARTEFACTS: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Every file under a provider directory, recursively, whatever its extension, `SOURCES.md` aside.
 *
 * WP-08 review round 2 planted unlabelled fixtures **in a subdirectory** and **with non-`.json`
 * extensions** and the suite passed: the first draft read one directory and filtered on `.json`,
 * so anything else was invisible rather than refused. Since WP-09, WP-10 and WP-11 adopt this
 * helper, the blind spot would have propagated to every provider. Paths are relative to the
 * provider directory and use `/`, so a failure names `webhooks/comment-created.json`.
 */
const fixtureFilesUnder = (root: string, relative = ''): readonly string[] =>
  readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      return fixtureFilesUnder(root, path);
    }
    return entry.name === SOURCES_FILE || OS_ARTEFACTS.has(entry.name) ? [] : [path];
  });

/** The document, or `null` when the file is not JSON at all — which is a fixture without a block. */
const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/** Every fixture in one provider directory, in a stable order. */
export const readFixtureProvenance = (directory: URL): readonly FixtureProvenance[] => {
  const root = fileURLToPath(directory);
  return [...fixtureFilesUnder(root)].sort().map((file) => {
    const document = readJson(join(root, file));
    const source =
      typeof document === 'object' &&
      document !== null &&
      typeof (document as { source?: unknown }).source === 'object' &&
      (document as { source: unknown }).source !== null
        ? ((document as { source: Record<string, unknown> }).source as Record<string, unknown>)
        : null;
    const labels = source === null ? [] : LABEL_KEYS.filter((key) => key in source);
    return {
      file,
      source,
      labels,
      label: labels.length === 1 ? String(source?.[labels[0] as string]) : null,
      url: source?.url,
      retrieved: source?.retrieved,
      note: source?.note,
    };
  });
};

/** Every host `SOURCES.md` names. An empty set means the provider documented no source at all. */
export const documentationHosts = (markdown: string): ReadonlySet<string> => {
  const hosts = new Set<string>();
  for (const match of markdown.matchAll(URL_IN_MARKDOWN)) {
    try {
      hosts.add(new URL(match[0]).host);
    } catch {
      // A malformed URL in prose is not a claim about a host.
    }
  }
  return hosts;
};

/** `true` for a `YYYY-MM-DD` that is a real day and is not in the future. */
export const isPlausibleRetrievalDate = (value: unknown, today: Date): boolean => {
  if (typeof value !== 'string' || !RETRIEVED_PATTERN.test(value)) {
    return false;
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed) && parsed <= today.getTime();
};

export interface FixtureProvenanceOptions {
  readonly provider: string;
  readonly directory: URL;
  /** Injected by this module's own tests; production callers use the real date. */
  readonly today?: Date;
}

/** Registers one provider's provenance suite. One `it` per rule, so a failure names the rule. */
export const describeFixtureProvenance = (options: FixtureProvenanceOptions): void => {
  describe(`fixture provenance — ${options.provider}`, () => {
    const fixtures = readFixtureProvenance(options.directory);
    const sourcesPath = new URL(SOURCES_FILE, options.directory);
    const sources = existsSync(sourcesPath) ? readFileSync(sourcesPath, 'utf8') : null;
    const hosts = new Set(
      [...documentationHosts(sources ?? '')].filter((host) => !isReservedDocumentationHost(host)),
    );
    const today = options.today ?? new Date();
    const cites = (fixture: FixtureProvenance): boolean => fixture.label !== 'invented';

    it('has fixtures to check, and a SOURCES.md naming where they came from', () => {
      // Standing rule 4: every other assertion below is satisfied by an empty corpus.
      expect(fixtures.length, `${options.provider} has no fixtures`).toBeGreaterThan(0);
      expect(sources, `${options.provider}/${SOURCES_FILE} is missing`).not.toBeNull();
      expect([...hosts], `${SOURCES_FILE} names no documentation URL`).not.toEqual([]);
    });

    it('gives every fixture a source block', () => {
      // A file that is not JSON at all lands here too: it cannot carry a block, and being
      // unreadable is not an exemption from provenance.
      expect(
        fixtures.filter((fixture) => fixture.source === null).map((f) => f.file),
        'every file under the directory, at any depth and whatever its extension, needs `source`',
      ).toEqual([]);
    });

    it('labels every fixture with exactly one known kind', () => {
      const wrong = fixtures
        .filter(
          (fixture) =>
            fixture.labels.length !== 1 ||
            !(PROVENANCE_KINDS as readonly string[]).includes(fixture.label ?? ''),
        )
        .map((fixture) => `${fixture.file}: ${fixture.labels.join('+') || 'no label'}`);
      expect(wrong, `one of ${PROVENANCE_KINDS.join(', ')} under "evidence" or "kind"`).toEqual([]);
    });

    it('cites a vendor documentation URL that SOURCES.md names', () => {
      const wrong = fixtures
        .filter(cites)
        .filter((fixture) => {
          if (typeof fixture.url !== 'string') {
            return true;
          }
          try {
            const url = new URL(fixture.url);
            return (
              url.protocol !== 'https:' ||
              isReservedDocumentationHost(url.host) ||
              !hosts.has(url.host)
            );
          } catch {
            return true;
          }
        })
        .map((fixture) => `${fixture.file}: ${String(fixture.url)}`);
      expect(wrong, `hosts named in ${SOURCES_FILE}: ${[...hosts].join(', ')}`).toEqual([]);
    });

    it('records the day each cited document was read', () => {
      const wrong = fixtures
        .filter(cites)
        .filter((fixture) => !isPlausibleRetrievalDate(fixture.retrieved, today))
        .map((fixture) => `${fixture.file}: ${String(fixture.retrieved)}`);
      expect(wrong, 'YYYY-MM-DD, a real day, not in the future').toEqual([]);
    });

    it('makes every fixture that is not plainly documented explain itself', () => {
      const wrong = fixtures
        .filter((fixture) => fixture.label !== null && fixture.label !== 'documented')
        .filter((fixture) => typeof fixture.note !== 'string' || fixture.note.trim().length === 0)
        .map((fixture) => `${fixture.file}: ${String(fixture.label)} with no note`);
      expect(wrong, 'an adapted, composed, inferred or invented fixture needs a note').toEqual([]);
    });

    it('lets an invented fixture cite nothing, because there is nothing to cite', () => {
      const wrong = fixtures
        .filter((fixture) => fixture.label === 'invented' && fixture.url !== undefined)
        .map((fixture) => `${fixture.file}: ${String(fixture.url)}`);
      expect(wrong).toEqual([]);
    });
  });
};
