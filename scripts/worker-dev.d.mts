/** Types for `worker-dev.mjs`, which stays plain JavaScript like the other dev scripts. */
export declare const DEV_PROJECT: string;
export declare const BASE_COMPOSE_FILE: string;
export declare const DEV_COMPOSE_FILE: string;
export declare const DEFAULT_ENV_FILE: string;
export declare const DEFAULT_VITE_PORT: string;
export declare const composePrefix: (envFile: string) => string[];
export type WorkerDevPlan =
  | { readonly kind: 'up'; readonly build: boolean }
  | { readonly kind: 'ui' }
  | { readonly kind: 'compose'; readonly args: string[] }
  | { readonly kind: 'usage'; readonly error: string | null };
export declare const planCommand: (argv: readonly string[]) => WorkerDevPlan;
export declare const pageTokenFrom: (logs: string) => string | null;
export declare const workerOriginFrom: (portOutput: string) => string | null;
