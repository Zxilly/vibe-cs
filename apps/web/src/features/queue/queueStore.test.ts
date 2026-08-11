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
    useQueueStore.getState().update(id, { preRollSeconds: 5, showKillFx: false });
    expect(useQueueStore.getState().items[0]).toMatchObject({ preRollSeconds: 5, showKillFx: false });

    useQueueStore.getState().remove(id);
    expect(useQueueStore.getState().selectedId).toBe(useQueueStore.getState().items[0]?.id ?? null);
  });
});
