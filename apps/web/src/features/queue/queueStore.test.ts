import { beforeEach, describe, expect, it } from 'vitest';

import { useQueueStore, type QueueItem } from './queueStore';
import { queueTestItems } from './queueTestFixtures';

const realItem: QueueItem = {
  ...queueTestItems[0]!,
  id: 'd783d432-74c3-4025-b13b-cdce293c13ae',
  demoId: '1c35e027-20cf-42c7-833e-edfdd6672524',
  title: '真实片段',
  origin: 'demo',
};

describe('queue store', () => {
  beforeEach(() => {
    useQueueStore.setState({ items: [...queueTestItems], selectedId: queueTestItems[0]?.id ?? null });
  });

  it('adds an item once and selects it', () => {
    useQueueStore.getState().add(realItem);
    useQueueStore.getState().add(realItem);

    expect(useQueueStore.getState().items.filter((item) => item.id === realItem.id)).toHaveLength(1);
    expect(useQueueStore.getState().selectedId).toBe(realItem.id);
  });

  it('reorders items without losing their identity', () => {
    const initialIds = useQueueStore.getState().items.map((item) => item.id);
    useQueueStore.getState().reorder(0, 2);

    const result = useQueueStore.getState().items.map((item) => item.id);
    expect(result).toEqual([initialIds[1], initialIds[2], initialIds[0]]);
    expect(new Set(result)).toEqual(new Set(initialIds));
  });

  it('updates editable recording parameters and repairs selection on removal', () => {
    const id = queueTestItems[0]!.id;
    useQueueStore.getState().update(id, { preRollSeconds: 5, enabled: false });
    expect(useQueueStore.getState().items[0]).toMatchObject({ preRollSeconds: 5, enabled: false });

    useQueueStore.getState().remove(id);
    expect(useQueueStore.getState().selectedId).toBe(useQueueStore.getState().items[0]?.id ?? null);
  });

  it('stores only parameters supported by the current native capture model', () => {
    for (const item of useQueueStore.getState().items) {
      expect(item).not.toHaveProperty('playbackSpeed');
      expect(item).not.toHaveProperty('showKeyboard');
      expect(item).not.toHaveProperty('showKillFx');
    }
  });

  it('persists the ordered recording plan and selection across a store reload', async () => {
    useQueueStore.getState().clear();
    useQueueStore.getState().add(realItem);

    const options = useQueueStore.persist.getOptions();
    const storageName = options.name;
    expect(storageName).toBe('vibe-cs:recording-plan');
    expect(storageName).toBeDefined();
    if (!storageName) throw new Error('queue persistence storage name is required');
    const snapshot = await options.storage?.getItem(storageName);
    expect(snapshot).toMatchObject({
      state: {
        items: [expect.objectContaining({ id: realItem.id, demoId: realItem.demoId })],
        selectedId: realItem.id,
      },
    });
    useQueueStore.getState().clear();
    if (snapshot) await options.storage?.setItem(storageName, snapshot);
    await useQueueStore.persist.rehydrate();

    expect(useQueueStore.getState().items).toEqual([realItem]);
    expect(useQueueStore.getState().selectedId).toBe(realItem.id);
  });
});
