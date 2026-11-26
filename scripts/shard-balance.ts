/**
 * **Which part of a split run a test file runs in** — by its measured duration, not by its name.
 *
 * `scripts/verify.mjs --shard <i>/<n>` splits a vitest tier over `n` CI runners. vitest's own
 * `BaseSequencer.shard` sorts the files by a SHA-1 of their path and cuts the list into `n` equal
 * **counts**, which is blind to what a file costs: on 2026-11-26 (run 45861948638) part 3 of
 * `e2e-fake-claude` drew 1124 s of file time against 553 s and 496 s and was the whole workflow's
 * critical path, and part 1 of `unit + contract` drew 444 s (one file alone 222 s) against parts
 * that finished in 87 s and 134 s.
 *
 * So `scripts/balanced-sequencer.ts` (the `sequence.sequencer` in `vitest.config.ts`) asks
 * {@link assignParts} instead: a greedy longest-first assignment over the checked-in table
 * `scripts/shard-timings.json`, refreshed from a green CI run by `node scripts/shard-timings.mjs
 * <run-id>` ({@link parseVitestLog} is its reader). Four properties, each held by
 * `scripts/shard-balance.test.ts`:
 *
 *  - **Every file runs in exactly one part.** Every part computes the **whole** assignment from the
 *    same file list and the same table and keeps its own bucket, so the parts are a partition by
 *    construction — the same argument vitest's hash split rests on.
 *  - **Deterministic.** The order is the weight descending, then the key ascending under plain
 *    code-unit comparison (never `localeCompare`, whose answer is the host's locale); a tie between
 *    parts goes to the lowest index. Nothing reads the clock, the machine or the input order.
 *  - **An unknown file is placed, never dropped.** A file the table does not name (new since the
 *    table was refreshed) weighs its project's median measured file, or {@link UNKNOWN_FILE_MS} for a
 *    project the table has never measured, and is assigned like any other.
 *  - **Balanced on the part's wall time, not on its sum.** A part's estimate is
 *    `max(longest parallel file, parallel sum ÷ workers) + serial sum`: the parallel files share
 *    {@link CI_WORKERS} workers, the files of a project that runs one file at a time (`process`,
 *    `fileParallelism: false`, after the others) add to the wall one for one, and one long file
 *    floors its part however little else it holds. Each file also costs its project's
 *    `overheadMs` (the import and setup time the per-file figure vitest prints does not include —
 *    25–47 % of a unit part's wall), so 700 cheap files are not free. The table's figures were fitted
 *    to run 45861948638's part walls: a unit part of 235 files and 87 s of file time took 94 s
 *    (≈ 0.8 s a file over three workers), another 145 s for 112 s plus 23 s serial (≈ 1.1 s) — so
 *    900 ms; an e2e part of 26 files and 495 s took 217 s (≈ 6 s a file), another 553 s in 225 s
 *    (≈ 4.7 s) — so 5 000 ms.
 *
 * What it cannot do: a single file longer than a part's fair share still bounds that part (the
 * 222 s `unattended-commands.test.ts` in the unit tier). Splitting such a file is the only answer,
 * and it is the file's, not this module's — which is how the 239–330 s `docker-workspace.e2e.test.ts`
 * became three files of the e2e tier (BACKLOG 1654).
 */

/** The table `scripts/shard-timings.json` holds. */
export interface ShardTimings {
  /** Where the figures came from: the run and the date it was read. */
  readonly source: { readonly run: string; readonly retrieved: string; readonly note?: string };
  /** How many vitest workers a CI runner runs (four vCPUs, vitest's default of `cpus − 1`). */
  readonly workers: number;
  /** Per project: the per-file cost vitest's file line leaves out, and whether it runs serially. */
  readonly projects: Readonly<
    Record<string, { readonly overheadMs: number; readonly serial?: boolean }>
  >;
  /** `<project>:<repository-relative path>` → the file's measured duration in milliseconds. */
  readonly files: Readonly<Record<string, number>>;
}

