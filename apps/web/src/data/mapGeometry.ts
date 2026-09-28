import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useDesktopClient } from './desktopClient';
import { qk } from './keys';
import { decodeMapGeometry } from './mapGeometryBinary';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

export function useMapGeometryStatus(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.config.mapGeometryStatus(),
    queryFn: ({ signal }) => client.mapGeometryStatus(signal),
    ...resolveQueryTuning(tuning),
  });
}

export function useMapGeometry(mapName: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.config.mapGeometry(mapName ?? ''),
    queryFn: async ({ signal }) => {
      const bytes = await client.getMapGeometryBinary(mapName!, signal);
      signal.throwIfAborted();
      return decodeMapGeometry(bytes);
    },
    // Geometry has typed arrays, not JSON trees. Drop unused large meshes after
    // a minute instead of retaining every visited map in the five-minute cache.
    structuralSharing: false,
    gcTime: 60_000,
    ...resolveQueryTuning(tuning, { enabled: mapName !== null }),
  });
}

export function useRebuildMapGeometry() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mapName: string) => client.rebuildMapGeometry(mapName),
    onSuccess: (_status, mapName) => queryClient.invalidateQueries({ queryKey: qk.config.mapGeometry(mapName) }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.config.mapGeometryStatus() }),
  });
}
