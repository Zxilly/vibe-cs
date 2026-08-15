import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

const memoryValues = new Map<string, string>();
const memoryStorage: Storage = {
  get length() { return memoryValues.size; },
  clear: () => memoryValues.clear(),
  getItem: (key) => memoryValues.get(key) ?? null,
  key: (index) => [...memoryValues.keys()][index] ?? null,
  removeItem: (key) => { memoryValues.delete(key); },
  setItem: (key, value) => { memoryValues.set(key, value); },
};

export type QueueItem = {
  id: string;
  demoId: string;
  highlightId?: string;
  hasVictimPov?: boolean;
  demoName: string;
  playerId: string;
  playerName: string;
  title: string;
  category: 'multi-kill' | 'clutch' | 'entry' | 'utility' | 'custom';
  startTick: number;
  endTick: number;
  tickRate?: number;
  preRollSeconds: number;
  postRollSeconds: number;
  perspective: 'pov' | 'victim';
  cameraStyle: 'pov' | 'orbit' | 'dolly' | 'static' | 'tracking' | 'crane' | 'flyby';
  cameraIntent?: 'player_pov' | 'establish_location' | 'follow_entry' | 'reveal_duel' | 'hold_crossfire' | 'rise_after_climax' | 'transition_through_space';
  cameraRationale?: string;
  mapName?: string;
  enabled: boolean;
  origin: 'preview' | 'demo';
};

type EditableQueueFields = Pick<
  QueueItem,
  | 'title'
  | 'preRollSeconds'
  | 'postRollSeconds'
  | 'perspective'
  | 'cameraStyle'
  | 'enabled'
>;

type QueueState = {
  items: QueueItem[];
  selectedId: string | null;
  add: (item: QueueItem) => void;
  addMany: (items: QueueItem[]) => void;
  replace: (items: QueueItem[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  select: (id: string | null) => void;
  update: (id: string, patch: Partial<EditableQueueFields>) => void;
  move: (id: string, direction: -1 | 1) => void;
  reorder: (sourceIndex: number, destinationIndex: number) => void;
  toggleAll: (enabled: boolean) => void;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const queueItemIdentity = (item: QueueItem): string =>
  item.origin === 'demo' && item.highlightId
    ? `demo:${item.demoId}:${item.highlightId}`
    : `id:${item.id}`;

const normalizeQueueItem = (item: QueueItem): QueueItem =>
  item.origin === 'demo' && !UUID_PATTERN.test(item.id)
    ? { ...item, id: crypto.randomUUID() }
    : item;

const normalizeQueueItems = (items: QueueItem[]): QueueItem[] => items.map(normalizeQueueItem);

export const useQueueStore = create<QueueState>()(
  persist(
    (set) => ({
      items: [],
      selectedId: null,
      add: (item) =>
        set((state) => {
          const normalized = normalizeQueueItem(item);
          const identity = queueItemIdentity(normalized);
          const existing = state.items.find((candidate) => queueItemIdentity(candidate) === identity);
          return existing
            ? { selectedId: existing.id }
            : { items: [...state.items, normalized], selectedId: normalized.id };
        }),
      addMany: (items) =>
        set((state) => {
          const known = new Set(state.items.map(queueItemIdentity));
          const additions: QueueItem[] = [];
          for (const item of normalizeQueueItems(items)) {
            const identity = queueItemIdentity(item);
            if (known.has(identity)) continue;
            known.add(identity);
            additions.push(item);
          }
          return {
            items: [...state.items, ...additions],
            selectedId: additions.at(-1)?.id ?? state.selectedId,
          };
        }),
      replace: (items) => {
        const normalized = normalizeQueueItems(items);
        set({
          items: normalized,
          selectedId: normalized.at(-1)?.id ?? null,
        });
      },
      remove: (id) =>
        set((state) => {
          const items = state.items.filter((item) => item.id !== id);
          return {
            items,
            selectedId: state.selectedId === id ? (items[0]?.id ?? null) : state.selectedId,
          };
        }),
      clear: () => set({ items: [], selectedId: null }),
      select: (selectedId) => set({ selectedId }),
      update: (id, patch) =>
        set((state) => ({
          items: state.items.map((item) => {
            if (item.id !== id) return item;
            const next = { ...item, ...patch };
            if (patch.perspective === 'victim') next.cameraStyle = 'pov';
            if (patch.cameraStyle && patch.cameraStyle !== 'pov') next.perspective = 'pov';
            return next;
          }),
        })),
      move: (id, direction) =>
        set((state) => {
          const sourceIndex = state.items.findIndex((item) => item.id === id);
          const destinationIndex = sourceIndex + direction;
          if (sourceIndex < 0 || destinationIndex < 0 || destinationIndex >= state.items.length) {
            return state;
          }
          const items = [...state.items];
          const [item] = items.splice(sourceIndex, 1);
          if (!item) return state;
          items.splice(destinationIndex, 0, item);
          return { items };
        }),
      reorder: (sourceIndex, destinationIndex) =>
        set((state) => {
          if (
            sourceIndex < 0 ||
            destinationIndex < 0 ||
            sourceIndex >= state.items.length ||
            destinationIndex >= state.items.length ||
            sourceIndex === destinationIndex
          ) {
            return state;
          }
          const items = [...state.items];
          const [item] = items.splice(sourceIndex, 1);
          if (!item) return state;
          items.splice(destinationIndex, 0, item);
          return { items };
        }),
      toggleAll: (enabled) =>
        set((state) => ({ items: state.items.map((item) => ({ ...item, enabled })) })),
    }),
    {
      name: 'vibe-cs:recording-plan',
      storage: createJSONStorage(() => typeof localStorage === 'undefined' ? memoryStorage : localStorage),
      partialize: ({ items, selectedId }) => ({ items, selectedId }),
      merge: (persisted, current) => {
        const state = persisted as Partial<QueueState>;
        const persistedItems = state.items ?? [];
        const items = normalizeQueueItems(persistedItems).map((item) => ({
          ...item,
          cameraStyle: item.cameraStyle ?? 'pov',
        }));
        const selectedIndex = persistedItems.findIndex((item) => item.id === state.selectedId);
        return {
          ...current,
          ...state,
          items,
          selectedId: selectedIndex >= 0 ? (items[selectedIndex]?.id ?? null) : null,
        };
      },
    },
  ),
);
