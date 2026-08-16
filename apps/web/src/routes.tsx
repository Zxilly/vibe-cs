/*
 * The composition root's other half: which page each §7 route renders.
 *
 * It lives beside `main.tsx`, above both layers, for the reason spelled out in
 * `app/router.tsx`: §2.1 rule 3 forbids `app/**` and `pages/**` from importing
 * each other, so the binding between the shell's route table and the pages it
 * shows cannot live in either of them. This file is the seam — the only module
 * in the app that knows both names.
 *
 * Pages stay `lazy()` + `element:` rather than react-router's own `lazy:`, so a
 * slow or failed chunk surfaces through the Suspense and error boundary that
 * `AppShell` already mounts (`RouteBoundary`) instead of through the router's
 * data layer: one loading state and one failure card for the whole shell.
 */

import { lazy } from 'react';
import { createHashRouter, type RouteObject } from 'react-router-dom';

import { createAppRoutes, type RoutePages } from './app/router';

const HomePage = lazy(async () => ({ default: (await import('./pages/HomePage')).HomePage }));
const LibraryPage = lazy(async () => ({ default: (await import('./pages/LibraryPage')).LibraryPage }));
const HistoryPage = lazy(async () => ({ default: (await import('./pages/HistoryPage')).HistoryPage }));
const PlayersPage = lazy(async () => ({ default: (await import('./pages/PlayersPage')).PlayersPage }));
const PlayerProfilePage = lazy(async () => ({
  default: (await import('./pages/PlayerProfilePage')).PlayerProfilePage,
}));
const EvidencePage = lazy(async () => ({ default: (await import('./pages/EvidencePage')).EvidencePage }));
const MatchWorkspacePage = lazy(async () => ({
  default: (await import('./pages/MatchWorkspacePage')).MatchWorkspacePage,
}));
const AgentPage = lazy(async () => ({ default: (await import('./pages/AgentPage')).AgentPage }));
const RecordingPage = lazy(async () => ({ default: (await import('./pages/RecordingPage')).RecordingPage }));
const MontagePage = lazy(async () => ({ default: (await import('./pages/MontagePage')).MontagePage }));
const EditorPage = lazy(async () => ({ default: (await import('./pages/EditorPage')).EditorPage }));
const DeliveryPage = lazy(async () => ({ default: (await import('./pages/DeliveryPage')).DeliveryPage }));
const TaskDetailPage = lazy(async () => ({
  default: (await import('./pages/TaskDetailPage')).TaskDetailPage,
}));
const SettingsPage = lazy(async () => ({ default: (await import('./pages/SettingsPage')).SettingsPage }));
const RecoveryPage = lazy(async () => ({ default: (await import('./pages/RecoveryPage')).RecoveryPage }));
const GuidePage = lazy(async () => ({ default: (await import('./pages/GuidePage')).GuidePage }));

/** Exhaustive by construction — `RoutePages` has one field per §7 destination. */
export const APP_PAGES: RoutePages = {
  home: <HomePage />,
  library: <LibraryPage />,
  history: <HistoryPage />,
  players: <PlayersPage />,
  playerProfile: <PlayerProfilePage />,
  evidence: <EvidencePage />,
  match: <MatchWorkspacePage />,
  agent: <AgentPage />,
  recording: <RecordingPage />,
  montage: <MontagePage />,
  editor: <EditorPage />,
  delivery: <DeliveryPage />,
  deliveryTask: <TaskDetailPage />,
  settings: <SettingsPage />,
  recovery: <RecoveryPage />,
  guide: <GuidePage />,
};

export const appRoutes: RouteObject[] = createAppRoutes(APP_PAGES);

export const createAppRouter = () => createHashRouter(appRoutes);
