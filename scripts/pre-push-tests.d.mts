/** Types for `pre-push-tests.mjs`, which stays plain JavaScript because the pre-push hook runs it. */

export declare const MAIN_REF: 'refs/heads/main';

export declare const pushNeedsTests: (stdin: string) => boolean;