/** One test file of the run, as the sequencer sees it. */
export interface ShardFile {
  /** `<project>:<posix path relative to the repository root>` — the table's key. */
  readonly key: string;
  readonly project: string;
}

/** The weight of a file of a project the table has never measured. */
export const UNKNOWN_FILE_MS = 1_000;

/** The worker count when the table does not say. */
export const CI_WORKERS = 3;

/** The key a file is measured and assigned under. */
export const fileKey = (project: string, relativePath: string): string =>
  `${project}:${relativePath.split('\\').join('/')}`;

const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
};

/**
 * What a file weighs in milliseconds: its measured duration, or its project's median, plus its
 * project's per-file overhead.
 */
export const weightOf = (
  file: ShardFile,
  timings: ShardTimings,
  medians: ReadonlyMap<string, number | undefined>,
): number => {
  const measured = timings.files[file.key] ?? medians.get(file.project) ?? UNKNOWN_FILE_MS;
  return Math.round(measured) + (timings.projects[file.project]?.overheadMs ?? 0);
};

/** Every project's median measured file, computed once per assignment. */
export const projectMedians = (timings: ShardTimings): Map<string, number | undefined> => {
  const byProject = new Map<string, number[]>();
  for (const [key, ms] of Object.entries(timings.files)) {
    const project = key.slice(0, key.indexOf(':'));
    const list = byProject.get(project) ?? [];
    list.push(ms);
    byProject.set(project, list);
  }
  return new Map([...byProject].map(([project, list]) => [project, median(list)]));
};

interface Part {
  parallelSum: number;
  parallelMax: number;
  serialSum: number;
  readonly files: ShardFile[];
}

const estimate = (part: Part, workers: number): number =>
  Math.max(part.parallelMax, part.parallelSum / workers) + part.serialSum;

/** The plain code-unit order: the same answer on every host. */
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every part's files, `count` lists whose union is `files` and whose lists are disjoint.
 *
 * A file key that appears twice in `files` is refused: the partition is of keys, and a duplicate
 * would be a file the run holds twice rather than a file one part runs.
 */
export const assignParts = (
  files: readonly ShardFile[],
  timings: ShardTimings,
  count: number,
): ShardFile[][] => {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`a split needs a whole number of parts ≥ 1; got ${count}`);
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.key)) throw new Error(`the run holds ${file.key} twice`);
    seen.add(file.key);
  }
  const workers = timings.workers > 0 ? timings.workers : CI_WORKERS;
  const medians = projectMedians(timings);
  const weighed = files
    .map((file) => ({ file, weight: weightOf(file, timings, medians) }))
    .sort((a, b) => b.weight - a.weight || byCodeUnits(a.file.key, b.file.key));
  const parts: Part[] = Array.from({ length: count }, () => ({
    parallelSum: 0,
    parallelMax: 0,
    serialSum: 0,
    files: [],
  }));
  for (const { file, weight } of weighed) {
    const serial = timings.projects[file.project]?.serial === true;
    let best = 0;
    let bestEstimate = Number.POSITIVE_INFINITY;
    let bestLoad = Number.POSITIVE_INFINITY;
    parts.forEach((part, index) => {
      const after: Part = serial
        ? { ...part, serialSum: part.serialSum + weight }
        : {
            ...part,
            parallelSum: part.parallelSum + weight,
            parallelMax: Math.max(part.parallelMax, weight),
          };
      const value = estimate(after, workers);
      const load = part.parallelSum + part.serialSum * workers;
      // Lowest resulting estimate; on a tie the lighter part, then the lower index.
      if (value < bestEstimate || (value === bestEstimate && load < bestLoad)) {
        best = index;
        bestEstimate = value;
        bestLoad = load;
      }
    });
    const part = parts[best] as Part;
    if (serial) part.serialSum += weight;
    else {
      part.parallelSum += weight;
      part.parallelMax = Math.max(part.parallelMax, weight);
    }
    part.files.push(file);
  }
  return parts.map((part) => part.files);
};

