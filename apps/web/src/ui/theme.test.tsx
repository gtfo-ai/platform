import { describe, expect, it } from 'vitest';
import { isThemePreference, readStoredTheme, resolveTheme, THEME_STORAGE_KEY } from './theme.js';

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

  it('falls back to `system` for anything it does not recognise', () => {
    expect(readStoredTheme({ getItem: () => 'purple' })).toBe('system');
    expect(readStoredTheme({ getItem: () => null })).toBe('system');
    expect(readStoredTheme(undefined)).toBe('system');
  });

  it('survives a browser whose storage throws, rather than failing to render', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage is disabled in this context');
      },
    };
    expect(readStoredTheme(storage)).toBe('system');
  });
});

describe('isThemePreference', () => {
  it('accepts only the three documented values', () => {
    expect(['light', 'dark', 'system'].every(isThemePreference)).toBe(true);
    expect(isThemePreference('Dark')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
});
