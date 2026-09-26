import { create } from 'zustand';

import type { LibraryAddress } from './libraryQuery';

export interface SavedLibraryView {
  readonly name: string;
  readonly address: LibraryAddress;
  readonly hiddenColumns: readonly string[];
}

interface LibrarySession {
  readonly hiddenColumns: ReadonlySet<string>;
  readonly savedViews: readonly SavedLibraryView[];
  readonly setHiddenColumns: (columns: ReadonlySet<string>) => void;
  readonly saveView: (name: string, address: LibraryAddress) => void;
  readonly applyView: (view: SavedLibraryView) => void;
}

/** View preferences survive route changes for this app session, never a new launch. */
export const useLibrarySession = create<LibrarySession>((set) => ({
  hiddenColumns: new Set<string>(),
  savedViews: [],
  setHiddenColumns: (hiddenColumns) => set({ hiddenColumns: new Set(hiddenColumns) }),
  saveView: (name, address) => set((state) => ({
    savedViews: [...state.savedViews, { name, address: { ...address }, hiddenColumns: [...state.hiddenColumns] }],
  })),
  applyView: (view) => set({ hiddenColumns: new Set(view.hiddenColumns) }),
}));
