import type { Id } from '@platform/contracts';
import { type CodeFileSymbols, DEFAULT_CODE_MAP_TOKEN_BUDGET, focusHash } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { fakeSymbolExtractor, memoryCodeMapStore } from '../testing/memory-knowledge.js';
import { type CodeMapRequest, createCodeMapper } from './code-mapper.js';

const PROJECT = '00000000-0000-4000-8000-0000000000c1' as Id;

const SYMBOLS: readonly CodeFileSymbols[] = [
  {
    path: 'src/api/session.ts',
    language: 'ts',
    definitions: [
      { name: 'createSession', kind: 'function', line: 8 },
      { name: 'verifySession', kind: 'function', line: 10 },
    ],
    references: ['randomUUID'],
  },
  {
    path: 'src/api/router.ts',
    language: 'ts',
    definitions: [{ name: 'dispatch', kind: 'function', line: 4 }],
    references: ['createSession', 'verifySession', 'verifySession'],
  },
];

const request = (overrides: Partial<CodeMapRequest> = {}): CodeMapRequest => ({
  projectId: PROJECT,
  commitSha: 'abc1234',
  rootPath: '/tmp/checkout',
  sources: [
    { path: 'src/api/session.ts', blobSha: 'sha-session' },
    { path: 'src/api/router.ts', blobSha: 'sha-router' },
  ],
  focusPaths: ['src/api/router.ts'],
  ...overrides,
});

const mapperWith = (extractor: ReturnType<typeof fakeSymbolExtractor>) => {
  const store = memoryCodeMapStore();
  const eventing = new MemoryEventing();
  return {
    store,
    extractor,
    mapper: createCodeMapper({ extractor, store, unitOfWork: eventing, logger: silentLogger }),
  };
};

describe('CodeMapper — the four outcomes are four different facts', () => {
  it('builds a map from the extracted symbols and caches it', async () => {
    const { mapper, store } = mapperWith(fakeSymbolExtractor({ files: SYMBOLS }));
    const first = await mapper.build(request());
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') throw new Error('expected ok');
    expect(first.text).toContain('src/api/session.ts: verifySession (function)');
    expect(first.filesIncluded).toBe(2);
    expect(first.filesOmitted).toBe(0);
    expect(first.extractorId).toBe('fake');
    expect(store.maps.size).toBe(1);

    const second = await mapper.build(request());
    expect(second.status).toBe('cached');
    if (second.status !== 'cached') throw new Error('expected cached');
    expect(second.text).toBe(first.text);
  });

  it('reuses cached symbols and only extracts the files it has not seen', async () => {
    const { mapper, extractor } = mapperWith(fakeSymbolExtractor({ files: SYMBOLS }));
    await mapper.build(request());
    // A different focus set means a different map key, so the map cache misses …
    await mapper.build(request({ focusPaths: ['src/api/session.ts'] }));
    // … while `code_files` hits, and the extractor is asked for nothing the second time.
    expect(extractor.requests).toHaveLength(1);
    expect([...(extractor.requests[0]?.paths ?? [])].sort()).toEqual([
      'src/api/router.ts',
      'src/api/session.ts',
    ]);
  });

  it('reports `no_sources` for a request that names no files — not an empty map', async () => {
    const { mapper, extractor } = mapperWith(fakeSymbolExtractor({ files: SYMBOLS }));
    const result = await mapper.build(request({ sources: [] }));
    expect(result.status).toBe('no_sources');
    expect(extractor.requests).toHaveLength(0);
  });

  it('reports `unavailable` when the extractor probe refuses, and renders nothing', async () => {
    // This is the branch the real `ctags` adapter takes on a machine with BSD ctags. An empty map
    // would look exactly like a correct map of a repository with no code in it, and would sit in
    // tier 0 for the life of the deployment (rule 18).
    const { mapper, store } = mapperWith(
      fakeSymbolExtractor({
        probe: { available: false, detail: '"ctags" is not universal-ctags (version banner: )' },
      }),
    );
    const result = await mapper.build(request());
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toContain('not universal-ctags');
    expect(store.maps.size).toBe(0);
  });

  it('reports `unavailable` when extraction fails after a probe that succeeded', async () => {
    const { mapper, store } = mapperWith(
      fakeSymbolExtractor({ extractionFailure: 'ctags exited 2: cannot open src/api/session.ts' }),
    );
    const result = await mapper.build(request());
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toContain('exited 2');
    // It does not fall back to whatever happened to be cached: a map of the *last* successful run
    // presented as this one's is worse than no map.
    expect(store.maps.size).toBe(0);
  });

  it('builds a map with no symbols when the extractor genuinely found none', async () => {
    // The distinction that matters: an extractor that ran and found nothing produces `ok`, and it
    // is the *status* — not the emptiness of the text — that tells the two apart.
    const { mapper } = mapperWith(
      fakeSymbolExtractor({
        files: [{ path: 'src/api/session.ts', language: 'ts', definitions: [], references: [] }],
      }),
    );
    const result = await mapper.build(
      request({ sources: [{ path: 'src/api/session.ts', blobSha: 'sha-session' }] }),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.text).toContain('src/api/session.ts');
    expect(result.filesIncluded).toBe(1);
  });
});

describe('CodeMapper — the cache key', () => {
  it('separates maps by focus set and by token budget', async () => {
    const { mapper, store } = mapperWith(fakeSymbolExtractor({ files: SYMBOLS }));
    await mapper.build(request());
    await mapper.build(request({ focusPaths: ['src/api/session.ts'] }));
    await mapper.build(request({ tokenBudget: 50 }));
    expect(store.maps.size).toBe(3);
    expect(
      [...store.maps.keys()].some((key) => key.includes(focusHash(['src/api/router.ts']))),
    ).toBe(true);
    expect([...store.maps.keys()].some((key) => key.endsWith('|50'))).toBe(true);
    expect(
      [...store.maps.keys()].some((key) =>
        key.endsWith(`|${String(DEFAULT_CODE_MAP_TOKEN_BUDGET)}`),
      ),
    ).toBe(true);
  });
});
