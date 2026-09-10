/**
 * **Fixture provenance**, asserted rather than decorated — for both fixture shapes.
 *
 * Every HTTP fixture under `test/fixtures/http/<provider>/` says where its document came from, and
 * `CLAUDE.md` makes that claim the reason an adapter built without a live provider can be trusted
 * at all: "a fixture you recorded and a fixture you invented are different kinds of evidence, and
 * an adapter that conflates them passes its own tests and fails in production". WP-08 review round
 * 1 rewrote one fixture's label to `documented` and pointed its `url` at `https://example.invalid`,
 * and **157 of 157 tests still passed** — the blocks were prose. This is the check that was
 * missing (standing rule 17).
 *
 * ## The rule, in one sentence
 *
 * A fixture carries provenance either as a **file-level `source`** block or, when it is an
 * `{"interactions": [...]}` document, as a `source` block on **every one** of a non-empty list of
 * interactions; each block declares exactly one known kind, carries a `note` unless it is plainly
 * `documented`, and — unless it is `invented` — cites an `https` URL on a non-reserved host that
 * the provider's `SOURCES.md` names, plus a real, non-future `retrieved` date.
 *
 * ## Why two shapes rather than one
 *
 * WP-08 (Jira) writes one document per file and one `source` per file. WP-09 (GitLab) writes one
 * file per endpoint group holding `{"interactions": [...]}`, because its replay double answers
 * requests from a recorded conversation — and there, **provenance belongs to the interaction**: a
 * `404` cited from the REST troubleshooting table sits next to a `201` cited from the endpoint's
 * own page. Flattening it to one block per file would force a single URL onto a file that honestly
 * cites seven, which is a *less* precise claim than the corpus can make. So the suite accepts both
 * and refuses the halfway house: a document declares its provenance at the top level or on every
 * interaction, never both, because "which of the two covers interaction 3" has no answer.
 *
 * Partial coverage is a failure, and so is vacuous coverage: an `interactions` file where three of
 * seven carry `source` fails and names the four that do not, and an empty `interactions` list is
 * not a corpus that passes every rule — it is a document that makes no claim (standing rule 4).
 *
 * ## `SOURCES.md` is required for **both** shapes — the reasoning, for WP-10 and WP-11
 *
 * WP-09 argued the per-interaction shape needs no `SOURCES.md`, since the equivalent is "the union
 * of `source.url` over the directory, synthesised, not required as a document". A hand-maintained
 * list drifts (standing rule 7), and that argument is a real one. It was **rejected**, twice over:
 *
 *  1. **A synthesised list cannot disagree with what it checks.** Derive the allow-list from the
 *     fixtures' own URLs and the host rule becomes `url.host ∈ {url.host}` — a tautology that
 *     passes for `https://gitlab-tips.blogspot.test/` as readily as for `docs.gitlab.com`. What is
 *     left is only the reserved-domain deny-list, which admits every host on the internet that is
 *     not `.invalid`/`.example`/`.test`. The allow-list is the only thing in this file that ties a
 *     citation to a **vendor's** documentation, and an expected value computed from the actual
 *     value asserts nothing (standing rule 3).
 *  2. **`SOURCES.md` does a second job no fixture can do.** It is the human-readable statement of
 *     what the corpus rests on, including the pages that produced **no** fixture — rate limits,
 *     the auth header, the webhook signature scheme, the ambiguities found and what was assumed.
 *     A reader auditing the adapter reads that file; nobody audits by grepping `source.url`.
 *
 * The drift standing rule 7 warns about is real but points the safe way here: the list only ever
 * *narrows* what passes, so a host nobody wrote down fails loudly (fail-closed), and a host left
 * behind by a deleted fixture costs nothing but a stale line. Contrast `check-ignored.mjs`'s
 * `IGNORABLE_ROOT_FILES`, the allow-list rule 7's corollary is about: that one *suppresses*
 * failures, so its drift is silent. **WP-10 and WP-11: write a `SOURCES.md`. It is one file, it is
 * the allow-list your citations are checked against, and the suite fails without it.**
 *
 * ## What it asserts
 *
 *  1. the corpus is non-empty, and the provider directory has a `SOURCES.md` naming at least one
 *     non-reserved documentation host (a directory with neither fails; nothing here passes by
 *     vacuity);
 *  2. every fixture carries a `source` — at the top level, or on every interaction — and *every
 *     file* under the provider directory is a fixture: the walk is recursive and
 *     extension-agnostic, so a subdirectory or a `.jsonc` is checked like everything else rather
 *     than skipped (WP-08 review round 2 planted both, and the first draft saw neither);
 *  3. no document claims provenance vacuously: an `interactions` list with nothing in it makes no
 *     claim, and a corpus of such files would satisfy every other rule below;
 *  4. no document mixes the two shapes;
 *  5. every claim declares exactly one evidence label — `evidence` or `kind`, not both — and it is
 *     one of {@link PROVENANCE_KINDS};
 *  6. every claim that is not `invented` cites an `https` URL that is **not on a reserved
 *     documentation domain** (RFC 2606/6761: `.invalid`, `.example`, `.test`, `.localhost`) and
 *     whose **host `SOURCES.md` names**;
 *  7. every such claim carries a `retrieved` date, `YYYY-MM-DD`, real and not in the future;
 *  8. every claim that is not plain `documented` — adapted, composed, inferred, invented — carries
 *     a `note` saying what was changed or assumed, because that is the whole difference between
 *     the labels;
 *  9. an `invented` claim cites no URL, since there is nothing to cite.
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
 *  - **That the *right* interaction carries the *right* citation.** Per-interaction blocks are
 *    checked one by one; swapping the `source` of two interactions in the same file changes
 *    nothing here. Precision is the shape's advantage and its cost.
 *  - **That a non-JSON fixture is honest.** A file that does not parse as JSON cannot carry an
 *    inline `source`, so it fails rule 2 by construction. That is the fail-closed direction and it
 *    is deliberate: a provider that needs a binary or plain-text fixture has to decide where its
 *    provenance lives (a sidecar, most likely) rather than inherit a silent skip.
 *  - **That an operating-system artefact is not a fixture.** `.DS_Store` and `Thumbs.db` are
 *    skipped by name; anything else, dot-file or not, must be a fixture with provenance.
 *  - **That `SOURCES.md` is truthful.** The host allow-list is read out of the provider's own
 *    prose; an author who adds a host there is asserting it is a vendor documentation host. Worse,
 *    it is read out of *all* of the prose: this suite's first draft allowed `example.invalid`
 *    because that `SOURCES.md` mentions it while explaining the defect, and the reviewer's own
 *    mutation survived. That is what the reserved-domain deny-list is for — an allow-list scraped
 *    from prose is only as narrow as the prose, and a deny-list of domains IANA reserved for
 *    documentation is not scraped from anything.
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
/** The member that makes a document the per-interaction shape. */
const INTERACTIONS_KEY = 'interactions';
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

