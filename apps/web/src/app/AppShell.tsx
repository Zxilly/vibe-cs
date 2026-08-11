import { applyLocale, msg, type MessageKey } from '../shared/i18n';
import {
  Activity,
  Archive,
  Bot,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  Command,
  Film,
  FileOutput,
  FolderKanban,
  History,
  Home,
  Languages,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PauseCircle,
  PlaySquare,
  ShieldCheck,
  Search,
  Settings,
  Sun,
  UsersRound,
  X,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { commands, readableError } from '../shared/desktop/client';
import { useI18n } from '../shared/i18n';
import { useRuntimeStore } from '../shared/stores/runtimeStore';
import { useUiStore } from '../shared/stores/uiStore';
import { IconButton, useDialogFocus } from '../shared/ui';

type NavItem = {
  path: string;
  code: string;
  labelKey: MessageKey;
  icon: typeof Home;
  end?: boolean;
};

const primaryNav: NavItem[] = [
  { path: '/', code: '01', labelKey: 'nav.home', icon: Home, end: true },
  { path: '/copilot', code: '02', labelKey: 'nav.copilot', icon: Bot },
  { path: '/library', code: '03', labelKey: 'nav.matches', icon: Archive },
  { path: '/production', code: '04', labelKey: 'nav.production', icon: Clapperboard },
  { path: '/outputs', code: '05', labelKey: 'nav.works', icon: FileOutput },
];

const secondaryNav: NavItem[] = [
  { path: '/settings', code: '90', labelKey: 'nav.settings', icon: Settings },
];

const contextualDestinations: NavItem[] = [
  { path: '/analysis', code: '02.1', labelKey: 'analysis.title', icon: Activity },
  { path: '/players', code: '02.2', labelKey: 'players.title', icon: UsersRound },
  { path: '/match-history', code: '02.3', labelKey: 'history.title', icon: History },
  { path: '/queue', code: '03.1', labelKey: 'queue.title', icon: PlaySquare },
  { path: '/studio', code: '03.2', labelKey: 'studio.title', icon: Film },
  { path: '/montage', code: '03.2.1', labelKey: 'montage.title', icon: Clapperboard },
  { path: '/studio/editor', code: '03.2.1', labelKey: 'editor.title', icon: Film },
  { path: '/recovery', code: '90.1', labelKey: 'recovery.title', icon: ShieldCheck },
];

const allDestinations = [...primaryNav, ...secondaryNav, ...contextualDestinations];

export function AppShell() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const language = useUiStore((state) => state.language);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [serviceState, setServiceState] = useState<'checking' | 'online' | 'offline'>('checking');
  const [appVersion, setAppVersion] = useState('0.1.0');
  const runtimeSession = useRuntimeStore((state) => state.session);
  const beginRemoteRead = useRuntimeStore((state) => state.beginRemoteRead);
  const applyRemoteSession = useRuntimeStore((state) => state.applyRemoteSession);
  const beginPlaybackStop = useRuntimeStore((state) => state.beginPlaybackStop);
  const completeRuntimeTransition = useRuntimeStore((state) => state.completeTransition);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const paletteRef = useDialogFocus<HTMLElement>(paletteOpen, () => setPaletteOpen(false));

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'light' : 'dark') : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const controller = new AbortController();
    void commands.getConfig(controller.signal).then((config) => {
      if (config.locale === 'zh-CN' || config.locale === 'en-US') applyLocale(config.locale);
      if (config.theme === 'dark' || config.theme === 'light' || config.theme === 'system') setTheme(config.theme);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [setTheme]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMobileNavOpen(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const check = async () => {
      const runtimeStamp = beginRemoteRead();
      const [health, runtime] = await Promise.allSettled([
        commands.health(controller.signal),
        commands.runtimeState(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setServiceState(health.status === 'fulfilled' ? 'online' : 'offline');
      if (health.status === 'fulfilled') setAppVersion(health.value.version);
      if (
        runtime.status === 'fulfilled'
        && applyRemoteSession(runtime.value.runtime_session, runtimeStamp)
      ) setSessionError(null);
      timer = window.setTimeout(() => void check(), 5_000);
    };
    void check();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyRemoteSession, beginRemoteRead]);

  useEffect(() => {
    if (!sessionNotice) return undefined;
    const timer = window.setTimeout(() => setSessionNotice(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [sessionNotice]);

  const stopPlayback = async () => {
    if (!window.confirm(msg("m0219"))) return;
    const revision = beginPlaybackStop();
    if (revision === null) return;
    setSessionError(null);
    setSessionNotice(null);
    try {
      const result = await commands.stopPlayback();
      completeRuntimeTransition(revision, 'idle');
      setSessionNotice(result.forced_process_stop
        ? msg("m0807")
        : msg("m0780"));
    } catch (cause) {
      setSessionError(readableError(cause));
      try {
        const current = await commands.runtimeState();
        completeRuntimeTransition(revision, current.runtime_session);
      } catch {
        completeRuntimeTransition(revision, 'playback_stopping');
      }
    }
  };

  const filteredNav = useMemo(() => {
    const normalized = query.toLocaleLowerCase();
    return [...primaryNav, ...secondaryNav].filter((item) =>
      t(item.labelKey).toLocaleLowerCase().includes(normalized),
    );
  }, [query, t]);

  const currentNavItem = allDestinations.find((item) => item.path === location.pathname);
  const pageLabel = currentNavItem ? t(currentNavItem.labelKey) : 'Vibe CS';

  const contextActive = (path: string) => {
    if (path === '/library') return ['/library', '/analysis', '/players', '/match-history'].includes(location.pathname);
    if (path === '/production') return ['/production', '/queue', '/studio', '/montage', '/studio/editor'].includes(location.pathname);
    if (path === '/settings') return ['/settings', '/recovery'].includes(location.pathname);
    return false;
  };

  const renderNav = (items: NavItem[]) =>
    items.map(({ path, labelKey, icon: Icon, end }) => (
      <NavLink
        key={path}
        to={path}
        {...(end ? { end: true } : {})}
        className={({ isActive }) => `sidebar-link${isActive || contextActive(path) ? ' is-active' : ''}`}
        onClick={() => setMobileNavOpen(false)}
        {...(sidebarCollapsed ? { title: t(labelKey) } : {})}
      >
        <Icon size={17} strokeWidth={1.8} />
        <span>{t(labelKey)}</span>
      </NavLink>
    ));

  const onPaletteKeyDown = (event: KeyboardEvent<HTMLButtonElement>, path: string) => {
    if (event.key === 'Enter') {
      setPaletteOpen(false);
      void navigate(path);
    }
  };

  return (
    <div
      className={`app-shell${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${mobileNavOpen ? ' is-mobile-nav-open' : ''}`}
      data-route={location.pathname}
    >
      <aside id="app-sidebar" className="sidebar" aria-label={t('shell.mainNavigation')}>
        <div className="sidebar__brand">
          <div className="brand-mark" aria-hidden="true"><span>AL</span></div>
          <div className="brand-copy">
            <strong>Vibe CS</strong>
            <span>STUDIO</span>
          </div>
          <IconButton
            className="sidebar__collapse"
            label={sidebarCollapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')}
            onClick={toggleSidebar}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </IconButton>
        </div>

        <nav className="sidebar__nav">
          <span className="sidebar__label">{t('shell.workspace')}</span>
          {renderNav(primaryNav)}
        </nav>

        <div className="sidebar__bottom">
          <nav>{renderNav(secondaryNav)}</nav>
          <div className="sidebar__utility">
            <IconButton
              label={t('shell.manageLanguage')}
              onClick={() => void navigate('/settings')}
            >
              <Languages size={16} />
            </IconButton>
            <IconButton
              label={theme === 'light' ? msg("m0278") : msg("m0277")}
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            >
              {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
            </IconButton>
            <span className="sidebar__version">v{appVersion}</span>
          </div>
        </div>
      </aside>

      <button
        className="mobile-sidebar-backdrop"
        type="button"
        aria-label={t('shell.close')}
        onClick={() => setMobileNavOpen(false)}
      />

      <div className="app-main">
        <header className="titlebar">
          <div className="titlebar__crumb">
            <span className="titlebar__index" aria-hidden="true">{currentNavItem?.code ?? '00'}</span>
            <FolderKanban size={14} />
            <span>{pageLabel}</span>
          </div>
          <button className="command-trigger" type="button" onClick={() => setPaletteOpen(true)}>
            <Search size={14} />
            <span>{t('shell.jumpSearch')}</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="titlebar__status" title={serviceState === 'online' ? msg("m0790") : serviceState === 'offline' ? msg("m0712") : msg("m0854")}>
            {sessionError ? <span className="titlebar__session-error" role="alert">{sessionError}</span> : null}
            {sessionNotice ? <span className="titlebar__session-notice" role="status">{sessionNotice}</span> : null}
            {runtimeSession === 'playback' || runtimeSession === 'playback_launching' || runtimeSession === 'playback_stopping' ? <button className="titlebar__session-stop" type="button" disabled={runtimeSession !== 'playback'} onClick={() => void stopPlayback()} aria-label={t('shell.stopPlayback')}><PauseCircle size={13} />{runtimeSession === 'playback_launching' ? t('shell.launching') : runtimeSession === 'playback_stopping' ? t('shell.stopping') : t('shell.stopPlayback')}</button> : null}
            <span className={`status-dot${serviceState === 'online' ? ' status-dot--online' : serviceState === 'offline' ? ' status-dot--offline' : ''}`} />
            <span>{serviceState === 'online' ? t('shell.serviceOnline') : serviceState === 'offline' ? t('shell.serviceOffline') : t('shell.connecting')}</span>
          </div>
        </header>

        <main className="content" id="main-content">
          <Outlet />
        </main>
      </div>

      {paletteOpen ? (
        <div className="command-layer" role="presentation" onMouseDown={() => setPaletteOpen(false)}>
          <section
            ref={paletteRef}
            className="command-palette"
            role="dialog"
            aria-modal="true"
            aria-label={t('shell.jumpSearch')}
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="command-palette__search">
              <Search size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('shell.searchPlaceholder')}
              />
              <IconButton label={t('shell.close')} onClick={() => setPaletteOpen(false)}><X size={15} /></IconButton>
            </div>
            <div className="command-palette__results">
              {filteredNav.map(({ path, labelKey, icon: Icon }) => (
                <button
                  type="button"
                  key={path}
                  onClick={() => {
                    setPaletteOpen(false);
                    void navigate(path);
                  }}
                  onKeyDown={(event) => onPaletteKeyDown(event, path)}
                >
                  <Icon size={16} />
                  <span>{t(labelKey)}</span>
                  <ChevronRight size={14} />
                </button>
              ))}
              {filteredNav.length === 0 ? (
                <div className="command-palette__empty"><CircleHelp size={18} />{t('shell.noMatches')}</div>
              ) : null}
            </div>
            <footer><Command size={13} />{t('shell.keyboardHelp')}</footer>
          </section>
        </div>
      ) : null}

      <button
        className="mobile-sidebar-toggle"
        type="button"
        aria-label={mobileNavOpen ? t('shell.close') : t('shell.mainNavigation')}
        aria-controls="app-sidebar"
        aria-expanded={mobileNavOpen}
        onClick={() => setMobileNavOpen((open) => !open)}
      >
        {mobileNavOpen ? <X size={18} /> : <Menu size={18} />}
      </button>
    </div>
  );
}
