/**
 * `SymbolExtractor` on **universal-ctags** — TD-010's phase-1 definition pass, plus the "cheap
 * reference pass" technical/07 pairs it with.
 *
 * ## It probes, and it refuses
 *
 * `ctags` is a name, not a program. On macOS `/usr/bin/ctags` is **BSD ctags**, which has no
 * `--output-format=json`, no `--version`, and no parser for TypeScript, Python or Go; on a stock
 * Ubuntu runner there is usually no `ctags` at all. Both of those would produce zero tags, and zero
 * tags renders as a flawless repository map of a codebase with no code in it — which would then sit
 * in tier 0 of every code-stage context pack, cost tokens, say nothing, and give nobody a reason to
 * look. So {@link createCtagsSymbolExtractor} **probes first**, requires the string
 * `Universal Ctags` in the version banner, and returns `unavailable` with the banner (or the
 * failure) as its reason. `CodeMapper` propagates that; `ContextPackRequest.codeMap` is optional so
 * the pack can omit the map rather than render an empty one.
 *
 * Measured on the machine this was written on: `/usr/bin/ctags --version` exits **1** with
 * `illegal option -- -`, so the probe's refusal is the branch that actually runs here, not a
 * hypothetical one. See `docs/OPEN-QUESTIONS.md` Q57 for what has to be installed, and where.
 *
 * ## The invocation, and why each flag is there
 *
 * ```
 * ctags --output-format=json --fields=+n --sort=no -L - -f -
 * ```
 *
 * - `--output-format=json` is TD-010's own words; each line is one JSON object.
 * - `--fields=+n` adds `line`, which the rendered map needs and which is not on by default.
 * - `-L -` reads the **file list from stdin**. Passing paths as arguments is how a large repository
 *   meets `ARG_MAX`, and a truncated argument list is a silently smaller map (standing rule 72's
 *   neighbourhood: the failure mode of a bulk operation is a partial success nobody notices).
 * - `-f -` writes to stdout instead of creating a `tags` file in the checkout. The workspace is the
 *   agent's; an extractor that leaves a file in it has changed the thing it was reading.
 *
 * The output shape is **recorded**, not assumed: `ctags.test.ts` carries the literal stdout of
 * `Universal Ctags 6.1.0` (alpine 3.20, 2026-09-11) over a two-file fixture, with the command line
 * that produced it. Lines whose `_type` is not `"tag"` — pseudo-tags — are skipped rather than
 * parsed, because the format reserves the key and a future version may start emitting them.
 *
 * ## The reference pass is deliberately crude
 *
 * technical/07 asks for "a cheap reference pass (identifier grep / ast-grep rules for the top
 * languages)" and this is the identifier-grep half: every identifier-shaped token in the file, with
 * comments and string literals left in. It over-counts, and over-counting is the safe direction for
 * a *ranking* signal — a symbol mentioned in a comment really is evidence that the file cares about
 * it. What it must not do is under-count silently, so nothing filters by language: a file the
 * definition pass could not parse still contributes references to files it could.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  SymbolExtractionRequest,
  SymbolExtractionResult,
  SymbolExtractor,
  SymbolExtractorProbe,
} from '@platform/application';
import type { CodeFileSymbols, CodeSymbol } from '@platform/domain';

/** The banner substring that distinguishes universal-ctags from every other `ctags`. */
export const UNIVERSAL_CTAGS_BANNER = 'Universal Ctags';

export const CTAGS_ARGUMENTS: readonly string[] = [
  '--output-format=json',
  '--fields=+n',
  '--sort=no',
  '-L',
  '-',
  '-f',
  '-',
];

/** Identifier-shaped tokens: what the reference pass counts. */
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Tokens excluded from the reference pass.
 *
 * Not a language keyword list — that would be a hand-maintained scope that drifts per language
 * (rule 7). It is a *length* floor plus the handful of tokens that appear in every file of every
 * language the platform has seen, and its only effect is on ranking noise. A keyword that slips
 * through can only match a symbol somebody actually defined with that name.
 */
const MIN_IDENTIFIER_LENGTH = 3;

export interface CtagsProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The one seam: everything that is not a process launch is testable without a binary. */
export interface CtagsProcessRunner {
  run(
    binary: string,
    args: readonly string[],
    options: { readonly cwd?: string; readonly input?: string },
  ): Promise<CtagsProcessResult>;
}

