/**
 * Live theme and reduced-motion authority over the document root.
 *
 * `theme.css` and `base.css` define three theme states on `:root`:
 *   - unset (`system`): follows `@media (prefers-color-scheme: dark)`
 *   - `data-theme="light"`: forces the light palette regardless of OS setting
 *   - `data-theme="dark"`: forces the dark palette regardless of OS setting
 *
 * Reduced motion follows `@media (prefers-reduced-motion: reduce)` and is
 * explicitly forced whenever `data-reduce-motion="true"` is present on `:root`.
 */

export type AppTheme = 'system' | 'light' | 'dark';

export interface ThemeAttributeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function defaultTarget(): ThemeAttributeTarget | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

/** Normalises persisted or untrusted theme strings onto the closed three-state union. */
export function normalizeAppTheme(theme: string | null | undefined): AppTheme {
  if (theme === 'light' || theme === 'dark') return theme;
  return 'system';
}

/** Applies the theme immediately to `document.documentElement` (or a supplied target). */
export function applyAppTheme(
  theme: string | null | undefined,
  target: ThemeAttributeTarget | null = defaultTarget(),
): AppTheme {
  const normalized = normalizeAppTheme(theme);
  if (target !== null) {
    if (normalized === 'system') {
      target.removeAttribute('data-theme');
    } else {
      target.setAttribute('data-theme', normalized);
    }
  }
  return normalized;
}

/** Applies or clears the explicit reduced-motion override on `document.documentElement`. */
export function applyReduceMotion(
  reduceMotion: boolean,
  target: ThemeAttributeTarget | null = defaultTarget(),
): void {
  if (target === null) return;
  if (reduceMotion) {
    target.setAttribute('data-reduce-motion', 'true');
  } else {
    target.removeAttribute('data-reduce-motion');
  }
}
