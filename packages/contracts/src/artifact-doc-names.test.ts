/**
 * technical/12 § "Artifact schemas" names every artifact type `artifactDataSchemas` publishes, and
 * nothing else (WP-129, PROGRESS backlog 399).
 *
 * The section opens *"`data` per type:"* and reads as complete. It listed eleven of fifteen types
 * until WP-129 — `AskAnswer`, `HistoryFindings`, `ResearchReport` and `TicketBreakdown` had shipped
 * with no line — and WP-117 had closed the same drift for `DiscoveryDraft` one type earlier. So the
 * bold type names that open the section's bullets are compared with the map's keys, **in both
 * directions**: a type added to the map with no line fails, and so does a line for a type the map
 * no longer has.
 *
 * **It checks names only.** Whether a line's fields match its schema — a field added, renamed or
 * made optional — is not read here; that stays the docblock duty each schema carries (*"technical/12
 * lists it — change the two together"*). A field-level comparison would have to parse the page's
 * free-form notation, and a guard that fires on prose gets switched off.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactDataSchemas } from './artifacts.js';

const PAGE = path.resolve(
  import.meta.dirname,
  '../../../docs/technical/12-configuration-and-schemas.md',
);
const HEADING = '## Artifact schemas';

/** The bold names that open the bullets of the section, in page order. */
const documentedTypes = (page: string): string[] => {
  const lines = page.split('\n');
  const start = lines.findIndex((line) => line.startsWith(HEADING));
  if (start === -1) {
    throw new Error(`technical/12 has no "${HEADING}" section`);
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .map((line) => /^- \*\*([A-Za-z]+)\*\*/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
};

/** Both directions, named; empty when the page and the map agree. */
const nameFindings = (page: string, published: readonly string[]): string[] => {
  const documented = documentedTypes(page);
  return [
    ...published
      .filter((name) => !documented.includes(name))
      .map((name) => `${name}: published by artifactDataSchemas, no line in technical/12`),
    ...documented
      .filter((name) => !published.includes(name))
      .map((name) => `${name}: a line in technical/12, not published by artifactDataSchemas`),
    ...documented
      .filter((name, index) => documented.indexOf(name) !== index)
      .map((name) => `${name}: listed twice in technical/12`),
  ];
};

const page = (): string => readFileSync(PAGE, 'utf8');
const published = (): string[] => Object.keys(artifactDataSchemas);

describe('technical/12 § "Artifact schemas" names every artifact type (WP-129)', () => {
  it('lists exactly the types artifactDataSchemas publishes, in both directions', () => {
    expect(nameFindings(page(), published())).toEqual([]);
  });

  it('reads the names off the page rather than an empty section (calibration, standing rule 21)', () => {
    const documented = documentedTypes(page());
    expect(documented).toHaveLength(15);
    expect(documented[0]).toBe('RefinedSpec');
    expect([...documented].sort()).toEqual([...published()].sort());
  });

  describe('canaries', () => {
    it('fails on a fifth missing type — a line removed from the page', () => {
      const without = page().replace(/^- \*\*DiscoveryDraft\*\*.*$/m, '');
      expect(nameFindings(without, published())).toEqual([
        'DiscoveryDraft: published by artifactDataSchemas, no line in technical/12',
      ]);
    });

    it('fails on a type published with no line, and on a line with no type', () => {
      expect(nameFindings(page(), [...published(), 'MigrationPlan'])).toEqual([
        'MigrationPlan: published by artifactDataSchemas, no line in technical/12',
      ]);
      expect(
        nameFindings(
          page(),
          published().filter((name) => name !== 'AskAnswer'),
        ),
      ).toEqual(['AskAnswer: a line in technical/12, not published by artifactDataSchemas']);
    });

    it('fails on the page as it stood before WP-129, naming all four', () => {
      const before = page().replace(
        /^- \*\*(?:AskAnswer|HistoryFindings|ResearchReport|TicketBreakdown)\*\*.*$/gm,
        '',
      );
      expect(nameFindings(before, published())).toEqual(
        ['AskAnswer', 'HistoryFindings', 'ResearchReport', 'TicketBreakdown'].map(
          (name) => `${name}: published by artifactDataSchemas, no line in technical/12`,
        ),
      );
    });
  });
});
