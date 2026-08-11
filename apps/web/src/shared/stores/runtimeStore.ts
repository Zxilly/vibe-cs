import { msg } from '../i18n';
import { create } from 'zustand';

import { ApiError, api } from '../api/client';
import type { RuntimeState } from '../api/dto';

export type RuntimeSession = RuntimeState['runtime_session'];

export type RuntimeReadStamp = {
  requestId: number;
  revision: number;
};

type RuntimeStore = {
  session: RuntimeSession;
  revision: number;
  remoteRequestId: number;
  transitionActive: boolean;
  beginRemoteRead: () => RuntimeReadStamp;
  applyRemoteSession: (session: RuntimeSession, stamp: RuntimeReadStamp) => boolean;
  beginPlaybackLaunch: () => number | null;
  beginPlaybackStop: () => number | null;
  completeTransition: (revision: number, session: RuntimeSession) => boolean;
};

export const useRuntimeStore = create<RuntimeStore>((set, get) => ({
  session: 'idle',
  revision: 0,
  remoteRequestId: 0,
  transitionActive: false,
  beginRemoteRead: () => {
    const current = get();
    const stamp = {
      requestId: current.remoteRequestId + 1,
      revision: current.revision,
    };
    set({ remoteRequestId: stamp.requestId });
    return stamp;
  },
  applyRemoteSession: (session, stamp) => {
    const current = get();
    if (
      current.transitionActive
      || current.revision !== stamp.revision
      || current.remoteRequestId !== stamp.requestId
    ) return false;
    set({ session });
    return true;
  },
  beginPlaybackLaunch: () => beginTransition(get, set, 'idle', 'playback_launching'),
  beginPlaybackStop: () => beginTransition(get, set, 'playback', 'playback_stopping'),
  completeTransition: (revision, session) => {
    const current = get();
    if (!current.transitionActive || current.revision !== revision) return false;
    set({
      session,
      revision: revision + 1,
      transitionActive: false,
    });
    return true;
  },
}));

function beginTransition(
  get: () => RuntimeStore,
  set: (partial: Partial<RuntimeStore>) => void,
  expected: RuntimeSession,
  next: RuntimeSession,
): number | null {
  const current = get();
  if (current.transitionActive || current.session !== expected) return null;
  const revision = current.revision + 1;
  set({ session: next, revision, transitionActive: true });
  return revision;
}

export async function runManagedPlaybackLaunch<T>(launch: () => Promise<T>): Promise<T> {
  const revision = useRuntimeStore.getState().beginPlaybackLaunch();
  if (revision === null) {
    throw new ApiError(msg("m0800"), 409, 'RUNTIME_SESSION_BUSY');
  }
  try {
    const result = await launch();
    useRuntimeStore.getState().completeTransition(revision, 'playback');
    return result;
  } catch (error) {
    try {
      const current = await api.runtimeState();
      useRuntimeStore.getState().completeTransition(revision, current.runtime_session);
    } catch {
      useRuntimeStore.getState().completeTransition(revision, 'playback_launching');
    }
    throw error;
  }
}