export const nodeCtagsProcessRunner: CtagsProcessRunner = {
  run: (binary, args, options) =>
    new Promise<CtagsProcessResult>((resolve, reject) => {
      const child = spawn(binary, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    }),
};

/** One `{"_type": "tag", …}` line of `--output-format=json`. */
interface CtagsJsonTag {
  readonly _type?: unknown;
  readonly name?: unknown;
  readonly path?: unknown;
  readonly line?: unknown;
  readonly kind?: unknown;
  readonly language?: unknown;
}

/**
 * Parses ctags' NDJSON.
 *
 * Every field is checked rather than trusted: this is a subprocess whose output crosses a boundary,
 * a line can be truncated if the process is killed mid-write, and a tag with no `name` is not a tag
 * with the name `undefined`. A malformed line is skipped and counted, and the count is what the
 * caller sees if *every* line was malformed — which is the difference between "this repository has
 * no symbols" and "we could not read the output".
 */
export const parseCtagsJson = (
  stdout: string,
): { readonly definitions: ReadonlyMap<string, CodeSymbol[]>; readonly skipped: number } => {
  const definitions = new Map<string, CodeSymbol[]>();
  let skipped = 0;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: CtagsJsonTag;
    try {
      parsed = JSON.parse(trimmed) as CtagsJsonTag;
    } catch {
      skipped += 1;
      continue;
    }
    // Pseudo-tags (`_type: "ptag"`) carry the tag file's own metadata, not a symbol.
    if (parsed._type !== 'tag') continue;
    if (
      typeof parsed.name !== 'string' ||
      typeof parsed.path !== 'string' ||
      typeof parsed.kind !== 'string'
    ) {
      skipped += 1;
      continue;
    }
    const symbol: CodeSymbol = {
      name: parsed.name,
      kind: parsed.kind,
      // `--fields=+n` supplies it; a build that does not is a symbol at line 0, never `NaN`
      // (rule 16 — a missing number is not zero, so it is named rather than defaulted silently).
      line: typeof parsed.line === 'number' ? parsed.line : 0,
    };
    const existing = definitions.get(parsed.path);
    if (existing === undefined) definitions.set(parsed.path, [symbol]);
    else existing.push(symbol);
  }
  return { definitions, skipped };
};

export const referencesIn = (source: string): readonly string[] =>
  (source.match(IDENTIFIER) ?? []).filter((token) => token.length >= MIN_IDENTIFIER_LENGTH);

export interface CtagsExtractorOptions {
  /** Overridden by `APP_CTAGS_BINARY`; `ctags` on the PATH otherwise. */
  readonly binary?: string;
  readonly runner?: CtagsProcessRunner;
}

export const createCtagsSymbolExtractor = (
  options: CtagsExtractorOptions = {},
): SymbolExtractor => {
  const binary = options.binary ?? 'ctags';
  const runner = options.runner ?? nodeCtagsProcessRunner;

  const probe = async (): Promise<SymbolExtractorProbe> => {
    let result: CtagsProcessResult;
    try {
      result = await runner.run(binary, ['--version'], {});
    } catch (cause) {
      return { available: false, detail: `cannot run "${binary}": ${(cause as Error).message}` };
    }
    const banner = `${result.stdout}${result.stderr}`.split('\n')[0]?.trim() ?? '';
    if (result.code !== 0) {
      return {
        available: false,
        detail: `"${binary} --version" exited ${String(result.code)}: ${banner}`,
      };
    }
    if (!banner.includes(UNIVERSAL_CTAGS_BANNER)) {
      return {
        available: false,
        detail: `"${binary}" is not universal-ctags (version banner: ${banner})`,
      };
    }
    return { available: true, detail: banner };
  };

  return {
    id: 'universal-ctags',
    probe,
    extract: async (request: SymbolExtractionRequest): Promise<SymbolExtractionResult> => {
      if (request.paths.length === 0) return { status: 'ok', files: [] };

      let result: CtagsProcessResult;
      try {
        result = await runner.run(binary, CTAGS_ARGUMENTS, {
          cwd: request.rootPath,
          input: `${request.paths.join('\n')}\n`,
        });
      } catch (cause) {
        return {
          status: 'unavailable',
          reason: `ctags failed to start: ${(cause as Error).message}`,
        };
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim().split('\n')[0] ?? '';
        return {
          status: 'unavailable',
          reason: `ctags exited ${String(result.code)}: ${detail}`,
        };
      }

      const { definitions, skipped } = parseCtagsJson(result.stdout);
      if (definitions.size === 0 && skipped > 0) {
        // Every line was unreadable. That is a broken extractor, not a repository without symbols,
        // and the two must not produce the same map.
        return {
          status: 'unavailable',
          reason: `ctags produced ${String(skipped)} lines and none could be parsed`,
        };
      }

      const files: CodeFileSymbols[] = [];
      for (const relative of request.paths) {
        let source: string;
        try {
          source = await readFile(path.join(request.rootPath, relative), 'utf8');
        } catch {
          // A file ctags listed but this process cannot read contributes its definitions and no
          // references, rather than taking the whole extraction down: the reference pass is a
          // ranking refinement, the definitions are the graph.
          files.push({
            path: relative,
            language: null,
            definitions: definitions.get(relative) ?? [],
            references: [],
          });
          continue;
        }
        files.push({
          path: relative,
          language: path.extname(relative).replace('.', '') || null,
          definitions: definitions.get(relative) ?? [],
          references: referencesIn(source),
        });
      }
      return { status: 'ok', files };
    },
  };
};
