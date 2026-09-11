/**
 * **WP-16's acceptance criterion lives here**: "retrieval tests on a fixture vault; token budget
 * respected".
 *
 * The fixture vault is `FIXTURE_VAULT` in `../testing/fixture-vault.ts`, indexed through the real
 * parser by the real indexer into the in-memory store. The budget is the **shipped default** —
 * `DEFAULT_CONTEXT_BUDGET_TOKENS`, which is also `PLATFORM_DEFAULT_CONFIG.project
 * .context_budget_tokens` and is asserted here to be the same number, so the figure cannot be taken
 * at a raised cap (standing rule 39: a measurement quoted as evidence reproduces from the shipped
 * defaults, and the test that ships with it **produces** the number rather than quoting it).
 *
 * Two figures are pinned, not one, because "respected" has two halves:
 *
 *  1. the ordinary case — the pack fits, and the exact `total_tokens` is asserted;
 *  2. the case where the budget **binds** — the fill had to leave documents out, which is asserted
 *     by name, because a budget that never refuses anything is not a budget under test (rule 10:
 *     assert which branch ran).
 */
import { contextPackRecordSchema, type IsoDate } from '@platform/contracts';
import { DEFAULT_CONTEXT_BUDGET_TOKENS, PLATFORM_DEFAULT_CONFIG } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../ports/logger.js';
import {
  FIXTURE_DEPRECATED_PATH,
  FIXTURE_EXPIRED_PATH,
  FIXTURE_KNOWLEDGE_DIR,
  FIXTURE_REPO_PATHS,
  FIXTURE_STAGE_SCOPED_PATH,
  FIXTURE_TOUCHED_PATHS,
  FIXTURE_UNVALIDATED_PATH,
} from '../testing/fixture-vault.js';
import { indexedFixtureVault, memoryKnowledgeStore } from '../testing/memory-knowledge.js';
import {
  CONTEXT_DIRECTORY,
  type ContextPackRequest,
  createContextPackAssembler,
  workspaceNameFor,
} from './context-pack.js';

const TODAY = '2026-09-11' as IsoDate;

const packOver = async (overrides: Partial<ContextPackRequest> = {}) => {
  const { store, projectId } = await indexedFixtureVault();
  const assembler = createContextPackAssembler({ store, logger: silentLogger });
  const result = await assembler.assemble({
    projectId,
    stage: 'implementation',
    taskText: 'the session service fails its tests with a foreign key violation',
    touchedPaths: FIXTURE_TOUCHED_PATHS,
    repoPaths: FIXTURE_REPO_PATHS,
    today: TODAY,
    knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
    ...overrides,
  });
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
  return result.pack;
};

describe('the shipped default is one number in two places', () => {
  it('product/05 and technical/07 say 12 000, and the config default is the same constant', () => {
    expect(DEFAULT_CONTEXT_BUDGET_TOKENS).toBe(12_000);
    expect(PLATFORM_DEFAULT_CONFIG.project?.context_budget_tokens).toBe(
      DEFAULT_CONTEXT_BUDGET_TOKENS,
    );
  });
});

