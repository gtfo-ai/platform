/** Types for `gitleaks-audit.mjs`, which stays plain JavaScript because the pre-commit hook runs it. */
export interface GitLayout {
  readonly workTree: string;
  readonly commonDir: string;
  readonly gitDir: string;
  readonly linked: boolean;
  readonly relativeGitDir: string;
}

export type ScanVerdict =
  | { readonly ok: true; readonly status: number }
  | { readonly ok: false; readonly reason: string };

export declare function gitLayout(root: string): GitLayout | null;
export declare const NUMSTAT_BEGIN: string;
export declare const NUMSTAT_END: string;
export declare const RAW_BEGIN: string;
export declare function containerArgs(
  layout: GitLayout,
  image: string,
  scanArgs: readonly string[],
  options?: { readonly probeIndex?: boolean },
): string[];
export declare function stagedNumstat(root: string): string | null;
export declare function numstatRecords(numstat: string): string[];
export declare function stagedRaw(root: string): string | null;
export declare function rawRecords(raw: string): string[];
export declare function addedLinesOf(numstat: string): number;
export declare function stagedAddedLines(root: string): number | null;
export declare function containerIndexVerdict(input: {
  readonly hostNumstat: string | null;
  readonly hostRaw: string | null;
  readonly stdout: string;
}):
  | { readonly ok: true; readonly rest: string }
  | { readonly ok: false; readonly reason: string; readonly rest: string };
export declare function bytesScanned(output: string): number | null;
export declare function scanVerdict(input: {
  readonly status: number;
  readonly output: string;
  readonly mayBeEmpty: boolean;
}): ScanVerdict;
