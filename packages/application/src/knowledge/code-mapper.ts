/**
 * `CodeMapper` — TD-010 and technical/07 § "Code map (phase 1)", the tier-0 repository map.
 *
 * > `CodeMapper` job per commit: `ctags --output-format=json -R` (definitions), a cheap reference
 * > pass …, symbol graph → personalised PageRank biased toward the task's files → render a 1–4 k
 * > token map (files and their key symbols). Cache tags per blob SHA (`code_files`) and rendered
 * > maps per `(commit, focus_hash, token_budget)` (`code_maps`).
 *
 * ## The result is a union, and that is the point of this module
 *
 * `ctags` is an external binary. It can be absent, or present as a **different program with the
 * same name** — on macOS `/usr/bin/ctags` is BSD ctags, which has no `--output-format=json` and no
 * TypeScript parser at all. Both of those produce zero symbols, and zero symbols renders as a
 * perfectly well-formed map of a repository with no code in it. That map would then occupy tier 0
 * of every code-stage pack for the life of the deployment, costing tokens, telling the agent
 * nothing, and giving nobody a reason to look. It is rule 18's shape with a binary instead of a
 * configuration value.
 *
 * So {@link CodeMapResult} has four members and the caller has to read the tag: `ok`, `cached`,
 * `no_sources` (a repository with no files in a language anyone asked for) and `unavailable` (the
 * extractor could not run, with the probe's own words). `ContextPackRequest.codeMap` is optional
 * precisely so that `unavailable` can be **omitted** from the pack rather than rendered into it.
 *
 * See `docs/OPEN-QUESTIONS.md` Q57 for what the platform must install for this to ever return `ok`
 * in production, and `SymbolExtractor` in `ports.ts` for the probe.
 */
import type { Id } from '@platform/contracts';
import {
  type CodeFileSymbols,
  DEFAULT_CODE_MAP_TOKEN_BUDGET,
  estimateTokens,
  focusHash,
  rankCodeGraph,
  renderCodeMap,
} from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { CodeMapStore, SymbolExtractor } from './ports.js';

export interface CodeMapSource {
  /** Repository-relative path. */
  readonly path: string;
  /** The git blob sha — the `code_files` cache key, so unchanged files are never re-scanned. */
  readonly blobSha: string;
}

export interface CodeMapRequest {
  readonly projectId: Id;
  readonly commitSha: string;
  /** Absolute path of the checkout the extractor scans. */
  readonly rootPath: string;
  readonly sources: readonly CodeMapSource[];
  /** The task's own files — PageRank's personalisation vector (technical/07). */
  readonly focusPaths: readonly string[];
  readonly tokenBudget?: number;
}

export type CodeMapResult =
  | {
      readonly status: 'ok' | 'cached';
      readonly text: string;
      readonly tokens: number;
      readonly filesIncluded: number;
      readonly filesOmitted: number;
      readonly extractorId: string;
    }
  /** Nothing to map: the request named no source files. Not a failure. */
  | { readonly status: 'no_sources' }
  /** The extractor is absent or is the wrong program. Never rendered as an empty map. */
  | { readonly status: 'unavailable'; readonly reason: string };

export interface CodeMapperDependencies {
  readonly extractor: SymbolExtractor;
  readonly store: CodeMapStore;
  readonly unitOfWork: UnitOfWork;
  readonly logger: Logger;
}

export interface CodeMapper {
  build(request: CodeMapRequest): Promise<CodeMapResult>;
}

export const createCodeMapper = (dependencies: CodeMapperDependencies): CodeMapper => ({
  build: async (request: CodeMapRequest): Promise<CodeMapResult> => {
    const tokenBudget = request.tokenBudget ?? DEFAULT_CODE_MAP_TOKEN_BUDGET;
    const key = {
      commitSha: request.commitSha,
      focusHash: focusHash(request.focusPaths),
      tokenBudget,
    };

    const cached = await dependencies.store.readMap(request.projectId, key);
    if (cached !== null) {
      return {
        status: 'cached',
        text: cached,
        tokens: estimateTokens(cached),
        // A cached map's composition is not re-derived: it is the bytes that were rendered, and
        // re-deriving the counts would mean re-running the rank the cache exists to avoid. The
        // line count is what a reader of `code_maps` has; the honest answer is to report the
        // omission count only for a map this call actually built.
        filesIncluded: Math.max(0, cached.split('\n').length - 1),
        filesOmitted: 0,
        extractorId: dependencies.extractor.id,
      };
    }

    if (request.sources.length === 0) return { status: 'no_sources' };

    const probe = await dependencies.extractor.probe();
    if (!probe.available) {
      dependencies.logger.warn(
        {
          project_id: request.projectId,
          extractor: dependencies.extractor.id,
          detail: probe.detail,
        },
        'symbol extractor unavailable; the run gets no repository map',
      );
      return { status: 'unavailable', reason: probe.detail };
    }

    const knownSymbols = await dependencies.store.readSymbols(
      request.projectId,
      request.sources.map((source) => source.blobSha),
    );
    const known = new Map(knownSymbols.map((file) => [file.path, file]));
    const missing = request.sources.filter((source) => !known.has(source.path));

    let extracted: readonly CodeFileSymbols[] = [];
    if (missing.length > 0) {
      const extraction = await dependencies.extractor.extract({
        rootPath: request.rootPath,
        paths: missing.map((source) => source.path),
      });
      if (extraction.status === 'unavailable') {
        // The probe said yes and the extraction said no. Reported with the extraction's reason,
        // never folded into the cached half: a partial map built from whatever happened to be in
        // `code_files` would be a map of the *last* successful run, presented as this one's.
        dependencies.logger.warn(
          { project_id: request.projectId, reason: extraction.reason },
          'symbol extraction failed after a successful probe; the run gets no repository map',
        );
        return { status: 'unavailable', reason: extraction.reason };
      }
      extracted = extraction.files;
      const shaByPath = new Map(missing.map((source) => [source.path, source.blobSha]));
      const entries = extracted.flatMap((file) => {
        const blobSha = shaByPath.get(file.path);
        return blobSha === undefined ? [] : [{ blobSha, file }];
      });
      if (entries.length > 0) {
        await dependencies.unitOfWork.transaction(async (scope) => {
          await dependencies.store.writeSymbols(scope.tx, request.projectId, entries);
        });
      }
    }

    const files = [...known.values(), ...extracted];
    const ranked = rankCodeGraph({ files, focusPaths: request.focusPaths });
    const rendered = renderCodeMap(ranked, tokenBudget);

    await dependencies.unitOfWork.transaction(async (scope) => {
      await dependencies.store.writeMap(scope.tx, request.projectId, key, rendered.text);
    });

    return {
      status: 'ok',
      text: rendered.text,
      tokens: rendered.tokens,
      filesIncluded: rendered.filesIncluded,
      filesOmitted: rendered.filesOmitted,
      extractorId: dependencies.extractor.id,
    };
  },
});
