/** Types for `coverage-ratchet.mjs`, plain JavaScript like the other `verify` steps. */

type Metric = 'lines' | 'branches' | 'functions' | 'statements';
type Matcher = (path: string) => boolean;
type Figures = Record<string, { covered: number; total: number; pct: number }>;
type Measured = Record<string, { files: number; figures: Figures }>;
type Rings = Readonly<
  Record<string, { readonly glob: string; readonly thresholds: Readonly<Record<string, number>> }>
>;

export declare const COVERAGE_SUMMARY: string;
export declare const STARTED_AT_VARIABLE: string;
export declare const METRICS: readonly Metric[];

export declare function percent(covered: number, total: number): number;
export declare function slackPoints(total: number): number;
export declare function earnedFloor(input: { pct: number; total: number; bar: number }): number;
export declare function ringFigures(
  summary: Record<string, Record<string, { total: number; covered: number }>>,
  rings: Rings,
  root: string,
  matcher: (glob: string) => Matcher,
): Measured;
export declare function ratchetVerdicts(
  measured: Measured,
  rings: Rings,
  barOf: (ring: string) => Readonly<Record<string, number>>,
): { problems: string[]; report: string[] };
export declare function summaryProvenanceProblems(
  summary: Record<string, unknown>,
  root: string,
  counted: readonly string[],
): string[];
export declare function freshnessProblem(
  writtenAtMs: number,
  startedAt: string | undefined,
): string | null;
export declare function vitestPicomatch(): (glob: string | readonly string[]) => Matcher;
export declare function ratchet(input: {
  root: string;
  summaryPath: string;
  startedAt: string | undefined;
  config: unknown;
  picomatch: (glob: string | readonly string[]) => Matcher;
  now?: number;
}): { code: number; out: string; err: string[] };
