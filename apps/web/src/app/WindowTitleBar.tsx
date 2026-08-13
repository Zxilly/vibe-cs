import { Maximize2, Minus, X } from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { isDesktopShell } from '../shared/desktop/dialog';
import { useI18n } from '../shared/i18n';

export type DesktopWindowAdapter = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  startDragging(): Promise<void>;
};

type PointerDownDetails = {
  button: number;
  doubleClick: boolean;
};

type WindowTitleBarController = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  startDragging(): Promise<void>;
  handlePointerDown(event: PointerDownDetails): Promise<void>;
};

export function createWindowTitleBarController(
  adapter: DesktopWindowAdapter | null,
  reportError: (cause: unknown) => void,
): WindowTitleBarController {
  const run = async (operation: ((window: DesktopWindowAdapter) => Promise<void>)) => {
    if (!adapter) return;
    try {
      await operation(adapter);
    } catch (cause) {
      reportError(cause);
    }
  };

  const toggleMaximize = () => run((window) => window.toggleMaximize());

  return {
    minimize: () => run((window) => window.minimize()),
    toggleMaximize,
    close: () => run((window) => window.close()),
    startDragging: () => run((window) => window.startDragging()),
    handlePointerDown: async ({ button, doubleClick }) => {
      if (button !== 0) return;
      if (doubleClick) {
        await toggleMaximize();
        return;
      }
      await run((window) => window.startDragging());
    },
  };
}

async function resolveDesktopWindow(): Promise<DesktopWindowAdapter | null> {
  if (!isDesktopShell()) return null;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

type WindowTitleBarProps = {
  children: ReactNode;
  adapter?: DesktopWindowAdapter | null;
};

export function WindowTitleBar({ children, adapter }: WindowTitleBarProps) {
  const { t } = useI18n();
  const [desktopWindow, setDesktopWindow] = useState<DesktopWindowAdapter | null>(adapter ?? null);
  const [actionFailed, setActionFailed] = useState(false);

  useEffect(() => {
    if (adapter !== undefined) {
      setDesktopWindow(adapter);
      return undefined;
    }
    let active = true;
    void resolveDesktopWindow()
      .then((window) => {
        if (active) setDesktopWindow(window);
      })
      .catch(() => {
        if (active) setActionFailed(true);
      });
    return () => {
      active = false;
    };
  }, [adapter]);

  const controller = useMemo(
    () => createWindowTitleBarController(desktopWindow, () => setActionFailed(true)),
    [desktopWindow],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target;
    if (
      !(target instanceof Element)
      || target.closest('button, a, input, textarea, select, [data-window-no-drag]')
    ) return;
    void controller.handlePointerDown({ button: event.button, doubleClick: false });
  };

  const onDoubleClick = (event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target;
    if (
      !(target instanceof Element)
      || target.closest('button, a, input, textarea, select, [data-window-no-drag]')
    ) return;
    event.preventDefault();
    void controller.toggleMaximize();
  };

  return (
    <header
      className="titlebar"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    >
      {children}
      <div className="window-controls" data-window-no-drag>
        {actionFailed ? (
          <span className="window-controls__error" role="status">{t('shell.windowActionFailed')}</span>
        ) : null}
        <button
          type="button"
          className="window-control"
          aria-label={t('shell.minimizeWindow')}
          title={t('shell.minimizeWindow')}
          onClick={() => void controller.minimize()}
        >
          <Minus size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="window-control"
          aria-label={t('shell.toggleMaximizeWindow')}
          title={t('shell.toggleMaximizeWindow')}
          onClick={() => void controller.toggleMaximize()}
        >
          <Maximize2 size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="window-control window-control--close"
          aria-label={t('shell.closeWindow')}
          title={t('shell.closeWindow')}
          onClick={() => void controller.close()}
        >
          <X size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
