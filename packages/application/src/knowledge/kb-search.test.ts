import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../ports/logger.js';
import { indexedFixtureVault, memoryKnowledgeStore } from '../testing/memory-knowledge.js';
import {
  createKbSearchTool,
  DEFAULT_SEARCH_LIMIT,
  type KbSearchToolPayload,
  MAX_EXCERPT_CHARS,
  MAX_SEARCH_LIMIT,
} from './kb-search.js';

const payloadOf = (value: unknown): KbSearchToolPayload => value as KbSearchToolPayload;

describe('kb_search — tier 2', () => {
  it('returns path#heading refs, capped excerpts and scores', async () => {
    const { store, projectId } = await indexedFixtureVault();
    const search = createKbSearchTool({ store, logger: silentLogger });
    const payload = payloadOf(await search(projectId, { query: 'seeded fixture user session' }));
    expect(payload.status).toBe('ok');
    expect(payload.hits.length).toBeGreaterThan(0);
    for (const hit of payload.hits) {
      expect(hit.ref).toBe(hit.heading_path === '' ? hit.path : `${hit.path}#${hit.heading_path}`);
      expect(hit.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS + 1);
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
  });

  it('strips the chunk prefix from the excerpt, which the ref already carries', async () => {
    const { store, projectId } = await indexedFixtureVault();
    const search = createKbSearchTool({ store, logger: silentLogger });
    const payload = payloadOf(await search(projectId, { query: 'seed:users foreign-key' }));
    expect(payload.status).toBe('ok');
    const hit = payload.hits[0];
    expect(hit?.excerpt.startsWith('DEMO / ')).toBe(false);
    expect(hit?.ref).toContain('.agentic/knowledge/lessons/');
  });

  it('truncates an over-long excerpt with an ellipsis rather than returning the page', async () => {
    const { store, projectId } = await indexedFixtureVault();
    const search = createKbSearchTool({ store, logger: silentLogger });
    // The padded documents are thousands of characters; product/05 promises 2–3 lines.
    const payload = payloadOf(await search(projectId, { query: 'supervisor heartbeat backoff' }));
    expect(payload.status).toBe('ok');
    expect(payload.hits.length).toBeGreaterThan(0);
    const long = payload.hits.find((hit) => hit.excerpt.endsWith('…'));
    expect(long).toBeDefined();
    expect(long?.excerpt.length).toBe(MAX_EXCERPT_CHARS + 1);
  });

  it('honours the requested limit and caps it at the tool ceiling', async () => {
    const { store, projectId } = await indexedFixtureVault();
    const seen: number[] = [];
    const recording = {
      ...store,
      search: async (request: Parameters<typeof store.search>[0]) => {
        seen.push(request.limit);
        return store.search(request);
      },
    };
    const search = createKbSearchTool({ store: recording, logger: silentLogger });
    await search(projectId, { query: 'session' });
    await search(projectId, { query: 'session', limit: 3 });
    await search(projectId, { query: 'session', limit: 50 });
    expect(seen).toEqual([DEFAULT_SEARCH_LIMIT, 3, MAX_SEARCH_LIMIT]);
  });

  it('answers "not_indexed" rather than "no results" when the index was never built', async () => {
    // An agent told "no results" concludes the knowledge base is silent on the subject. An agent
    // told "not indexed" can say so to a human. The two are different answers (rule 18).
    const search = createKbSearchTool({ store: memoryKnowledgeStore(), logger: silentLogger });
    const payload = payloadOf(
      await search('00000000-0000-4000-8000-0000000000b2' as Id, { query: 'anything' }),
    );
    expect(payload.status).toBe('not_indexed');
    expect(payload.hits).toEqual([]);
  });

  it('answers "ok" with no hits for an indexed vault that has nothing to say', async () => {
    const { store, projectId } = await indexedFixtureVault();
    const search = createKbSearchTool({ store, logger: silentLogger });
    const payload = payloadOf(
      await search(projectId, { query: 'quantum chromodynamics lattice gauge' }),
    );
    expect(payload.status).toBe('ok');
    expect(payload.hits).toEqual([]);
  });

  it('passes a hostile query through as data and never as syntax', async () => {
    // The model writes this. A store that interpolated it would be a query injection; a store that
    // threw on it would turn a model's typo into a failed run (rule 20).
    const { store, projectId } = await indexedFixtureVault();
    const search = createKbSearchTool({ store, logger: silentLogger });
    for (const query of ["' or 1=1 --", 'session & | ! ( )', ' ', '*'.repeat(500)]) {
      const payload = payloadOf(await search(projectId, { query }));
      expect(payload.status).toBe('ok');
    }
  });

  it('builds the answer from typed fields, so a document cannot add or forge a key', async () => {
    const { store, projectId } = await indexedFixtureVault();
    const search = createKbSearchTool({ store, logger: silentLogger });
    const payload = payloadOf(await search(projectId, { query: 'session' }));
    expect(Object.keys(payload).sort()).toEqual(['hits', 'status']);
    for (const hit of payload.hits) {
      expect(Object.keys(hit).sort()).toEqual(['excerpt', 'heading_path', 'path', 'ref', 'score']);
    }
  });
});
