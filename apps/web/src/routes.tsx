/*
 * The application route table and its lazy page bindings.
 *
 * Pages stay `lazy()` + `element:` rather than react-router's own `lazy:`, so a
 * slow or failed chunk surfaces through the Suspense and error boundary that
 * `AppShell` mounts (`RouteBoundary`) instead of through the router's
 * data layer: one loading state and one failure card for the whole shell.
 */

import { lazy } from 'react';
import { createHashRouter, type RouteObject } from 'react-router-dom';

import { AppShell } from './app/AppShell';
import { NotFound, RouteErrorElement } from './app/boundary';

const HomePage = lazy(async () => ({ default: (await import('./pages/HomePage')).HomePage }));
const LibraryPage = lazy(async () => ({ default: (await import('./pages/LibraryPage')).LibraryPage }));
const PlayersPage = lazy(async () => ({ default: (await import('./pages/PlayersPage')).PlayersPage }));
const PlayerProfilePage = lazy(async () => ({
  default: (await import('./pages/PlayerProfilePage')).PlayerProfilePage,
}));
const EvidencePage = lazy(async () => ({ default: (await import('./pages/EvidencePage')).EvidencePage }));
const MatchWorkspacePage = lazy(async () => ({
  default: (await import('./pages/MatchWorkspacePage')).MatchWorkspacePage,
}));
const ProjectsPage = lazy(async () => ({ default: (await import('./pages/ProjectsPage')).ProjectsPage }));
const ProjectWorkspacePage = lazy(async () => ({
  default: (await import('./pages/ProjectWorkspacePage')).ProjectWorkspacePage,
}));
const DeliveryPage = lazy(async () => ({ default: (await import('./pages/DeliveryPage')).DeliveryPage }));
const TaskDetailPage = lazy(async () => ({
  default: (await import('./pages/TaskDetailPage')).TaskDetailPage,
}));
const SettingsPage = lazy(async () => ({ default: (await import('./pages/SettingsPage')).SettingsPage }));
const RecoveryPage = lazy(async () => ({ default: (await import('./pages/RecoveryPage')).RecoveryPage }));
const GuidePage = lazy(async () => ({ default: (await import('./pages/GuidePage')).GuidePage }));

export const APP_PAGES = {
  home: <HomePage />,
  library: <LibraryPage />,
  players: <PlayersPage />,
  playerProfile: <PlayerProfilePage />,
  evidence: <EvidencePage />,
  match: <MatchWorkspacePage />,
  projects: <ProjectsPage />,
  projectWorkspace: <ProjectWorkspacePage />,
  delivery: <DeliveryPage />,
  deliveryTask: <TaskDetailPage />,
  settings: <SettingsPage />,
  recovery: <RecoveryPage />,
  guide: <GuidePage />,
};

export const ROUTE_PATHS = [
  '/',
  '/library',
  '/players',
  '/players/:playerId',
  '/evidence',
  '/match/:demoId',
  '/projects',
  '/projects/:projectId',
  '/delivery',
  '/delivery/task/:taskId',
  '/settings',
  '/recovery',
  '/guide',
] as const;

export const appRoutes: RouteObject[] = [
  {
    id: 'app-shell',
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorElement />,
    children: [
      { id: 'home', index: true, element: APP_PAGES.home },
      { id: 'library', path: 'library', element: APP_PAGES.library },
      { id: 'players', path: 'players', element: APP_PAGES.players },
      { id: 'player-profile', path: 'players/:playerId', element: APP_PAGES.playerProfile },
      { id: 'evidence', path: 'evidence', element: APP_PAGES.evidence },
      { id: 'match', path: 'match/:demoId', element: APP_PAGES.match },
      { id: 'projects', path: 'projects', element: APP_PAGES.projects },
      { id: 'project-workspace', path: 'projects/:projectId', element: APP_PAGES.projectWorkspace },
      { id: 'delivery', path: 'delivery', element: APP_PAGES.delivery },
      { id: 'delivery-task', path: 'delivery/task/:taskId', element: APP_PAGES.deliveryTask },
      { id: 'settings', path: 'settings', element: APP_PAGES.settings },
      { id: 'recovery', path: 'recovery', element: APP_PAGES.recovery },
      { id: 'guide', path: 'guide', element: APP_PAGES.guide },
      { id: 'not-found', path: '*', element: <NotFound /> },
    ],
  },
];

export const routerMode = 'hash' as const;
export const createAppRouter = () => createHashRouter(appRoutes);