/** One provenance claim: a `source` block, and where in the corpus it was found (or missing). */
export interface ProvenanceClaim {
  /** Path relative to the provider directory, `/`-separated: `webhooks/comment-created.json`. */
  readonly file: string;
  /** The file, or `file#interactions[3]` — what a failure names, so it can be found by eye. */
  readonly location: string;
  /** `null` when nothing at this location carries a `source` object. */
  readonly source: Readonly<Record<string, unknown>> | null;
  readonly labels: readonly string[];
  readonly label: string | null;
  readonly url: unknown;
  readonly retrieved: unknown;
  readonly note: unknown;
}

/**
 * Where a document keeps its provenance. `both` is refused rather than resolved, and `neither` is
 * every file that carries no `source` at all — including one that is not JSON.
 */
export type FixtureShape = 'file' | 'interactions' | 'both' | 'neither';

export interface FixtureDocument {
  readonly file: string;
  readonly shape: FixtureShape;
  /** Empty only for an `interactions` document with an empty list — a claim about nothing. */
  readonly claims: readonly ProvenanceClaim[];
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

/** A JSON object, and not an array: the shape a `source` block and an interaction both have. */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const claimAt = (
  file: string,
  location: string,
  source: Record<string, unknown> | null,
): ProvenanceClaim => {
  const labels = source === null ? [] : LABEL_KEYS.filter((key) => key in source);
  const [only] = labels;
  return {
    file,
    location,
    source,
    labels,
    label: labels.length === 1 && only !== undefined ? String(source?.[only]) : null,
    url: source?.url,
    retrieved: source?.retrieved,
    note: source?.note,
  };
};

/** One file's shape and its claims. The two shapes of the repository, and nothing else. */
const readDocument = (root: string, file: string): FixtureDocument => {
  const document = asRecord(readJson(join(root, file)));
  const fileSource = asRecord(document?.source);
  const interactions = document?.[INTERACTIONS_KEY];
  const nested = Array.isArray(interactions) ? interactions : null;
  const nestedClaims =
    nested?.map((interaction, index) =>
      claimAt(
        file,
        `${file}#${INTERACTIONS_KEY}[${index}]`,
        asRecord(asRecord(interaction)?.source),
      ),
    ) ?? [];

  if (fileSource !== null && nested !== null) {
    // Refused, not resolved: nothing says which block covers interaction 3.
    return { file, shape: 'both', claims: [claimAt(file, file, fileSource), ...nestedClaims] };
  }
  if (fileSource !== null) {
    return { file, shape: 'file', claims: [claimAt(file, file, fileSource)] };
  }
  if (nested !== null) {
    return { file, shape: 'interactions', claims: nestedClaims };
  }
  return { file, shape: 'neither', claims: [claimAt(file, file, null)] };
};

/** Every fixture document in one provider directory, in a stable order. */
export const readFixtureDocuments = (directory: URL): readonly FixtureDocument[] => {
  const root = fileURLToPath(directory);
  return [...fixtureFilesUnder(root)].sort().map((file) => readDocument(root, file));
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

/**
 * `true` for a `YYYY-MM-DD` that is a real day and is not in the future.
 *
 * The round-trip is the point, not decoration: `Date.parse('2026-02-30T00:00:00.000Z')` is
 * **1772409600000**, because V8 rolls a day overflow forward into March rather than refusing it
 * (`2026-13-01` is `NaN`, so only the month was ever checked). WP-08's version asserted "a real
 * day" in its message and accepted the 30th of February; this module's own tests plant one.
 */
export const isPlausibleRetrievalDate = (value: unknown, today: Date): boolean => {
  if (typeof value !== 'string' || !RETRIEVED_PATTERN.test(value)) {
    return false;
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return (
    new Date(parsed).toISOString().slice(0, value.length) === value && parsed <= today.getTime()
  );
};

export interface FixtureProvenanceOptions {
  readonly provider: string;
  readonly directory: URL;
  /** Injected by this module's own tests; production callers use the real date. */
  readonly today?: Date;
}

/** One provider's corpus, read once: the documents, the prose, and the hosts the prose allows. */
export interface ProvenanceCorpus {
  readonly provider: string;
  readonly documents: readonly FixtureDocument[];
  /** `null` when the provider ships no `SOURCES.md` at all. */
  readonly sources: string | null;
  readonly hosts: ReadonlySet<string>;
  readonly today: Date;
}

export const readProvenanceCorpus = (options: FixtureProvenanceOptions): ProvenanceCorpus => {
  const sourcesPath = new URL(SOURCES_FILE, options.directory);
  const sources = existsSync(sourcesPath) ? readFileSync(sourcesPath, 'utf8') : null;
  return {
    provider: options.provider,
    documents: readFixtureDocuments(options.directory),
    sources,
    hosts: new Set(
      [...documentationHosts(sources ?? '')].filter((host) => !isReservedDocumentationHost(host)),
    ),
    today: options.today ?? new Date(),
  };
};

/**
 * One rule: the name of its `it`, the message that names the assertion when it fails, and the
 * offending locations. Rules are values rather than inline `expect`s so that this module's own
 * tests can plant a corpus and assert *which* rule caught it — a mutation whose only evidence is
 * "something went red" does not prove the rule that was supposed to catch it did (rule 3).
 */
export interface ProvenanceRule {
  readonly name: string;
  readonly message: string;
  readonly offenders: readonly string[];
}

const describeLabels = (claim: ProvenanceClaim): string =>
  `${claim.location}: ${claim.labels.join('+') || 'no label'}`;

const citesADocument = (claim: ProvenanceClaim): boolean => claim.label !== 'invented';

const citesAnAllowedHost = (claim: ProvenanceClaim, hosts: ReadonlySet<string>): boolean => {
  if (typeof claim.url !== 'string') {
    return false;
  }
  try {
    const url = new URL(claim.url);
    return (
      url.protocol === 'https:' && !isReservedDocumentationHost(url.host) && hosts.has(url.host)
    );
  } catch {
    return false;
  }
};

/** Every rule, evaluated against one corpus. A rule with no offenders passed. */
export const provenanceRules = (corpus: ProvenanceCorpus): readonly ProvenanceRule[] => {
  const claims = corpus.documents.flatMap((document) => document.claims);
  const cited = claims.filter(citesADocument);
  const hosts = [...corpus.hosts].join(', ');

  return [
    {
      name: 'has fixtures to check, and a SOURCES.md naming where they came from',
      // Standing rule 4: every other rule below is satisfied by an empty corpus.
      message: `${corpus.provider} needs fixtures and a ${SOURCES_FILE} naming a documentation host`,
      offenders: [
        ...(corpus.documents.length === 0 ? ['the directory holds no fixture'] : []),
        // A missing file subsumes "names no host": one problem, one offender to fix.
        ...(corpus.sources === null
          ? [`${SOURCES_FILE} is missing`]
          : corpus.hosts.size === 0
            ? [`${SOURCES_FILE} names no documentation URL`]
            : []),
      ],
    },
    {
      name: 'gives every fixture a source block, on the file or on every interaction',
      // A file that is not JSON at all lands here too: it cannot carry a block, and being
      // unreadable is not an exemption from provenance.
      message:
        'every file under the directory, at any depth and whatever its extension, needs `source` — on the file, or on every one of its `interactions`',
      offenders: claims.filter((claim) => claim.source === null).map((claim) => claim.location),
    },
    {
      name: 'lets no document claim provenance vacuously',
      // Standing rule 4 again, one level down: `{"interactions": []}` has no claim to check, so
      // every claim-shaped rule above and below passes over it in silence.
      message: `an \`${INTERACTIONS_KEY}\` document with an empty list makes no provenance claim`,
      offenders: corpus.documents
        .filter((document) => document.claims.length === 0)
        .map((document) => `${document.file}: ${INTERACTIONS_KEY}: []`),
    },
    {
      name: 'keeps every document to one provenance shape',
      message: `a document carries \`source\` at the top level or on every \`${INTERACTIONS_KEY}\`, never both — nothing says which one covers an interaction`,
      offenders: corpus.documents
        .filter((document) => document.shape === 'both')
        .map(
          (document) => `${document.file}: file-level \`source\` and per-interaction \`source\``,
        ),
    },
    {
      name: 'labels every fixture with exactly one known kind',
      message: `one of ${PROVENANCE_KINDS.join(', ')} under "evidence" or "kind"`,
      offenders: claims
        .filter(
          (claim) =>
            claim.labels.length !== 1 ||
            !(PROVENANCE_KINDS as readonly string[]).includes(claim.label ?? ''),
        )
        .map(describeLabels),
    },
    {
      name: 'cites a vendor documentation URL that SOURCES.md names',
      message: `hosts named in ${SOURCES_FILE}: ${hosts}`,
      offenders: cited
        .filter((claim) => !citesAnAllowedHost(claim, corpus.hosts))
        .map((claim) => `${claim.location}: ${String(claim.url)}`),
    },
    {
      name: 'records the day each cited document was read',
      message: 'YYYY-MM-DD, a real day, not in the future',
      offenders: cited
        .filter((claim) => !isPlausibleRetrievalDate(claim.retrieved, corpus.today))
        .map((claim) => `${claim.location}: ${String(claim.retrieved)}`),
    },
    {
      name: 'makes every fixture that is not plainly documented explain itself',
      message: 'an adapted, composed, inferred or invented fixture needs a note',
      offenders: claims
        .filter((claim) => claim.label !== null && claim.label !== 'documented')
        .filter((claim) => typeof claim.note !== 'string' || claim.note.trim().length === 0)
        .map((claim) => `${claim.location}: ${String(claim.label)} with no note`),
    },
    {
      name: 'lets an invented fixture cite nothing, because there is nothing to cite',
      message: 'an `invented` fixture cites no URL',
      offenders: claims
        .filter((claim) => claim.label === 'invented' && claim.url !== undefined)
        .map((claim) => `${claim.location}: ${String(claim.url)}`),
    },
  ];
};

/** Registers one provider's provenance suite. One `it` per rule, so a failure names the rule. */
export const describeFixtureProvenance = (options: FixtureProvenanceOptions): void => {
  describe(`fixture provenance — ${options.provider}`, () => {
    for (const rule of provenanceRules(readProvenanceCorpus(options))) {
      it(rule.name, () => {
        expect(rule.offenders, rule.message).toEqual([]);
      });
    }
  });
};
