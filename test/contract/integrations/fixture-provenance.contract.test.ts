/**
 * Every provider's HTTP fixtures, held to their own `source` blocks.
 *
 * The directories are discovered from disk rather than listed here (standing rule 7): a new
 * provider's fixtures are checked the moment they exist, and a provider that ships fixtures
 * without a `SOURCES.md` fails loudly instead of silently opting out. `fixture-provenance.ts` says
 * exactly what these assertions can and cannot prove, and why `SOURCES.md` is required of both
 * fixture shapes.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  describeFixtureProvenance,
  type ProvenanceRule,
  provenanceRules,
  readFixtureDocuments,
  readProvenanceCorpus,
} from '../support/integrations/fixture-provenance.js';

const FIXTURE_ROOT = new URL('../../fixtures/http/', import.meta.url);

const providers = readdirSync(FIXTURE_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('http fixtures', () => {
  it('finds the provider directories on disk, rather than a list somebody maintains', () => {
    expect(providers, 'test/fixtures/http/ holds no provider directory').not.toEqual([]);
  });

  it('holds nothing but provider directories, so no fixture can sit outside one', () => {
    // A file dropped straight into `test/fixtures/http/` would belong to no provider and would
    // therefore be checked by nobody — the same blind spot as a fixture in a subdirectory, one
    // level up.
    const strays = readdirSync(FIXTURE_ROOT, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name);
    expect(strays, 'move it into its provider directory').toEqual([]);
  });
});

/**
 * The discovery itself, on a corpus this test builds.
 *
 * Review round 2 planted unlabelled fixtures in a subdirectory and under a non-`.json` extension
 * and **the suite passed**, because discovery read one level and filtered on `.json`. The rules
 * above are only as good as the file list they run on, so the file list gets its own test — with
 * exactly the two shapes the reviewer used.
 */
describe('fixture discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-provenance-'));
  const documented = {
    source: { kind: 'documented', url: 'https://example.test/x', retrieved: '2026-01-01' },
  };
  mkdirSync(join(root, 'webhooks'));
  writeFileSync(join(root, 'SOURCES.md'), '# sources\n\nhttps://developer.atlassian.com/x\n');
  writeFileSync(join(root, 'top-level.json'), JSON.stringify(documented));
  writeFileSync(join(root, 'webhooks', 'planted.json'), JSON.stringify({ id: 'no source block' }));
  writeFileSync(join(root, 'planted.jsonc'), '// a comment\n{"id": "no source block"}\n');
  writeFileSync(join(root, '.DS_Store'), 'not a fixture');
  writeFileSync(join(root, '.hidden.json'), JSON.stringify({ id: 'no source block' }));
  const documents = readFixtureDocuments(pathToFileURL(`${root}/`));
  const documentAt = (file: string) => documents.find((document) => document.file === file);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walks subdirectories, whatever the extension, and skips only SOURCES.md', () => {
    expect(documents.map((document) => document.file)).toEqual([
      '.hidden.json',
      'planted.jsonc',
      'top-level.json',
      'webhooks/planted.json',
    ]);
  });

  it('reports a fixture in a subdirectory as having no source block', () => {
    const planted = documentAt('webhooks/planted.json');
    expect(planted?.shape).toBe('neither');
    expect(
      planted?.claims[0]?.source,
      'this is what fails the "gives every fixture a source block" rule',
    ).toBeNull();
  });

  it('reports a fixture whose extension is not .json, even when it is not parseable JSON', () => {
    const planted = documentAt('planted.jsonc');
    expect(planted?.claims[0]?.source).toBeNull();
    expect(planted?.claims[0]?.label, 'no label either').toBeNull();
  });

  it('reads the block of a fixture that has one', () => {
    // Control (standing rule 4): discovery that returned nothing usable would satisfy every
    // assertion above.
    const found = documentAt('top-level.json');
    expect(found?.shape).toBe('file');
    expect(found?.claims[0]?.label).toBe('documented');
    expect(found?.claims[0]?.retrieved).toBe('2026-01-01');
  });

  it('skips the artefacts an operating system writes, and nothing else', () => {
    expect(documents.map((document) => document.file)).not.toContain('.DS_Store');
    expect(readdirSync(root), 'the artefact really is on disk').toContain('.DS_Store');
    // "and nothing else": a dot-file that is not one of the two named artefacts is a fixture, and
    // hiding is not an exemption from provenance.
    expect(documents.map((document) => document.file)).toContain('.hidden.json');
  });
});

/**
 * The rules themselves, mutated.
 *
 * WP-08 hardened this suite by planting fixtures rather than by reading it, and that is what found
 * the discovery hole. The per-interaction shape doubles the surface — a claim can now be missing,
 * mislabelled or vacuous *inside* a file that looks fine from the outside — so each way of getting
 * it wrong is planted here and matched against **the rule that is supposed to catch it**, not
 * merely against "something failed" (standing rule 3, and rule 21: an instrument that reports a
 * red suite without saying which assertion went red measures nothing).
 */