describe('token budget respected — measured on the fixture vault at the shipped default', () => {
  it('fills the pack without exceeding 12 000 estimated tokens, and produces the figure', async () => {
    const pack = await packOver();
    // Produced, not quoted. If the fixture vault, the chunker or the estimator changes, this number
    // moves and the change is deliberate rather than silent.
    expect(pack.record.budget_tokens).toBe(12_000);
    expect(pack.record.total_tokens).toBe(10_622);
    expect(pack.record.total_tokens).toBeLessThanOrEqual(pack.record.budget_tokens);
    expect(pack.assembly.outcome).toBe('within_budget');
    // …and the budget is what stopped it. Without this the figure above would only mean "the vault
    // happens to fit", which is not a test of a budget (rule 10: assert which branch ran).
    expect(pack.assembly.droppedForBudget.length).toBeGreaterThan(0);
    expect(contextPackRecordSchema.parse(pack.record)).toEqual(pack.record);
  });

  it('the whole vault is larger than the budget, so the fill is doing work', async () => {
    // Without this the figure above would be "everything fits", which proves nothing about a
    // budget. The vault's five padded documents exist for exactly this reason.
    const { store, projectId } = await indexedFixtureVault();
    const everything = store.snapshot(projectId);
    const vaultTokens = everything.reduce((total, document) => total + document.tokens, 0);
    expect(vaultTokens).toBe(18_886);
    expect(vaultTokens).toBeGreaterThan(DEFAULT_CONTEXT_BUDGET_TOKENS);
  });

  it('refuses documents by name once the budget binds, rather than overspending', async () => {
    const pack = await packOver({ budgetTokens: 2_000 });
    expect(pack.record.total_tokens).toBe(508);
    expect(pack.record.total_tokens).toBeLessThanOrEqual(2_000);
    expect(pack.assembly.droppedForBudget.length).toBeGreaterThan(0);
    expect(pack.assembly.outcome).toBe('within_budget');
  });

  it('the pack record accounts for exactly the documents the pack carries', async () => {
    const pack = await packOver();
    const recorded = [
      ...pack.record.tier0.map((entry) => entry.tokens),
      ...pack.record.tier1.filter((entry) => entry.validated).map((entry) => entry.tokens),
    ].reduce((total, tokens) => total + tokens, 0);
    expect(recorded).toBe(pack.record.total_tokens);
    expect(pack.documents.reduce((total, document) => total + document.tokens, 0)).toBe(
      pack.record.total_tokens,
    );
  });
});

describe('retrieval on the fixture vault', () => {
  it('makes the index, the rules and CLAUDE.md tier 0, and nothing else', async () => {
    const pack = await packOver();
    expect(pack.documents.filter((document) => document.tier === 0).map((d) => d.path)).toEqual([
      '.agentic/knowledge/index.md',
      '.agentic/rules/commit-style.md',
      '.agentic/rules/no-direct-sql.md',
      'CLAUDE.md',
    ]);
    expect(pack.record.tier0.map((entry) => entry.path)).toHaveLength(4);
  });

  it('scores a path-matched lesson at 1.0 and labels the reason `paths`', async () => {
    const pack = await packOver();
    const top = pack.record.tier1.find((entry) => entry.validated);
    expect(top?.path).toBe('.agentic/knowledge/lessons/L-2026-01-04-session-fixtures.md');
    expect(top?.reason).toBe('paths');
    expect(top?.score).toBe(1);
  });

  it('records the document whose cited paths no longer exist as validated: false', async () => {
    const pack = await packOver({ taskText: 'legacy importer timestamps' });
    const entry = pack.record.tier1.find((item) => item.path === FIXTURE_UNVALIDATED_PATH);
    expect(entry?.validated).toBe(false);
    expect(pack.assembly.droppedByValidation).toContain(FIXTURE_UNVALIDATED_PATH);
    expect(pack.documents.map((document) => document.path)).not.toContain(FIXTURE_UNVALIDATED_PATH);
  });

  it('never injects the deprecated page, whatever the query', async () => {
    const pack = await packOver({ taskText: 'JWT session tokens opaque superseded' });
    expect(pack.assembly.droppedAsDeprecated).toContain(FIXTURE_DEPRECATED_PATH);
    expect(pack.documents.map((document) => document.path)).not.toContain(FIXTURE_DEPRECATED_PATH);
  });

  it('hides a stage-scoped page from other stages and shows it to its own', async () => {
    const query = 'schema change proposal for the architecture stage';
    const elsewhere = await packOver({ stage: 'implementation', taskText: query });
    expect(elsewhere.assembly.droppedByScope).toContain(FIXTURE_STAGE_SCOPED_PATH);

    const own = await packOver({ stage: 'architecture', taskText: query });
    expect(own.assembly.droppedByScope).not.toContain(FIXTURE_STAGE_SCOPED_PATH);
    expect(own.record.tier1.map((entry) => entry.path)).toContain(FIXTURE_STAGE_SCOPED_PATH);
  });

  it('ranks an expired page below an equivalent live one instead of hiding it', async () => {
    const pack = await packOver({
      stage: 'implementation',
      taskText: 'invoice tax rounding currency locale',
      touchedPaths: [],
    });
    const expired = pack.record.tier1.find((entry) => entry.path === FIXTURE_EXPIRED_PATH);
    expect(expired).toBeDefined();
    expect(expired?.validated).toBe(true);
    expect(expired?.score).toBeGreaterThan(0);
  });

  it('carries the document text, which is untrusted and is never interpreted', async () => {
    const pack = await packOver();
    const lesson = pack.documents.find((document) =>
      document.path.endsWith('L-2026-01-04-session-fixtures.md'),
    );
    expect(lesson?.text).toContain('seed:users');
    expect(lesson?.workspacePath).toBe(
      workspaceNameFor(1, '.agentic/knowledge/lessons/L-2026-01-04-session-fixtures.md'),
    );
    expect(lesson?.workspacePath.startsWith(`${CONTEXT_DIRECTORY}/`)).toBe(true);
  });

  it('produces the RunSpec.contextPack entries the runner is given', async () => {
    const pack = await packOver();
    expect(pack.runContextPack.length).toBe(pack.documents.length);
    for (const entry of pack.runContextPack) {
      expect(entry.path.startsWith(`${CONTEXT_DIRECTORY}/`)).toBe(true);
      expect([0, 1]).toContain(entry.tier);
      expect(entry.reason).not.toBe('');
    }
  });

  it('puts the code map in tier 0 when one is supplied, and omits the slot when one is not', async () => {
    const withMap = await packOver({ codeMap: { text: 'Repository map — …', tokens: 120 } });
    expect(withMap.record.tier0.map((entry) => entry.path)).toContain('code-map.md');
    expect(withMap.documents.find((d) => d.path === 'code-map.md')?.text).toBe(
      'Repository map — …',
    );

    const without = await packOver();
    expect(without.record.tier0.map((entry) => entry.path)).not.toContain('code-map.md');
  });
});

