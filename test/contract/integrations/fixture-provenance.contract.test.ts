/**
 * Every provider's HTTP fixtures, held to their own `source` blocks.
 *
 * The directories are discovered from disk rather than listed here (standing rule 7): a new
 * provider's fixtures are checked the moment they exist, and a provider that ships fixtures
 * without a `SOURCES.md` fails loudly instead of silently opting out. `fixture-provenance.ts` says
 * exactly what these assertions can and cannot prove.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  describeFixtureProvenance,
  readFixtureProvenance,
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
  const fixtures = readFixtureProvenance(pathToFileURL(`${root}/`));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walks subdirectories, whatever the extension, and skips only SOURCES.md', () => {
    expect(fixtures.map((fixture) => fixture.file)).toEqual([
      '.hidden.json',
      'planted.jsonc',
      'top-level.json',
      'webhooks/planted.json',
    ]);
  });

  it('reports a fixture in a subdirectory as having no source block', () => {
    const planted = fixtures.find((fixture) => fixture.file === 'webhooks/planted.json');
    expect(
      planted?.source,
      'this is what fails the "gives every fixture a source block" rule',
    ).toBeNull();
  });

  it('reports a fixture whose extension is not .json, even when it is not parseable JSON', () => {
    const planted = fixtures.find((fixture) => fixture.file === 'planted.jsonc');
    expect(planted?.source).toBeNull();
    expect(planted?.label, 'no label either').toBeNull();
  });

  it('reads the block of a fixture that has one', () => {
    // Control (standing rule 4): discovery that returned nothing usable would satisfy every
    // assertion above.
    const found = fixtures.find((fixture) => fixture.file === 'top-level.json');
    expect(found?.label).toBe('documented');
    expect(found?.retrieved).toBe('2026-01-01');
  });

  it('skips the artefacts an operating system writes, and nothing else', () => {
    expect(fixtures.map((fixture) => fixture.file)).not.toContain('.DS_Store');
    expect(readdirSync(root), 'the artefact really is on disk').toContain('.DS_Store');
    // "and nothing else": a dot-file that is not one of the two named artefacts is a fixture, and
    // hiding is not an exemption from provenance.
    expect(fixtures.map((fixture) => fixture.file)).toContain('.hidden.json');
  });
});

for (const provider of providers) {
  describeFixtureProvenance({ provider, directory: new URL(`${provider}/`, FIXTURE_ROOT) });
}
