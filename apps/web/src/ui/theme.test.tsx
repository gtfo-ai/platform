import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  isThemePreference,
  readStoredTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
} from './theme.js';

describe('resolveTheme', () => {
  it('follows the operating system when the preference is `system`', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('ignores the operating system when the user has chosen', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('readStoredTheme', () => {
  it('reads a stored preference', () => {
    const storage = { getItem: (key: string) => (key === THEME_STORAGE_KEY ? 'dark' : null) };
    expect(readStoredTheme(storage)).toBe('dark');
  });

  it('falls back to the dark default for anything it does not recognise (TD-033)', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(readStoredTheme({ getItem: () => 'purple' })).toBe('dark');
    expect(readStoredTheme({ getItem: () => null })).toBe('dark');
    expect(readStoredTheme(undefined)).toBe('dark');
  });

  it('still honours a stored `system` or `light`', () => {
    expect(readStoredTheme({ getItem: () => 'system' })).toBe('system');
    expect(readStoredTheme({ getItem: () => 'light' })).toBe('light');
  });

  it('survives a browser whose storage throws, rather than failing to render', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage is disabled in this context');
      },
    };
    expect(readStoredTheme(storage)).toBe('dark');
  });
});

describe('isThemePreference', () => {
  it('accepts only the three documented values', () => {
    expect(['light', 'dark', 'system'].every(isThemePreference)).toBe(true);
    expect(isThemePreference('Dark')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
});