/** The estimated wall time of each part of an assignment, in milliseconds. */
export const estimateParts = (parts: readonly (readonly ShardFile[])[], timings: ShardTimings) => {
  const workers = timings.workers > 0 ? timings.workers : CI_WORKERS;
  const medians = projectMedians(timings);
  return parts.map((files) => {
    const part: Part = { parallelSum: 0, parallelMax: 0, serialSum: 0, files: [] };
    for (const file of files) {
      const weight = weightOf(file, timings, medians);
      if (timings.projects[file.project]?.serial === true) part.serialSum += weight;
      else {
        part.parallelSum += weight;
        part.parallelMax = Math.max(part.parallelMax, weight);
      }
    }
    return Math.round(estimate(part, workers));
  });
};

/**
 * The order a part runs its own files in: longest first, so a long file starts while the short ones
 * fill the other workers rather than starting last and running alone. Applied within a
 * `sequence.groupOrder` only — the `process` project still runs after `unit` and `contract`.
 */
export const longestFirst = <T>(
  items: readonly T[],
  describe: (item: T) => { readonly file: ShardFile; readonly groupOrder: number },
  timings: ShardTimings,
): T[] => {
  const medians = projectMedians(timings);
  return items
    .map((item) => {
      const { file, groupOrder } = describe(item);
      return { item, key: file.key, groupOrder, weight: weightOf(file, timings, medians) };
    })
    .sort((a, b) => a.groupOrder - b.groupOrder || b.weight - a.weight || byCodeUnits(a.key, b.key))
    .map(({ item }) => item);
};

/**
 * A `gh run view <id> --log` transcript's per-file figures, from the **part** jobs only: a merge job
 * (`--merge-reports`) replays every file line, and reading both would count each file twice. A
 * file line is vitest's default reporter's —
 * `<job>\t<step>\t<timestamp>  ✓  <project>  <path> (<n> tests) <ms>ms` — after the ANSI colour
 * codes are stripped. A file reported by two parts is refused, because that is the property the
 * split exists to keep.
 */
export const parseVitestLog = (log: string): Map<string, number> => {
  const files = new Map<string, number>();
  const where = new Map<string, string>();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ANSI escape is what it strips.
  const plain = log.replace(/\u001b\[[0-9;]*m/g, '');
  const line =
    /^(?<job>[^\t\n]*\(part \d+\/\d+\))\t[^\t\n]*\t\S+\s+[✓×]\s+(?<project>\S+)\s+(?<path>\S+\.test\.tsx?)\s+\([^)\n]*\)(?:\s+\S+)*?\s+(?<ms>\d+)ms\s*$/gmu;
  for (const match of plain.matchAll(line)) {
    const { job = '', project = '', path = '', ms = '' } = match.groups ?? {};
    const key = fileKey(project, path);
    const earlier = where.get(key);
    if (earlier !== undefined && earlier !== job) {
      throw new Error(`${key} was reported by two parts: ${earlier} and ${job}`);
    }
    where.set(key, job);
    files.set(key, Number(ms));
  }
  return files;
};

/**
 * The table a refresh writes: the measured files of `run`, sorted by key, with the previous table's
 * `workers` and `projects` kept — those are calibrations a person makes, not figures a log carries.
 */
export const refreshedTimings = (
  previous: ShardTimings,
  measured: ReadonlyMap<string, number>,
  run: string,
  retrieved: string,
): ShardTimings => {
  if (measured.size === 0) {
    throw new Error(`run ${run} reported no file of a split part: nothing to refresh from`);
  }
  return {
    source: { run, retrieved },
    workers: previous.workers,
    projects: previous.projects,
    files: Object.fromEntries([...measured].sort(([a], [b]) => byCodeUnits(a, b))),
  };
};