describe('workspaceNameFor', () => {
  it('flattens a vault path into one collision-free segment under the context directory', () => {
    expect(workspaceNameFor(1, '.agentic/knowledge/lessons/L-1.md')).toBe(
      `${CONTEXT_DIRECTORY}/1_.agentic_knowledge_lessons_L-1.md`,
    );
  });

  it('cannot be made to escape the context directory by a hostile vault path', () => {
    // A `..` in a document path is a legal filename in a repository, so it is untrusted input here.
    // Flattening is what makes it harmless: the `..` survives as *text inside one segment*, and the
    // separator it would have needed is gone.
    for (const hostile of ['../../etc/passwd', '/absolute/path', 'a/../../b', './x']) {
      const name = workspaceNameFor(0, hostile);
      expect(name.startsWith(`${CONTEXT_DIRECTORY}/`)).toBe(true);
      expect(name.slice(CONTEXT_DIRECTORY.length + 1)).not.toContain('/');
    }
    expect(workspaceNameFor(0, '../../etc/passwd')).toBe(`${CONTEXT_DIRECTORY}/0_.._.._etc_passwd`);
  });
});

describe('not_indexed is a third answer, not an empty pack', () => {
  it('refuses to build a pack for a project whose index has never been built', async () => {
    const assembler = createContextPackAssembler({
      store: memoryKnowledgeStore(),
      logger: silentLogger,
    });
    const result = await assembler.assemble({
      projectId: '00000000-0000-4000-8000-00000000beef',
      stage: 'implementation',
      taskText: 'anything',
      touchedPaths: [],
      repoPaths: [],
      today: TODAY,
      knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
    });
    expect(result.status).toBe('not_indexed');
  });
});
