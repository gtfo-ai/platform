/**
 * Light / dark / system (technical/09 § "Accessibility, theming, i18n").
 *
 * The resolution is a pure function so it can be tested without a browser, and the only side
 * effect is one attribute: `<html data-theme="light|dark">`. `styles.css` keys every token off
 * that attribute and sets `color-scheme` with it, so form controls, scrollbars and the browser's
 * own UI follow the choice as well as the app's colours do.
 *
 * `system` stores the *preference*, never the resolved value: a laptop that switches to dark at
 * sunset has to move the app with it, which it cannot do if the resolution was frozen at the
 * moment the user chose.
 */
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'agentic.theme';

export const isThemePreference = (value: unknown): value is ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system';

/** Pure: preference + what the OS says → the attribute value. */
export const resolveTheme = (preference: ThemePreference, prefersDark: boolean): ResolvedTheme => {
  if (preference === 'system') {
    return prefersDark ? 'dark' : 'light';
  }
  return preference;
};

export const readStoredTheme = (storage: Pick<Storage, 'getItem'> | undefined): ThemePreference => {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    // A browser with storage disabled (or a privacy mode that throws on access) still gets a
    // themed app; it just cannot remember the choice.
    return 'system';
  }
};

const prefersDarkNow = (): boolean =>
  typeof globalThis.matchMedia === 'function' &&
  globalThis.matchMedia('(prefers-color-scheme: dark)').matches;

export interface ThemeContextValue {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
  readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const ThemeProvider = ({ children }: { readonly children: ReactNode }): ReactElement => {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    readStoredTheme(globalThis.localStorage),
  );
  const [prefersDark, setPrefersDark] = useState<boolean>(prefersDarkNow);

  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') {
      return;
    }
    const query = globalThis.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent): void => {
      setPrefersDark(event.matches);
    };
    query.addEventListener('change', listener);
    return () => {
      query.removeEventListener('change', listener);
    };
  }, []);

  const resolved = resolveTheme(preference, prefersDark);

  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved;
  }, [resolved]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolved,
      setPreference: (next) => {
        setPreference(next);
        try {
          globalThis.localStorage?.setItem(THEME_STORAGE_KEY, next);
        } catch {
          // See `readStoredTheme`: the app works, the choice is not remembered.
        }
      },
    }),
    [preference, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextValue => {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error('useTheme was called outside <ThemeProvider>');
  }
  return value;
};

/**
 * Applies the stored preference before React renders, so the first paint is already themed.
 *
 * Called from `main.tsx` rather than from an inline `<script>` in `index.html`: an inline script is
 * the first thing a strict Content-Security-Policy has to allow.
 */
export const applyStoredThemeSynchronously = (): void => {
  document.documentElement.dataset['theme'] = resolveTheme(
    readStoredTheme(globalThis.localStorage),
    prefersDarkNow(),
  );
};
