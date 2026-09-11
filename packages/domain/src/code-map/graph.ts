/**
 * The repository map's symbol graph and its personalised PageRank — TD-010, technical/07
 * § "Code map (phase 1)":
 *
 * > definitions … plus a cheap reference pass …, symbol graph → personalised PageRank biased
 * > toward the task's files → render a 1–4 k token map (files and their key symbols).
 *
 * Pure arithmetic over definitions and references somebody else extracted. The extractor is a port
 * (`SymbolExtractor` in `@platform/application`) precisely so that this ring never learns whether
 * the symbols came from `ctags`, from a language server, or from a fixture — and so that "no
 * extractor is available" is a fact the caller has to handle rather than an empty graph that looks
 * like a repository with no code in it.
 *
 * **What the ranking actually models.** A file that *references* a symbol votes for the file that
 * *defines* it. A symbol defined in many files (`index`, `create`, `run`) is weak evidence, so its
 * vote is divided by the number of definers; a symbol referenced many times from one file is
 * stronger evidence, so the vote grows — with `sqrt`, not linearly, because a file that mentions
 * `logger` two hundred times is not two hundred times more coupled to it. Both damping choices come
 * from aider's RepoMap, which TD-010 names as the design this reimplements.
 *
 * **Personalisation is the whole point.** An unpersonalised PageRank returns the repository's most
 * central files, which is the "generic repository overview" product/05 § "Curated, not dumped" says
 * costs tokens without improving results. Biasing the restart distribution toward the task's own
 * files is what turns it into a map *of this task's neighbourhood*.
 */

export interface CodeSymbol {
  readonly name: string;
  /** ctags' kind letter or word (`function`, `class`, `method`, …); opaque to the ranking. */
  readonly kind: string;
  readonly line: number;
}

export interface CodeFileSymbols {
  readonly path: string;
  readonly language: string | null;
  readonly definitions: readonly CodeSymbol[];
  /** Identifier occurrences in this file, one entry per occurrence (repeats are the signal). */
  readonly references: readonly string[];
}

export interface RankedSymbol {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  /** How many *other* files reference this name. Zero means "defined here, used nowhere else". */
  readonly externalReferences: number;
}

export interface RankedFile {
  readonly path: string;
  readonly rank: number;
  /** The file's definitions, most-referenced first, then by line — deterministic either way. */
  readonly symbols: readonly RankedSymbol[];
}

/** PageRank's damping factor; 0.85 is the value the algorithm is published with. */
export const DAMPING = 0.85;

/**
 * Power-iteration bounds.
 *
 * An iteration count, not a wall clock: rule 2 — a time bound on a CPU-bound loop is a statement
 * about the machine, and this one runs inside a job on a runner whose load the platform does not
 * control. Convergence to `1e-6` takes well under 40 iterations at this damping for any graph the
 * repository map builds; the cap is what makes the function total.
 */
export const MAX_ITERATIONS = 100;
export const CONVERGENCE_TOLERANCE = 1e-6;

interface Edge {
  readonly to: number;
  readonly weight: number;
}

/**
 * Builds the weighted directed graph and returns, per file index, its outgoing edges.
 *
 * Self-references are dropped: a file referencing its own definitions says nothing about coupling
 * and would give every large file a rank floor of its own making.
 */
const buildEdges = (files: readonly CodeFileSymbols[]): readonly (readonly Edge[])[] => {
  const definers = new Map<string, number[]>();
  files.forEach((file, index) => {
    for (const definition of file.definitions) {
      const existing = definers.get(definition.name);
      if (existing === undefined) definers.set(definition.name, [index]);
      else if (existing.at(-1) !== index) existing.push(index);
    }
  });

  return files.map((file, from) => {
    const counts = new Map<string, number>();
    for (const reference of file.references) {
      if (!definers.has(reference)) continue;
      counts.set(reference, (counts.get(reference) ?? 0) + 1);
    }
    const weights = new Map<number, number>();
    for (const [name, occurrences] of counts) {
      const targets = definers.get(name) as number[];
      // A symbol every file defines is a weak signal; one defined once is a strong one.
      const share = Math.sqrt(occurrences) / targets.length;
      for (const to of targets) {
        if (to === from) continue;
        weights.set(to, (weights.get(to) ?? 0) + share);
      }
    }
    return [...weights].map(([to, weight]): Edge => ({ to, weight }));
  });
};

