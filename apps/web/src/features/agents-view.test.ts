/**
 * Which view the Agents page opens on (S-23.6): the URL's, else the remembered one, else the map —
 * and a storage that refuses is a page that works and forgets.
 */
import { describe, expect, it } from 'vitest';
import { chosenView, FLEET_VIEW_STORAGE_KEY, readStoredView, storeView } from './agents-view.js';

const memory = (): Storage => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as Storage;
};

const refusing = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
} as unknown as Storage;

describe('the chosen view', () => {
  it('is the URL’s, then the stored one, then the map', () => {
    expect(chosenView('list', 'office')).toBe('list');
    expect(chosenView(undefined, 'office')).toBe('office');
    expect(chosenView('aquarium', 'office')).toBe('office');
    expect(chosenView(undefined, null)).toBe('map');
  });

  it('is remembered in storage under one key, and an unknown stored value is no choice', () => {
    const storage = memory();
    expect(readStoredView(storage)).toBeNull();
    storeView(storage, 'office');
    expect(storage.getItem(FLEET_VIEW_STORAGE_KEY)).toBe('office');
    expect(readStoredView(storage)).toBe('office');
    storage.setItem(FLEET_VIEW_STORAGE_KEY, '<script>');
    expect(readStoredView(storage)).toBeNull();
  });

  it('survives a storage that refuses both ways, and no storage at all', () => {
    expect(readStoredView(refusing)).toBeNull();
    expect(() => {
      storeView(refusing, 'list');
    }).not.toThrow();
    expect(readStoredView(undefined)).toBeNull();
  });
});