describe('provenance rules, against planted corpora', () => {
  /** A real documentation host: every reserved domain is denied by design, so a synthetic corpus
   * still has to cite a plausible one. The corpus is fake; the host is not. */
  const HOST = 'https://docs.gitlab.com';
  const SOURCES = `# sources\n\n- ${HOST}/api/ — retrieved 2026-05-01\n`;
  const TODAY = new Date('2026-06-01T00:00:00.000Z');
  const good = (path = '/api/version/') => ({
    url: `${HOST}${path}`,
    retrieved: '2026-05-01',
    kind: 'documented',
  });
  /** The request half of a recorded interaction: everything except its provenance. */
  const interaction = () => ({ method: 'GET', path: '/version', status: 200 });

  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** Writes a corpus and evaluates every rule over it. `sources: null` omits `SOURCES.md`. */
  const plant = (
    files: Readonly<Record<string, unknown>>,
    sources: string | null = SOURCES,
  ): readonly ProvenanceRule[] => {
    const root = mkdtempSync(join(tmpdir(), 'provenance-rules-'));
    roots.push(root);
    if (sources !== null) {
      writeFileSync(join(root, 'SOURCES.md'), sources);
    }
    for (const [file, document] of Object.entries(files)) {
      writeFileSync(
        join(root, file),
        typeof document === 'string' ? document : JSON.stringify(document, null, 2),
      );
    }
    return provenanceRules(
      readProvenanceCorpus({
        provider: 'planted',
        directory: pathToFileURL(`${root}/`),
        today: TODAY,
      }),
    );
  };

  const failures = (rules: readonly ProvenanceRule[]) =>
    rules.filter((rule) => rule.offenders.length > 0);
  const failedNames = (rules: readonly ProvenanceRule[]) =>
    failures(rules).map((rule) => rule.name);
  const offendersOf = (rules: readonly ProvenanceRule[], name: string) =>
    rules.find((rule) => rule.name === name)?.offenders ?? ['<no such rule>'];

  const MISSING_BLOCK = 'gives every fixture a source block, on the file or on every interaction';
  const VACUOUS = 'lets no document claim provenance vacuously';
  const ONE_SHAPE = 'keeps every document to one provenance shape';
  const ONE_KIND = 'labels every fixture with exactly one known kind';
  const CITED_HOST = 'cites a vendor documentation URL that SOURCES.md names';
  const RETRIEVED = 'records the day each cited document was read';
  const CORPUS = 'has fixtures to check, and a SOURCES.md naming where they came from';

  it('passes a corpus that uses either shape, which is the control every mutation below needs', () => {
    // Rule 4: a rule set that failed everything would "catch" every mutation and prove nothing.
    const rules = plant({
      'per-file.json': { source: good(), body: { version: '18.1.1-ee' } },
      'per-interaction.json': {
        interactions: [
          { ...interaction(), source: good('/api/version/') },
          { ...interaction(), source: good('/api/projects/') },
          {
            ...interaction(),
            source: { ...good('/api/rest/troubleshooting/'), kind: 'inferred', note: 'assumed' },
          },
        ],
      },
    });
    expect(failedNames(rules), 'both shapes are legal and this corpus is honest').toEqual([]);
  });

  it('fails an interactions file where three of seven carry a source, and names the four that do not', () => {
    const rules = plant({
      'partial.json': {
        interactions: [
          { ...interaction(), source: good() },
          { ...interaction(), source: good() },
          { ...interaction(), source: good() },
          interaction(),
          interaction(),
          interaction(),
          interaction(),
        ],
      },
    });
    expect(offendersOf(rules, MISSING_BLOCK)).toEqual([
      'partial.json#interactions[3]',
      'partial.json#interactions[4]',
      'partial.json#interactions[5]',
      'partial.json#interactions[6]',
    ]);
  });

  it('fails an interactions file with a single source missing, at the index that is missing it', () => {
    const rules = plant({
      'one-missing.json': {
        interactions: [
          { ...interaction(), source: good() },
          interaction(),
          { ...interaction(), source: good() },
        ],
      },
    });
    expect(offendersOf(rules, MISSING_BLOCK)).toEqual(['one-missing.json#interactions[1]']);
    // One defect, two rules: a claim with no block has no label and no date either, so it is named
    // by those rules as well. The block rule is the one that says what to do about it.
    expect(offendersOf(rules, ONE_KIND)).toEqual(['one-missing.json#interactions[1]: no label']);
  });

  it('fails an empty interactions list, which would otherwise satisfy every rule by vacuity', () => {
    const rules = plant({
      'empty.json': { interactions: [] },
      'per-file.json': { source: good(), body: {} },
    });
    // The point of the case: without the vacuity rule this corpus is **green**, because a document
    // with no claims offends no claim-shaped rule (standing rule 4).
    expect(failedNames(rules)).toEqual([VACUOUS]);
    expect(offendersOf(rules, VACUOUS)).toEqual(['empty.json: interactions: []']);
  });

  it('fails a kind outside the vocabulary in the nested shape', () => {
    const rules = plant({
      'bad-kind.json': {
        interactions: [{ ...interaction(), source: { ...good(), kind: 'recorded' } }],
      },
    });
    expect(offendersOf(rules, ONE_KIND)).toEqual(['bad-kind.json#interactions[0]: kind']);
  });

  it('fails two labels on one nested claim, because a fixture has one kind of evidence', () => {
    const rules = plant({
      'two-labels.json': {
        interactions: [{ ...interaction(), source: { ...good(), evidence: 'documented' } }],
      },
    });
    expect(offendersOf(rules, ONE_KIND)).toEqual([
      'two-labels.json#interactions[0]: evidence+kind',
    ]);
  });

  it('fails a future retrieved date in the nested shape', () => {
    const rules = plant({
      'future.json': {
        interactions: [
          { ...interaction(), source: { ...good(), retrieved: '2026-06-02' } },
          { ...interaction(), source: { ...good(), retrieved: '2026-02-30' } },
        ],
      },
    });
    expect(offendersOf(rules, RETRIEVED)).toEqual([
      'future.json#interactions[0]: 2026-06-02',
      'future.json#interactions[1]: 2026-02-30',
    ]);
  });

  it('fails a nested url on a reserved domain, and one on a host SOURCES.md does not name', () => {
    const rules = plant({
      'hosts.json': {
        interactions: [
          { ...interaction(), source: { ...good(), url: 'https://example.invalid/api/' } },
          {
            ...interaction(),
            source: { ...good(), url: 'https://gitlab-tips.blogspot.com/api/' },
          },
          { ...interaction(), source: { ...good(), url: `http://docs.gitlab.com/api/` } },
        ],
      },
    });
    expect(offendersOf(rules, CITED_HOST)).toEqual([
      'hosts.json#interactions[0]: https://example.invalid/api/',
      'hosts.json#interactions[1]: https://gitlab-tips.blogspot.com/api/',
      'hosts.json#interactions[2]: http://docs.gitlab.com/api/',
    ]);
  });

  it('fails a nested claim that is not plainly documented and explains nothing', () => {
    const rules = plant({
      'unexplained.json': {
        interactions: [{ ...interaction(), source: { ...good(), kind: 'inferred' } }],
      },
    });
    expect(
      offendersOf(rules, 'makes every fixture that is not plainly documented explain itself'),
    ).toEqual(['unexplained.json#interactions[0]: inferred with no note']);
  });

  it('fails a fixture that is neither shape, and one that is not JSON at all', () => {
    const rules = plant({
      'neither.json': { id: 7, body: { version: '18.1.1-ee' } },
      'array.json': [{ source: good() }],
      'notes.txt': 'a job log, with nowhere to put a source block',
    });
    expect(offendersOf(rules, MISSING_BLOCK)).toEqual(['array.json', 'neither.json', 'notes.txt']);
  });

  it('refuses a document that carries both shapes, rather than picking one', () => {
    const rules = plant({
      'both.json': {
        source: good(),
        interactions: [{ ...interaction(), source: good('/api/projects/') }],
      },
    });
    expect(offendersOf(rules, ONE_SHAPE)).toEqual([
      'both.json: file-level `source` and per-interaction `source`',
    ]);
  });

  it('fails a provider directory with no SOURCES.md, whichever shape its fixtures use', () => {
    const rules = plant(
      {
        'per-interaction.json': {
          interactions: [{ ...interaction(), source: good() }],
        },
      },
      null,
    );
    expect(offendersOf(rules, CORPUS)).toEqual(['SOURCES.md is missing']);
    // And with the allow-list gone, the citation it would have licensed fails too: this is the
    // second job `SOURCES.md` does, and why a synthesised union is not a substitute.
    expect(failedNames(rules)).toContain(CITED_HOST);
  });

  it('fails an empty provider directory and a SOURCES.md that names no host', () => {
    expect(offendersOf(plant({}, '# sources\n\nnothing yet\n'), CORPUS)).toEqual([
      'the directory holds no fixture',
      'SOURCES.md names no documentation URL',
    ]);
    // Reserved domains are stripped before the allow-list is built, so prose that only mentions
    // `example.invalid` (as jira-cloud's does, while explaining this very defect) names no host.
    expect(offendersOf(plant({}, '# sources\n\nhttps://example.invalid/x\n'), CORPUS)).toEqual([
      'the directory holds no fixture',
      'SOURCES.md names no documentation URL',
    ]);
  });
});

for (const provider of providers) {
  describeFixtureProvenance({ provider, directory: new URL(`${provider}/`, FIXTURE_ROOT) });
}
