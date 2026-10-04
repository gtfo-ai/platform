/** Types for `real-model-preflight.mjs`, which stays plain JavaScript because the check is. */

export declare const REAL_MODEL_FLAG: '--real-model';
export declare const REAL_MODEL_TOKEN_VARIABLE: 'CLAUDE_CODE_OAUTH_TOKEN';
export declare const REAL_MODEL_MIN_TOKEN_LENGTH: number;
export declare const REAL_MODEL_PROMPT: string;
export declare const REAL_MODEL_WALL_CLOCK_MS: number;

export type RealModelGate =
  | { readonly kind: 'off' }
  | { readonly kind: 'on'; readonly tokenLength: number }
  | { readonly kind: 'refused'; readonly message: string };

export declare const realModelGate: (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
) => RealModelGate;

export declare const containsValue: (text: string, value: string | undefined) => boolean;

export declare const captureOutput: (streams: readonly NodeJS.WritableStream[]) => {
  readonly text: () => string;
};

export declare const hostsSeenBySidecar: (lines: readonly string[] | null) => {
  readonly seen: readonly string[];
  readonly allowed: readonly string[];
  readonly refused: readonly string[];
};
