/** Types for `source-scanner.mjs`, which stays plain JavaScript like `census-files.mjs`. */

/**
 * Every comment removed and everything else kept byte for byte — strings, templates with their
 * interpolations, regular-expression literals — with every newline kept, so line numbers survive.
 */
export declare function withoutComments(
  source: string,
  options?: {
    /** Keep `//` comments' text (still read as comments, so a `/*` inside opens nothing). */
    readonly keepLineComments?: boolean;
  },
): string;
