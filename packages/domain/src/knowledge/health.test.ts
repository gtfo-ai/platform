import { describe, expect, it } from 'vitest';
import { computeKbHealth, type HealthDocument, type HealthInputs } from './health.js';

const document = (overrides: Partial<HealthDocument> = {}): HealthDocument => ({
  path: '.agentic/knowledge/lessons/L-1.md',
  expires: null,
  frontmatterId: null,
  tokens: 100,
  ...overrides,
});

const inputs = (overrides: Partial<HealthInputs> = {}): HealthInputs => ({
  documents: [],
  danglingLinks: [],
  ...overrides,
});

const options = { today: '2026-09-12', maxDocumentTokens: 1_000, maxFindings: 100 };

describe('computeKbHealth', () => {
  it('finds nothing in a healthy vault', () => {
    expect(computeKbHealth(inputs({ documents: [document()] }), options)).toEqual({
      findings: [],
      dropped: 0,
    });
  });

  it('reports an expired page from both sides of the date', () => {
    const expired = computeKbHealth(
      inputs({ documents: [document({ expires: '2026-09-11' })] }),
      options,
    );
    expect(expired.findings.map((finding) => finding.kind)).toEqual(['expired']);
    // …and today is not expired: a soft expiry fires the day *after*.
    const today = computeKbHealth(
      inputs({ documents: [document({ expires: '2026-09-12' })] }),
      options,
    );
    expect(today.findings).toEqual([]);
  });

  it('reports an oversized page from both sides of the budget', () => {
    expect(
      computeKbHealth(inputs({ documents: [document({ tokens: 1_000 })] }), options).findings,
    ).toEqual([]);
    expect(
      computeKbHealth(inputs({ documents: [document({ tokens: 1_001 })] }), options).findings.map(
        (finding) => finding.kind,
      ),
    ).toEqual(['oversized']);
  });

  it('reports a dangling link on the page that has it', () => {
    const report = computeKbHealth(
      inputs({
        danglingLinks: [{ fromPath: '.agentic/knowledge/index.md', toPath: 'lessons/gone.md' }],
      }),
      options,
    );
    expect(report.findings).toEqual([
      {
        kind: 'dangling',
        path: '.agentic/knowledge/index.md',
        detail: 'links to lessons/gone.md, which the index does not have',
      },
    ]);
  });

  it('reports both pages of a duplicated id, and ignores pages with no id', () => {
    const report = computeKbHealth(
      inputs({
        documents: [
          document({ path: 'a.md', frontmatterId: 'L-1' }),
          document({ path: 'b.md', frontmatterId: 'L-1' }),
          document({ path: 'c.md', frontmatterId: null }),
          document({ path: 'd.md', frontmatterId: null }),
        ],
      }),
      options,
    );
    expect(report.findings.map((finding) => finding.path)).toEqual(['a.md', 'b.md']);
    expect(report.findings[0]?.detail).toContain('b.md');
  });

  it('caps the findings and says how many it left out', () => {
    const documents = Array.from({ length: 30 }, (_, index) =>
      document({ path: `page-${index}.md`, expires: '2020-01-01' }),
    );
    const report = computeKbHealth(inputs({ documents }), { ...options, maxFindings: 10 });
    expect(report.findings).toHaveLength(10);
    expect(report.dropped).toBe(20);
    // The tail of a kind is what is dropped, not a random sample: the paths are the first ten.
    expect(report.findings[0]?.path).toBe('page-0.md');
  });
});
