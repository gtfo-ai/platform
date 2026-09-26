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
import { contextPackRecordSchema, type Id, type IsoDate } from '@platform/contracts';
import {
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  isUninformative,
  PLATFORM_DEFAULT_CONFIG,
  termStatisticsOf,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../ports/logger.js';
import {
  FIXTURE_BLIND_NEGATIVE_PATHS,
  FIXTURE_DEPRECATED_PATH,
  FIXTURE_EXPIRED_PATH,
  FIXTURE_HOSTILE_PATH,
  FIXTURE_HOSTILE_PHRASES,
  FIXTURE_KNOWLEDGE_DIR,
  FIXTURE_NEGATIVE_PATHS,
  FIXTURE_REPO_PATHS,
  FIXTURE_STAGE_SCOPED_PATH,
  FIXTURE_TOUCHED_PATHS,
  FIXTURE_UNVALIDATED_PATH,
  FIXTURE_VAULT_WITH_BLIND_NEGATIVES,
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
    // **10 552 at WP-16, 10 556 since WP-17**: `estimateTokens` counts UTF-8 bytes rather than
    // JavaScript characters (PROGRESS backlog 14), so a non-ASCII character now costs what it
    // weighs. The whole +4 is **em dashes** — `index.md` carries six `U+2014` (+12 bytes, +3
    // tokens) and `D-0001-postgres-sessions.md` one (+2 bytes, +1 token). Measured, because
    // WP-17's first comment here blamed the `U+FFFD` of the hostile document and that is false:
    // **the hostile document is not in this pack at all** and the pack contains no `U+FFFD`
    // (rule 39 — a quoted cause must reproduce from the shipped defaults, or the next reviewer
    // mis-diagnoses a genuine move).
    //
    // **11 096 since WP-58.** The negative corpus moved it: four of its pages are admitted — the
    // storefront lesson at 0.429, the browser-storage page at 0.274, the currency page at 0.206,
    // the reporting export at 0.069. Q58's floor as ruled (drop past `N/2 + √N`) drops nothing
    // from this query (`session`, the vault's subject, is in 13 of 23 pages — under the line of
    // 16.3). WP-58's first version dropped at the bare half, lost `session`, and read **11 036**
    // with `technical/billing.md` admitted at 0.080; the architect's ruling is why it no longer
    // does (`PROGRESS.md`, WP-58).
    expect(pack.uninformativeTerms).toEqual([]);
    expect(pack.record.total_tokens).toBe(11_096);
    // …and the same figure is produced against a real PostgreSQL by
    // `test/integration/knowledge/context-pack.integration.test.ts`, which is what stops this
    // number being a property of the in-memory double alone.
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
    // **19 100 at WP-16, 19 124 now**, and the two causes are separate. **+8** is the estimator's
    // unit, and the attribution is the whole vault rather than the pack's share: `index.md` (six
    // `U+2014`, +3), `D-0001-postgres-sessions.md` (one, +1), `D-0002-token-format.md` (one, whose
    // +2 bytes round to **+0** tokens — it is a deprecated page, so it is in the vault and never in
    // a pack), and the hostile document's eight `U+FFFD` (+4). **+16** more is WP-17's review round
    // 1 planting a line of zero-width characters in that hostile document, so the assertion about
    // them could fail (rule 3). Round 2's review re-derived the second number by re-indexing
    // without the planted line: 19 124 → 19 108, and neither pack figure moved.
    //
    // **19 878 since WP-58**: +756 is the negative corpus (six pages), and −2 is the hostile
    // document — its four zero-width characters are now deleted by the sanitiser (−11 bytes,
    // PROGRESS backlog 12) and the fixture line that carries them was reworded to say so (+2
    // bytes): 234 → 232 tokens. 19 124 + 756 − 2.
    expect(vaultTokens).toBe(19_878);
    expect(vaultTokens).toBeGreaterThan(DEFAULT_CONTEXT_BUDGET_TOKENS);
  });

  it('refuses documents by name once the budget binds, rather than overspending', async () => {
    const pack = await packOver({ budgetTokens: 2_000 });
    // 438 at WP-16. The +4 is the same two em-dashed documents as above — `index.md` is tier 0 and
    // `D-0001` is the one tier-1 page a 2 000-token budget still admits.
    //
    // **1 099 since WP-58**: five of the small tier-1 pages a 2 000-token budget can afford are
    // now **negative-corpus** pages, which is the precision residual this work package measured
    // and did not close — at a small budget the wrong answers are the cheap ones. (928 under the
    // first, bare-half floor; the ruled line drops nothing from this query.)
    expect(pack.record.total_tokens).toBe(1_099);
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

describe('precision — what must NOT be in the pack', () => {
  // Every shipped pack assertion in round 1 said *a* document is present or excluded; none said an
  // irrelevant one is absent, so every one of them would have passed a retrieval implementation
  // that returned the whole vault (standing rule 43). These are the negatives.

  it('keeps a billing task away from the session pages, and the reverse', async () => {
    const billing = await packOver({
      taskText: 'Fix the flaky billing invoice tax rounding for EUR',
      touchedPaths: ['src/billing/tax.ts'],
    });
    const billingPaths = billing.documents.map((document) => document.path);
    expect(billingPaths).toContain(`${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2025-06-10-tax-rounding.md`);
    expect(billingPaths).not.toContain(`${FIXTURE_KNOWLEDGE_DIR}/technical/session-service.md`);
    expect(billingPaths).not.toContain(
      `${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2026-01-04-session-fixtures.md`,
    );

    const session = await packOver();
    const sessionPaths = session.documents.map((document) => document.path);
    expect(sessionPaths).toContain(
      `${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2026-01-04-session-fixtures.md`,
    );
    // WP-58's first, bare-half floor dropped `session` and admitted the billing page at 0.080 here;
    // the ruled line (`N/2 + √N`) keeps `session` (13 of 23), and the reverse half holds again.
    expect(session.uninformativeTerms).toEqual([]);
    expect(sessionPaths).not.toContain(`${FIXTURE_KNOWLEDGE_DIR}/technical/billing.md`);
  });

  it('leaves the weak tail of a good query in, which is a recorded decision and not an oversight', () => {
    // `retrieval.ts` records the two measurements that rejected both shapes of a relevance floor:
    // an absolute one is backwards (a stopword outranks a correct answer twenty to one), and a
    // relative one puts the *correct second answer* at 0.667 of the best against PostgreSQL and
    // 0.267 against this double. Nothing here thresholds a **score**; Q58's floor (WP-58) judges
    // query **terms** against the project's own document frequencies, and is asserted in the
    // describe below.
    expect(DEFAULT_CONTEXT_BUDGET_TOKENS).toBe(12_000);
  });

  it('a degenerate query contributes no text candidates at all', async () => {
    // Measured against a real PostgreSQL, `"the"` ranks four padded pages at 0.947 — higher than
    // any real query scores its correct answer. The guard is at the query, not at the score.
    const pack = await packOver({ taskText: 'the', touchedPaths: [] });
    expect(pack.queryTerms).toEqual([]);
    expect(pack.record.tier1).toEqual([]);
    expect(pack.documents.every((document) => document.tier === 0)).toBe(true);
  });

  it('still finds the path-scoped lesson when the query is degenerate', async () => {
    // Fail *closed* on precision, not on recall: an unusable query removes the text step and
    // leaves the author's own `paths:` statement intact.
    const pack = await packOver({ taskText: 'the', touchedPaths: FIXTURE_TOUCHED_PATHS });
    expect(pack.queryTerms).toEqual([]);
    expect(pack.record.tier1.map((entry) => entry.path)).toContain(
      `${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2026-01-04-session-fixtures.md`,
    );
    expect(pack.record.tier1.every((entry) => entry.reason === 'paths')).toBe(true);
  });

  it('extracts keywords rather than sending the ticket text as one AND', async () => {
    const pack = await packOver();
    expect(pack.queryTerms).toEqual([
      'session',
      'service',
      'fails',
      'tests',
      'with',
      'foreign',
      'violation',
    ]);
  });
});

describe('the negative corpus — precision that is capable of failing (WP-58, backlog 16)', () => {
  // Six plausible wrong answers (`FIXTURE_NEGATIVE_CORPUS`): same vocabulary as the hand-written
  // pages, different subject. Until they existed no query here could admit a wrong page, so every
  // precision assertion above was true of the corpus rather than of the retriever (rule 5).
  const textOnly = (taskText: string) => packOver({ taskText, touchedPaths: [] });
  const admittedNegatives = (pack: Awaited<ReturnType<typeof packOver>>): readonly string[] =>
    pack.record.tier1
      .filter((entry) => entry.validated && FIXTURE_NEGATIVE_PATHS.includes(entry.path))
      .map((entry) => entry.path.slice(entry.path.lastIndexOf('/') + 1))
      .sort();

  it('RESIDUAL — admits wrong pages for most retrieval queries, pinned so a precision change is seen', async () => {
    // **The measured red, kept as the instrument's reading** (PROGRESS, WP-58). Seven of these
    // nine queries admit at least one negative page, with or without the floor as ruled — every
    // page below is admitted through a term under the line, a word it shares with the right
    // answer. **The regression the ruling accepts is here**: WP-58's first, bare-half floor
    // dropped `session` and the JWT query then admitted none; the ruled line keeps `session`, and
    // that query's two wrong pages (browser storage, operator training) are back. A precision
    // mechanism that closes any of these moves this table, deliberately.
    const reading: Record<string, readonly string[]> = {};
    for (const query of [
      'the session service fails its tests with a foreign key violation',
      'Fix the flaky billing invoice tax rounding for EUR',
      'seeded fixture user session tests',
      'seed:users foreign-key',
      'legacy importer timestamps',
      'JWT session tokens opaque superseded',
      'schema change proposal for the architecture stage',
      'invoice tax rounding currency locale',
      'notes on untrusted content maintenance mode runbook drain',
    ]) {
      reading[query] = admittedNegatives(await textOnly(query));
    }
    expect(reading).toEqual({
      'the session service fails its tests with a foreign key violation': [
        'L-2025-09-18-storefront-e2e-user.md',
        'currency-conversion.md',
        'reporting-export.md',
        'ui-session-storage.md',
      ],
      'Fix the flaky billing invoice tax rounding for EUR': [
        'currency-conversion.md',
        'reporting-export.md',
      ],
      'seeded fixture user session tests': [
        'L-2025-09-18-storefront-e2e-user.md',
        'operator-training.md',
        'ui-session-storage.md',
      ],
      'seed:users foreign-key': ['L-2025-09-18-storefront-e2e-user.md', 'currency-conversion.md'],
      'legacy importer timestamps': [],
      'JWT session tokens opaque superseded': ['operator-training.md', 'ui-session-storage.md'],
      'schema change proposal for the architecture stage': ['D-0004-audit-log-retention.md'],
      'invoice tax rounding currency locale': ['currency-conversion.md', 'reporting-export.md'],
      'notes on untrusted content maintenance mode runbook drain': [],
    });
  });

  it('RESIDUAL — the thirteen function words of Q58 still fill the pack, five wrong pages in it', async () => {
    // The query backlog 15 measured at 10 707 of 12 000 before the negative corpus existed. None of
    // its words is past the floor line on this vault (`that`, the most common, is in 10 of 23; the
    // line is 16.3), so the floor drops none of them, and it now fills 11 153 of 12 000 with ten tier-1
    // pages, five of them negative. On this repository's own Markdown the same floor (line 92.6 of
    // 160) drops four of the thirteen (`with`, `from`, `that`, `this` — `term-statistics.ts`); the class is narrowed
    // on a real corpus and open on this one, which is what the instrument is for.
    const pack = await textOnly(
      'that this with from have been were will your they able such their',
    );
    expect(pack.termFloor).toBe('applied');
    expect(pack.uninformativeTerms).toEqual([]);
    expect(pack.record.total_tokens).toBe(11_153);
    expect(pack.record.tier1.filter((entry) => entry.validated)).toHaveLength(10);
    expect(admittedNegatives(pack)).toHaveLength(5);
  });

  it('counts document frequency over the stored chunks: 23 pages, `session` in 13', async () => {
    // The numbers every sentence in this describe rests on, produced rather than quoted.
    const { store, projectId } = await indexedFixtureVault();
    const documents = await Promise.all(
      store.snapshot(projectId).map(async (document) => ({
        chunks: await store.loadChunks(document.id),
      })),
    );
    const statistics = termStatisticsOf(documents);
    expect(statistics.documents).toBe(23);
    expect(statistics.frequencies.get('session')).toBe(13);
    expect(statistics.frequencies.get('that')).toBe(10);
    expect(statistics.frequencies.get('with')).toBe(8);
  });

  it('retrieves nothing by text for a query made of the words past the floor line (Q58)', async () => {
    // The floor's own assertion, and the corpus decides the query rather than the test's author:
    // every keyword the index says is past `N/2 + √N`. On this vault that is `demo` alone — the
    // project key the indexer writes onto every chunk, in all 23 — and with the floor disabled (a
    // reverted mutation, WP-58 round 1, when the query was `demo session`) the same query admitted
    // tier-1 pages by text.
    const { store, projectId } = await indexedFixtureVault();
    const documents = await Promise.all(
      store.snapshot(projectId).map(async (document) => ({
        chunks: await store.loadChunks(document.id),
      })),
    );
    const statistics = termStatisticsOf(documents);
    const overHalf = [...statistics.frequencies]
      .filter(([, frequency]) => isUninformative(frequency, statistics.documents))
      .map(([term]) => term)
      .sort();
    expect(overHalf).toEqual(['demo']);

    const pack = await textOnly(overHalf.join(' '));
    expect(pack.queryTerms.slice().sort()).toEqual(overHalf);
    expect(pack.searchedTerms).toEqual([]);
    expect(pack.uninformativeTerms.slice().sort()).toEqual(overHalf);
    expect(pack.record.tier1).toEqual([]);
    expect(pack.documents.every((document) => document.tier === 0)).toBe(true);
  });

  it('keeps an informative term beside the dropped ones, and searches for it alone', async () => {
    const pack = await textOnly('demo drain');
    expect(pack.uninformativeTerms).toEqual(['demo']);
    expect(pack.searchedTerms).toEqual(['drain']);
    expect(pack.record.tier1.map((entry) => entry.path)).toContain(
      `${FIXTURE_KNOWLEDGE_DIR}/technical/runbook.md`,
    );
  });
});

describe('the blind negative corpus — the reading nobody shaped (WP-58, architect ruling)', () => {
  it('RESIDUAL — blind wrong pages ranked inside the pack for seven of nine queries, measured once', async () => {
    // Measured **once**, 2026-09-26, the first time this corpus met a query, under the floor as
    // ruled (the line on 31 pages is 21.1; no query term is past it). Pinned whatever it showed,
    // and nothing — no page, no line, no weight — was edited after it: this is the instrument's
    // reading of a corpus neither the rule's author nor the retriever's author shaped. Seven of the
    // nine queries rank at least one blind page inside the pack; for `legacy importer timestamps`
    // the **only** admitted page is a blind one (the right lesson's glob does not resolve, so it
    // is recorded unvalidated). Scores in `PROGRESS.md` under WP-58.
    const { store, projectId, report } = await indexedFixtureVault({
      documents: FIXTURE_VAULT_WITH_BLIND_NEGATIVES,
    });
    expect(report.documents).toBe(31);
    const assembler = createContextPackAssembler({ store, logger: silentLogger });
    const reading: Record<string, readonly string[]> = {};
    for (const query of [
      'the session service fails its tests with a foreign key violation',
      'Fix the flaky billing invoice tax rounding for EUR',
      'seeded fixture user session tests',
      'seed:users foreign-key',
      'legacy importer timestamps',
      'JWT session tokens opaque superseded',
      'schema change proposal for the architecture stage',
      'invoice tax rounding currency locale',
      'notes on untrusted content maintenance mode runbook drain',
    ]) {
      const result = await assembler.assemble({
        projectId,
        stage: 'implementation',
        taskText: query,
        touchedPaths: [],
        repoPaths: FIXTURE_REPO_PATHS,
        today: TODAY,
        knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
      });
      if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
      expect(result.pack.uninformativeTerms).toEqual([]);
      reading[query] = result.pack.record.tier1
        .filter((entry) => entry.validated && FIXTURE_BLIND_NEGATIVE_PATHS.includes(entry.path))
        .map((entry) => entry.path.slice(entry.path.lastIndexOf('/') + 1))
        .sort();
    }
    expect(reading).toEqual({
      'the session service fails its tests with a foreign key violation': [
        'D-0007-product-image-cache.md',
      ],
      'Fix the flaky billing invoice tax rounding for EUR': ['store-energy-usage.md'],
      'seeded fixture user session tests': ['operator-training-sessions.md'],
      'seed:users foreign-key': [],
      'legacy importer timestamps': ['L-2025-10-27-rota-clock-change.md'],
      'JWT session tokens opaque superseded': [
        'delivery-pallet-tokens.md',
        'operator-training-sessions.md',
      ],
      'schema change proposal for the architecture stage': [
        'L-2025-10-27-rota-clock-change.md',
        'operator-training-sessions.md',
        'shelf-label-printers.md',
        'stock-commitment-rules.md',
      ],
      'invoice tax rounding currency locale': [],
      'notes on untrusted content maintenance mode runbook drain': [
        'D-0007-product-image-cache.md',
        'month-end-till-reconciliation.md',
      ],
    });
  });
});

describe('what a business emphasis changes for a readiness lint (WP-58, backlog 61, criterion 8)', () => {
  // docs/TODO.md's measurement: one lint planned twice over the same vault, under the emphasis it
  // takes since WP-58 (`ticket_lint` → business) and under the one it inherited (technical — which
  // `code_review` has, so the comparison needs no test-only knob). Measured, 2026-09-26: for a
  // business-shaped ticket the **admitted set does not move** (10 pages, 11 142 tokens under both,
  // with the floor as ruled; 8 pages and 9 070 under WP-58's first floor, which dropped `session`)
  // and the **order** does — the business pages double their score and lead the pack.
  const ticket = 'As a store operator I never want to lose work to a session expiry during a shift';
  const lint = (stage: string) => packOver({ stage, taskText: ticket, touchedPaths: [] });
  const admitted = (pack: Awaited<ReturnType<typeof packOver>>) =>
    pack.record.tier1.filter((entry) => entry.validated);

  it('admits the same pages under both emphases, and ranks the business ones first under its own', async () => {
    const business = await lint('ticket_lint');
    const technical = await lint('code_review');
    expect(business.record.total_tokens).toBe(11_142);
    expect(technical.record.total_tokens).toBe(11_142);
    expect(
      admitted(business)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(
      admitted(technical)
        .map((entry) => entry.path)
        .sort(),
    );
    const direction = `${FIXTURE_KNOWLEDGE_DIR}/business/direction.md`;
    expect(admitted(business)[0]?.path).toBe(direction);
    const scoreOf = (pack: Awaited<ReturnType<typeof packOver>>) =>
      admitted(pack).find((entry) => entry.path === direction)?.score ?? 0;
    expect(scoreOf(business)).toBeCloseTo(2 * scoreOf(technical), 10);
  });
});

describe('a hostile document in the pack', () => {
  const hostilePack = () =>
    packOver({ taskText: 'notes on untrusted content maintenance mode runbook drain' });

  it('is indexed like any other page — it is a legal document', async () => {
    const { store, projectId } = await indexedFixtureVault();
    const [document] = await store.loadDocuments(projectId, [FIXTURE_HOSTILE_PATH]);
    expect(document).toBeDefined();
  });

  it('carries its hostile *words* into the pack unchanged, which the prompt delimits', async () => {
    const { store, projectId } = await indexedFixtureVault();
    const [document] = await store.loadDocuments(projectId, [FIXTURE_HOSTILE_PATH]);
    const chunks = await store.loadChunks(document?.id as Id);
    const text = chunks.map((chunk) => chunk.text).join('\n');
    for (const phrase of FIXTURE_HOSTILE_PHRASES) expect(text).toContain(phrase);
  });

  it('carries none of its control characters or bidi overrides', async () => {
    const { store, projectId } = await indexedFixtureVault();
    const [document] = await store.loadDocuments(projectId, [FIXTURE_HOSTILE_PATH]);
    const chunks = await store.loadChunks(document?.id as Id);
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the assertion.
        /[\u{0000}-\u{0008}\u{000B}-\u{001F}\u{007F}-\u{009F}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u,
      );
    }
  });

  it('cannot forge the pack own structure with a line that looks like a chunk prefix', async () => {
    // The hostile page contains `DEMO / .agentic/knowledge/business/direction.md / Direction`.
    // Every path, tier and reason in the record comes from the row, so the forged line is content.
    const pack = await hostilePack();
    for (const entry of pack.record.tier1) {
      expect(pack.documents.some((document) => document.path === entry.path)).toBe(entry.validated);
    }
    const hostile = pack.documents.find((document) => document.path === FIXTURE_HOSTILE_PATH);
    if (hostile !== undefined) {
      expect(hostile.workspacePath).toBe(workspaceNameFor(hostile.tier, FIXTURE_HOSTILE_PATH));
      expect(hostile.reason).not.toContain('direction.md');
    }
  });
});
