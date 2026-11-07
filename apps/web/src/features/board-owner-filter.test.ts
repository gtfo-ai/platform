/**
 * The board's owner filter, remembered per person (S-26.8b, the M26 UX spec § 3): the URL wins,
 * then this person's stored choice, then *Everyone*; *Everyone* is stored by forgetting; another
 * person on the same browser reads their own; storage that throws remembers nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  boardOwnerFilter,
  ownerFilterStorageKey,
  ownerSearchValue,
  readStoredOwnerFilter,
  storeOwnerFilter,
} from './board-owner-filter.js';

const ADA = 'user-ada';
const BOB = 'user-bob';

const memory = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

const refusing: Storage = {
  length: 0,
  clear: () => {},
  key: () => null,
  getItem: () => {
    throw new Error('SecurityError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('the board’s owner filter', () => {
  it('prefers the URL, then the stored choice, then Everyone', () => {
    expect(boardOwnerFilter('none', 'me')).toBe('none');
    expect(boardOwnerFilter(undefined, 'me')).toBe('me');
    expect(boardOwnerFilter(undefined, null)).toBe('all');
    // A value outside the two is no filter, never a router error.
    expect(boardOwnerFilter('everyone', null)).toBe('all');
    expect(boardOwnerFilter('everyone', 'none')).toBe('none');
  });

  it('remembers each person’s choice under their own id, and Everyone by forgetting', () => {
    const storage = memory();
    storeOwnerFilter(storage, ADA, 'me');
    expect(storage.getItem(ownerFilterStorageKey(ADA))).toBe('me');
    expect(readStoredOwnerFilter(storage, ADA)).toBe('me');
    // Another person on the same browser does not inherit it.
    expect(readStoredOwnerFilter(storage, BOB)).toBeNull();
    storeOwnerFilter(storage, ADA, 'all');
    expect(storage.getItem(ownerFilterStorageKey(ADA))).toBeNull();
    expect(readStoredOwnerFilter(storage, ADA)).toBeNull();
  });

  it('remembers nothing without a person, a garbled value or storage that refuses', () => {
    const storage = memory();
    storeOwnerFilter(storage, null, 'me');
    expect(storage.length).toBe(0);
    expect(readStoredOwnerFilter(storage, null)).toBeNull();
    storage.setItem(ownerFilterStorageKey(ADA), 'everyone');
    expect(readStoredOwnerFilter(storage, ADA)).toBeNull();
    expect(() => {
      storeOwnerFilter(refusing, ADA, 'me');
    }).not.toThrow();
    expect(readStoredOwnerFilter(refusing, ADA)).toBeNull();
    expect(readStoredOwnerFilter(undefined, ADA)).toBeNull();
  });

  it('puts Everyone in the URL as no parameter at all', () => {
    expect(ownerSearchValue('all')).toBeUndefined();
    expect(ownerSearchValue('me')).toBe('me');
    expect(ownerSearchValue('none')).toBe('none');
  });
});
