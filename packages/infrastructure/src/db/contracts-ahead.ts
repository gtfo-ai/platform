/**
 * Enum values the contract publishes **before** storage has them — declared, each naming the row
 * that empties it (WP-273).
 *
 * TD-032 decision 1 makes `alter type … add value 'v'` an `additive` migration only when `'v'` is
 * already in `packages/contracts` at the migration's base commit (`migrations:check` reads it there),
 * so that the build running beside the migration can parse every value the database may then hold.
 * The value therefore lands in the contract one release **ahead** of its label, and for that release
 * the three spellings of one value set — the database's labels, the Drizzle `pgEnum` and the zod enum
 * — disagree on purpose.
 *
 * This list is what makes that disagreement a statement rather than a gap. The parity tests
 * (`test/integration/db/enums.integration.test.ts` against the live labels, `contracts-ahead.test.ts`
 * against the `pgEnum` declarations) compare storage with the contract **minus** this list, and fail
 * in both directions:
 *
 * - a difference this list does not declare (a value added to one side and forgotten on the other);
 * - an entry whose value storage **already has** — so the row that adds the label must also remove
 *   its entry here, and the list cannot outlive the reason for it.
 *
 * A declared value must be a **tail** of the contract's list: `add value` without `before`/`after`
 * appends, so a value declared ahead from the middle of the list would be stored in a different order
 * than it is published, which the parity tests compare.
 */

export interface ValueAheadOfStorage {
  /** The enum label the contract publishes and storage does not have yet. */
  readonly value: string;
  /** The work package that adds the label (its migration) and empties this entry. */
  readonly emptiedBy: string;
}

/** PostgreSQL enum type name → the values declared ahead of it, in contract order. */
export const CONTRACTS_AHEAD_OF_STORAGE: Readonly<Record<string, readonly ValueAheadOfStorage[]>> =
  {
    // TD-031 decision 11: a run a usage limit ended mid-run. In contracts since WP-273, written and
    // stored by WP-285 (its migration appends the label).
    run_terminal_reason: [{ value: 'rate_limited', emptiedBy: 'WP-285' }],
  };

/** A declaration this module cannot honour: the value is missing, or not a tail. */
export class ContractsAheadDeclarationError extends Error {
  override readonly name = 'ContractsAheadDeclarationError';
}

/**
 * The labels storage must hold for `enumName`, given the contract's `published` values: `published`
 * minus the declared tail. Throws {@link ContractsAheadDeclarationError} when a declared value is not
 * published, or is not at the end of the list in the declared order.
 */
export const storedLabelsOf = (enumName: string, published: readonly string[]): string[] => {
  const ahead = (CONTRACTS_AHEAD_OF_STORAGE[enumName] ?? []).map((entry) => entry.value);
  if (ahead.length === 0) return [...published];
  const tail = published.slice(published.length - ahead.length);
  if (tail.length !== ahead.length || tail.some((value, index) => value !== ahead[index])) {
    throw new ContractsAheadDeclarationError(
      `${enumName}: the values declared ahead of storage (${ahead.join(', ')}) must be the last ` +
        `${ahead.length} of the contract's list, in order; it ends ${JSON.stringify(tail)}`,
    );
  }
  return published.slice(0, published.length - ahead.length);
};
