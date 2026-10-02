/** Types for `compose-check-support.mjs`, which stays plain JavaScript because the checks are. */

export declare const MINIMUM_NODE_MAJOR: number;
export declare const REQUEST_MS: number;

export declare const refuseOldNode: (
  check: string,
  version?: string,
  exit?: (code: number) => void,
) => void;

export declare class Unsettled extends Error {}

export interface Stages {
  readonly current: string;
  readonly set: (stage: string) => void;
  readonly within: <T>(what: string, ms: number, work: () => Promise<T>) => Promise<T>;
}

export declare const createStages: (initial?: string) => Stages;

export declare const boundedFetch: (
  stages: Stages,
  url: string,
  init?: RequestInit,
  ms?: number,
) => Promise<{ response: Response; body: string }>;

export declare const waitForOk: (
  stages: Stages,
  url: string,
  options?: { probeMs?: number; totalMs?: number; intervalMs?: number },
) => Promise<void>;

export declare const composeEnvironment: (project: string) => {
  APP_PORT: string;
  APP_WORKSPACE_CONTROL_VOLUME: string;
  APP_WORKSPACE_CACHE_VOLUME: string;
};

export declare const parsePublishedPort: (stdout: string) => number;

type Compose = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export declare const publishedPort: (
  compose: Compose,
  service?: string,
  containerPort?: number,
) => Promise<number>;

export declare const installExitBackstop: (check: string, stages: Stages) => () => void;

export declare const describeInstance: (compose: Compose, label?: string) => Promise<void>;
