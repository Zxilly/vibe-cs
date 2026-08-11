import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commands } from '../desktop/client';
import { runManagedPlaybackLaunch, useRuntimeStore } from './runtimeStore';

describe('runtime session ordering', () => {
  beforeEach(() => {
    useRuntimeStore.setState({
      session: 'idle',
      revision: 0,
      remoteRequestId: 0,
      transitionActive: false,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('ignores an old remote snapshot after a local launch transition begins', () => {
    const stamp = useRuntimeStore.getState().beginRemoteRead();
    expect(useRuntimeStore.getState().beginPlaybackLaunch()).toBe(1);
    expect(useRuntimeStore.getState().applyRemoteSession('idle', stamp)).toBe(false);
    expect(useRuntimeStore.getState().session).toBe('playback_launching');
  });

  it('allows only the newest overlapping remote read to commit', () => {
    const older = useRuntimeStore.getState().beginRemoteRead();
    const newer = useRuntimeStore.getState().beginRemoteRead();
    expect(useRuntimeStore.getState().applyRemoteSession('playback', older)).toBe(false);
    expect(useRuntimeStore.getState().applyRemoteSession('recording', newer)).toBe(true);
    expect(useRuntimeStore.getState().session).toBe('recording');
  });

  it('uses one global stop transition for every UI entry point', () => {
    const read = useRuntimeStore.getState().beginRemoteRead();
    expect(useRuntimeStore.getState().applyRemoteSession('playback', read)).toBe(true);
    const revision = useRuntimeStore.getState().beginPlaybackStop();
    expect(revision).toBe(1);
    expect(useRuntimeStore.getState().beginPlaybackStop()).toBeNull();
    expect(useRuntimeStore.getState().completeTransition(revision!, 'idle')).toBe(true);
    expect(useRuntimeStore.getState().session).toBe('idle');
  });

  it('rejects a completion from an older transition revision', () => {
    const first = useRuntimeStore.getState().beginPlaybackLaunch();
    expect(useRuntimeStore.getState().completeTransition(first!, 'playback')).toBe(true);
    const stop = useRuntimeStore.getState().beginPlaybackStop();
    expect(useRuntimeStore.getState().completeTransition(first!, 'idle')).toBe(false);
    expect(useRuntimeStore.getState().completeTransition(stop!, 'idle')).toBe(true);
  });

  it('keeps an unknown failed launch conservatively blocked until polling reconciles it', async () => {
    vi.spyOn(commands, 'runtimeState').mockRejectedValue(new Error('status unavailable'));
    await expect(runManagedPlaybackLaunch(async () => {
      throw new Error('launch response lost');
    })).rejects.toThrow('launch response lost');
    expect(useRuntimeStore.getState().session).toBe('playback_launching');
    expect(useRuntimeStore.getState().transitionActive).toBe(false);
  });
});
