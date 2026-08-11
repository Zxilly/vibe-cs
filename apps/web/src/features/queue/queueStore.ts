import { create } from 'zustand';

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
  playbackSpeed: number;
  perspective: 'pov' | 'victim';
  showKeyboard: boolean;
  showKillFx: boolean;
  enabled: boolean;
  origin: 'preview' | 'demo';
};

type EditableQueueFields = Pick<
  QueueItem,
  | 'title'
  | 'preRollSeconds'
  | 'postRollSeconds'
  | 'playbackSpeed'
  | 'perspective'
  | 'showKeyboard'
  | 'showKillFx'
  | 'enabled'
>;

type QueueState = {
  items: QueueItem[];
  selectedId: string | null;
  add: (item: QueueItem) => void;
  addMany: (items: QueueItem[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  select: (id: string | null) => void;
  update: (id: string, patch: Partial<EditableQueueFields>) => void;
  move: (id: string, direction: -1 | 1) => void;
  reorder: (sourceIndex: number, destinationIndex: number) => void;
  toggleAll: (enabled: boolean) => void;
};

export const useQueueStore = create<QueueState>((set) => ({
  items: [],
  selectedId: null,
  add: (item) =>
    set((state) =>
      state.items.some((existing) => existing.id === item.id)
        ? { selectedId: item.id }
        : { items: [...state.items, item], selectedId: item.id },
    ),
  addMany: (items) =>
    set((state) => {
      const known = new Set(state.items.map((item) => item.id));
      const additions = items.filter((item) => !known.has(item.id));
      return {
        items: [...state.items, ...additions],
        selectedId: additions.at(-1)?.id ?? state.selectedId,
      };
    }),
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
      items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
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
}));
