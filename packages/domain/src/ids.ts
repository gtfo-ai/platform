/**
 * Event ids as an injected dependency, for the same reason as the clock: `uuidv7()` lives in
 * Postgres (technical/03) and randomness would make this package's property tests meaningless.
 *
 * A command that emits several events pulls several ids from the same source, so the caller
 * decides how ids are minted and the aggregate stays deterministic.
 */
import type { Id } from '@platform/contracts';

export interface IdSource {
  next(): Id;
}

/** A source backed by a fixed list; throws when the list runs out, which is a caller bug. */
export const idsFrom = (ids: readonly Id[]): IdSource => {
  let index = 0;
  return {
    next: () => {
      const id = ids[index];
      if (id === undefined) {
        throw new RangeError(`idsFrom: exhausted after ${ids.length} ids`);
      }
      index += 1;
      return id;
    },
  };
};

/**
 * Deterministic, well-formed UUIDs (`…-4xxx-8xxx-…`, so `z.uuid()` accepts them) counting up from
 * `start`. Used by tests and by the fake runner; never by production code, which mints uuidv7.
 */
export const sequentialIds = (start = 1): IdSource => {
  let counter = start;
  return {
    next: () => {
      const suffix = counter.toString(16).padStart(12, '0');
      counter += 1;
      return `00000000-0000-4000-8000-${suffix}`;
    },
  };
};
