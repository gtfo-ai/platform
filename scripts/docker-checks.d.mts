/** Types for `docker-checks.mjs`, which stays plain JavaScript so the workflow's plan job needs no install. */
export interface DockerCheck {
  readonly name: string;
  readonly when: 'always' | 'paths';
  readonly paths: readonly string[];
  readonly why: string;
}
export declare const HARNESS_PATHS: readonly string[];
export declare const DOCKER_CHECKS: readonly DockerCheck[];
export declare const RUN_ELSEWHERE: Readonly<Record<string, string>>;
export declare const matchesPath: (file: string, paths: readonly string[]) => boolean;
export declare const planChecks: (
  changed: readonly string[] | null,
  checks?: readonly DockerCheck[],
) => string[];
export declare const parseChanged: (text: string) => string[];
