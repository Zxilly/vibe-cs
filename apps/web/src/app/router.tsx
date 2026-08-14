import { msg } from '../shared/i18n';
import { lazy, Suspense, type ReactNode } from 'react';
import { createHashRouter, type RouteObject } from 'react-router-dom';

import { AppShell } from './AppShell';
import { NotFound, RouteError } from './RouteError';

const GuidePage = lazy(() => import('../features/guide/GuidePage').then((module) => ({ default: module.GuidePage })));
const LibraryPage = lazy(() => import('../features/library/LibraryPage').then((module) => ({ default: module.LibraryPage })));
const EvidenceSearchPage = lazy(() => import('../features/evidence-search/EvidenceSearchPage').then((module) => ({ default: module.EvidenceSearchPage })));
const AnalysisPage = lazy(() => import('../features/analysis/AnalysisPage').then((module) => ({ default: module.AnalysisPage })));
const PlayersPage = lazy(() => import('../features/players/PlayersPage').then((module) => ({ default: module.PlayersPage })));
const LineupsPage = lazy(() => import('../features/lineups/LineupsPage').then((module) => ({ default: module.LineupsPage })));
const ProductionPage = lazy(() => import('../features/production/ProductionPage').then((module) => ({ default: module.ProductionPage })));
const QueuePage = lazy(() => import('../features/queue/QueuePage').then((module) => ({ default: module.QueuePage })));
const StudioPage = lazy(() => import('../features/studio/StudioPage').then((module) => ({ default: module.StudioPage })));
const MontagePage = lazy(() => import('../features/montage/MontagePage').then((module) => ({ default: module.MontagePage })));
const EditorPage = lazy(() => import('../features/editor/EditorPage').then((module) => ({ default: module.EditorPage })));
const OutputsPage = lazy(() => import('../features/outputs/OutputsPage').then((module) => ({ default: module.OutputsPage })));
const ActivityPage = lazy(() => import('../features/activity/ActivityPage').then((module) => ({ default: module.ActivityPage })));
const SettingsPage = lazy(() => import('../features/settings/SettingsPage').then((module) => ({ default: module.SettingsPage })));
const MatchHistoryPage = lazy(() => import('../features/match-history/MatchHistoryPage').then((module) => ({ default: module.MatchHistoryPage })));
const RecoveryPage = lazy(() => import('../features/recovery/RecoveryPage').then((module) => ({ default: module.RecoveryPage })));
const AceOverlayPrototypePage = lazy(() => import('../features/production/AceOverlayPrototypePage').then((module) => ({ default: module.AceOverlayPrototypePage })));

function LoadingRoute() {
  return <div className="route-loading" role="status"><span className="spinner" /><strong>{msg("m0850")}</strong><span>{msg("m0306")}</span></div>;
}

function suspense(element: ReactNode) {
  return <Suspense fallback={<LoadingRoute />}>{element}</Suspense>;
}

export const routePaths = [
  '/',
  '/library',
  '/evidence-search',
  '/analysis',
  '/players',
  '/lineups',
  '/production',
  '/queue',
  '/studio',
  '/montage',
  '/studio/editor',
  '/outputs',
  '/activity',
  '/settings',
  '/match-history',
  '/recovery',
  '/prototype/ace-overlay',
] as const;

export const appRoutes: RouteObject[] = [
  {
    id: 'ace-overlay-prototype',
    path: '/prototype/ace-overlay',
    element: suspense(<AceOverlayPrototypePage />),
    errorElement: <RouteError />,
  },
  {
    id: 'app-shell',
    path: '/',
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { id: 'guide', index: true, element: suspense(<GuidePage />) },
      { id: 'library', path: 'library', element: suspense(<LibraryPage />) },
      { id: 'evidence-search', path: 'evidence-search', element: suspense(<EvidenceSearchPage />) },
      { id: 'analysis', path: 'analysis', element: suspense(<AnalysisPage />) },
      { id: 'players', path: 'players', element: suspense(<PlayersPage />) },
      { id: 'lineups', path: 'lineups', element: suspense(<LineupsPage />) },
      { id: 'production', path: 'production', element: suspense(<ProductionPage />) },
      { id: 'queue', path: 'queue', element: suspense(<QueuePage />) },
      { id: 'studio', path: 'studio', element: suspense(<StudioPage />) },
      { id: 'montage', path: 'montage', element: suspense(<MontagePage />) },
      { id: 'editor', path: 'studio/editor', element: suspense(<EditorPage />) },
      { id: 'outputs', path: 'outputs', element: suspense(<OutputsPage />) },
      { id: 'activity', path: 'activity', element: suspense(<ActivityPage />) },
      { id: 'settings', path: 'settings', element: suspense(<SettingsPage />) },
      { id: 'match-history', path: 'match-history', element: suspense(<MatchHistoryPage />) },
      { id: 'recovery', path: 'recovery', element: suspense(<RecoveryPage />) },
      { id: 'not-found', path: '*', element: <NotFound /> },
    ],
  },
];

export const routerMode = 'hash' as const;

export const createAppRouter = () => createHashRouter(appRoutes);
