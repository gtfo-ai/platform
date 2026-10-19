/** Types for `vitest-bounded.mjs`, which stays plain JavaScript so `pnpm test` needs no resolver. */

export declare const COLLECTION_BOUND_MS: number;
export declare const COLLECTION_BOUND_ENV: string;
export declare const STALL_REPORT_ENV: string;
export declare const SIGNAL_GRACE_MS: number;

interface CollectingModule {
  readonly project: string;
  readonly file: string;
}

export declare function createCollectionWatchdog(
  boundMs: number,
  startedAt: number,
): {
  queued(module: CollectingModule, at: number): void;
  collected(module: CollectingModule, at: number): void;
  active(at: number): void;
  /** The oldest file still collecting, once it and the whole run have been quiet for the bound. */
  stalled(at: number): string | null;
};

/** `root` and every process descended from it, parents before children. */
export declare function processTree(
  root: number,
  table: ReadonlyArray<readonly [number, number]>,
): number[];

/** Every process's `[pid, ppid]`, from `ps`. */
export declare function processTable(): Array<[number, number]>;

/** `SIGKILL` to each PID; one already gone is not an error. */
export declare function killPids(pids: readonly number[]): void;

/** `SIGKILL` to `root` and its descendants, by PID, children first. */
export declare function killProcessTree(root: number): void;

/** `FAIL: <target> — collection stalled in <file>`. */
export declare function stallLine(target: string, file: string): string;