/**
 * External reference counts per `(file, symbol)` — how the symbols inside a file are ordered, and
 * the reason a purely local helper never displaces the API other files actually call.
 */
const externalReferenceCounts = (
  files: readonly CodeFileSymbols[],
): ReadonlyMap<string, number> => {
  const total = new Map<string, number>();
  const perFile = files.map((file) => {
    const counts = new Map<string, number>();
    for (const reference of file.references)
      counts.set(reference, (counts.get(reference) ?? 0) + 1);
    return counts;
  });
  files.forEach((file, index) => {
    for (const definition of file.definitions) {
      let outside = 0;
      perFile.forEach((counts, other) => {
        if (other === index) return;
        outside += counts.get(definition.name) ?? 0;
      });
      total.set(`${file.path}\0${definition.name}`, outside);
    }
  });
  return total;
};

export interface RankCodeGraphInput {
  readonly files: readonly CodeFileSymbols[];
  /**
   * The task's own files — the personalisation vector's support. Paths not present in `files` are
   * ignored, and a focus set that matches nothing falls back to a uniform restart, which is stated
   * here rather than left to arithmetic: an empty personalisation vector makes the power iteration
   * diverge to zero and every rank would be equal *and* meaningless.
   */
  readonly focusPaths: readonly string[];
}

/**
 * Personalised PageRank over the symbol graph, highest rank first.
 *
 * Ties break on path so the rendered map is byte-identical for identical input — the map is cached
 * by `(commit, focus_hash, token_budget)` (technical/03 `code_maps`) and a cache whose value
 * depends on `Map` iteration order is a cache that never hits.
 */
export const rankCodeGraph = (input: RankCodeGraphInput): readonly RankedFile[] => {
  const { files } = input;
  if (files.length === 0) return [];

  const edges = buildEdges(files);
  const index = new Map(files.map((file, at) => [file.path, at]));
  const focus = input.focusPaths.map((path) => index.get(path)).filter((at) => at !== undefined);

  const restart = new Float64Array(files.length);
  if (focus.length === 0) restart.fill(1 / files.length);
  else for (const at of focus) restart[at] = 1 / focus.length;

  let rank = Float64Array.from(restart);
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const next = new Float64Array(files.length);
    let dangling = 0;
    for (let from = 0; from < files.length; from += 1) {
      const outgoing = edges[from] as readonly Edge[];
      const total = outgoing.reduce((sum, edge) => sum + edge.weight, 0);
      if (total === 0) {
        dangling += rank[from] as number;
        continue;
      }
      for (const edge of outgoing) {
        next[edge.to] = (next[edge.to] as number) + (rank[from] as number) * (edge.weight / total);
      }
    }
    let delta = 0;
    for (let at = 0; at < files.length; at += 1) {
      // A file with no outgoing edges would leak its mass out of the system; PageRank's standard
      // treatment redistributes it over the restart vector, which keeps the total at 1.
      const value =
        DAMPING * ((next[at] as number) + dangling * (restart[at] as number)) +
        (1 - DAMPING) * (restart[at] as number);
      delta += Math.abs(value - (rank[at] as number));
      next[at] = value;
    }
    rank = next;
    if (delta < CONVERGENCE_TOLERANCE) break;
  }

  const external = externalReferenceCounts(files);
  return files
    .map((file, at): RankedFile => {
      const symbols = file.definitions
        .map(
          (definition): RankedSymbol => ({
            name: definition.name,
            kind: definition.kind,
            line: definition.line,
            externalReferences: external.get(`${file.path}\0${definition.name}`) ?? 0,
          }),
        )
        .sort((left, right) =>
          right.externalReferences === left.externalReferences
            ? left.line - right.line || left.name.localeCompare(right.name)
            : right.externalReferences - left.externalReferences,
        );
      return { path: file.path, rank: rank[at] as number, symbols };
    })
    .sort((left, right) =>
      right.rank === left.rank ? left.path.localeCompare(right.path) : right.rank - left.rank,
    );
};
