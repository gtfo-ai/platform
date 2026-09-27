/**
 * **The Discovery prompt's two tables are held to the platform's own** (WP-64, PROGRESS backlog
 * 216).
 *
 * The prompt carries two tables a model answers against — the readiness criteria it reports and the
 * risk classes it proposes — and the platform has one of each: `READINESS_CRITERIA` and
 * `PROPOSED_RISK_CLASSES`. Backlog 216 was the second drifting: `public_api` joined the platform's
 * table at WP-45 while the prompt kept five rows and told the model a sixth belonged in `questions`,
 * so a class whose paths are the most repository-specific never carried a path a run saw.
 *
 * Here rather than in either package for the reason `role-prompts.contract.test.ts` gives: the
 * dependency rule keeps `@platform/prompts` (contracts only) and `@platform/domain` apart, and the
 * obligation is between them. Both directions, so a row added on either side fails (rule 7's
 * corollary): a class the platform proposes and the prompt does not name, and a class the prompt
 * names and the platform would drop.
 *
 * What it cannot see, stated: whether a model *uses* the table well — that is the eval set's
 * question, and `pnpm eval` cannot run here (the WP-17 blocker).
 */
import { PROPOSED_RISK_CLASSES, READINESS_CRITERIA, WORKSPACE_SETUP_ALLOW } from '@platform/domain';
import { ROLE_PROMPTS } from '@platform/prompts';
import { describe, expect, it } from 'vitest';

const prompt = ROLE_PROMPTS.discovery.text;

/** The first column of the Markdown table that follows `heading`, header and rule excluded. */
const firstColumnAfter = (heading: string): string[] => {
  const start = prompt.indexOf(heading);
  expect(start, `the prompt has a "${heading}" section`).toBeGreaterThanOrEqual(0);
  const lines = prompt.slice(start).split('\n');
  const tableStart = lines.findIndex((line) => line.startsWith('|'));
  const rows: string[] = [];
  for (const line of lines.slice(tableStart + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|')[1]?.trim() ?? '');
  }
  return rows;
};

describe('the Discovery prompt’s tables', () => {
  it('lists exactly the risk classes the platform proposes', () => {
    const named = firstColumnAfter('## Risk classes');
    expect(named.length, 'the table was found and parsed').toBeGreaterThan(0);
    expect([...named].sort()).toEqual(Object.keys(PROPOSED_RISK_CLASSES).sort());
    expect(named).toContain('public_api');
  });

  it('no longer tells the model a sixth class belongs in questions', () => {
    // The sentence backlog 216 quotes; it was false for `public_api` from WP-45 to WP-64.
    expect(prompt).not.toContain('a sixth area you');
  });

  it('asks for exactly the criteria the agent answers, and never R9, R11 or R12', () => {
    const asked = firstColumnAfter('## The readiness assessment');
    const agent = READINESS_CRITERIA.filter((criterion) => criterion.detectedBy === 'agent').map(
      (criterion) => criterion.id,
    );
    expect(asked).toEqual(agent);
    for (const platform of ['R9', 'R11', 'R12']) {
      expect(asked).not.toContain(platform);
    }
  });

  it('names the workspace setup script by the one spelling the verification baseline allows', () => {
    // Backlog 144: the verb exists (`WORKSPACE_SETUP_ALLOW`), and the prompt names it in R6's row
    // and in the list of what may be run — the literal, because any other spelling falls to `ask`.
    for (const entry of WORKSPACE_SETUP_ALLOW) {
      expect(prompt).toContain(`\`${entry}\``);
    }
  });

  it('drafts technical pages only, and says where business pages come from', () => {
    expect(prompt).toContain('Do not draft a page under `business/`');
  });
});
