/*
 * App shell — the Ctrl K / ⌘K binding and the palette's open state.
 *
 * The accelerator cannot live inside `CommandPalette` itself: the palette
 * renders nothing while closed (a requirement of `design/feedback/overlayFocus`,
 * which needs the panel in the DOM before it can move focus into it), so there
 * would be no mounted component left to hear the key that opens it. The state
 * therefore belongs to the shell, and this hook is what the shell holds.
 *
 * `AppShell` wires it to both entry points:
 *   <WindowTitleBar onOpenCommandPalette={openPalette} …/>
 *   <CommandPalette open={open} onClose={closePalette} navigate={navigate} />
 *
 * The binding toggles rather than only opening. Ctrl K is how the palette is
 * summoned, so it is also the reflex for dismissing it; Esc (handled inside the
 * overlay) remains the documented close, and the artboard prints it in the
 * header chip.
 */

import { useCallback, useEffect, useState } from 'react';

export interface CommandPaletteController {
  readonly open: boolean;
  readonly openPalette: () => void;
  readonly closePalette: () => void;
  readonly togglePalette: () => void;
}

/**
 * True for Ctrl K on Windows / Linux and ⌘K on macOS.
 *
 * Shift and Alt are excluded rather than ignored: Ctrl Shift K is the browser's
 * own console shortcut in Firefox, and swallowing it here would be a surprise.
 * Exported for the interaction test, which asserts the near-misses do nothing.
 */
export function isCommandPaletteHotkey(event: KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey)) return false;
  if (event.shiftKey || event.altKey) return false;
  return event.key.toLowerCase() === 'k';
}

export function useCommandPalette(): CommandPaletteController {
  const [open, setOpen] = useState(false);

  const openPalette = useCallback(() => {
    setOpen(true);
  }, []);
  const closePalette = useCallback(() => {
    setOpen(false);
  }, []);
  const togglePalette = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isCommandPaletteHotkey(event)) return;
      // Chrome and Firefox both bind Ctrl K to their address bar's search mode.
      // The desktop build has no address bar, but `pnpm dev` in a browser does.
      event.preventDefault();
      setOpen((current) => !current);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return { open, openPalette, closePalette, togglePalette };
}
