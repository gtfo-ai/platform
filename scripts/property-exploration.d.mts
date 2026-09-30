/** Types for `property-exploration.mjs`, plain JavaScript like the other scripts it runs beside. */

export declare const RUNS_A_PROPERTY: RegExp;
export declare const EXPLORATION_PROJECTS: readonly string[];
export declare function runsAProperty(source: string): boolean;
export declare function propertyFiles(root: string): string[];
export declare function drawSeed(): number;
export declare function chooseSeed(argv: readonly string[], draw?: () => number): number;
export declare function explorationArgs(files: readonly string[]): string[];
export declare function replayCommand(seed: number): string;
export declare function replayFileCommand(seed: number, file: string): string;
export declare function verdictLine(input: {
  readonly passed: boolean;
  readonly seed: number;
  readonly files: number;
}): string;
