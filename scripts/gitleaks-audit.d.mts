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
export declare function containerArgs(
  layout: GitLayout,
  image: string,
  scanArgs: readonly string[],
): string[];
export declare function stagedAddedLines(root: string): number | null;
export declare function bytesScanned(output: string): number | null;
export declare function scanVerdict(input: {
  readonly status: number;
  readonly output: string;
  readonly mayBeEmpty: boolean;
}): ScanVerdict;
