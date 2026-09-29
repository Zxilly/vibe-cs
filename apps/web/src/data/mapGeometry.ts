import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useDesktopClient } from './desktopClient';
import { qk } from './keys';
import { decodeMapGeometry } from './mapGeometryBinary';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

export function useMapGeometryCache(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.config.mapGeometryCache(),
    queryFn: ({ signal }) => client.mapGeometryCache(signal),
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

export function useClearMapGeometryCache() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.clearMapGeometryCache(),
    // Existing views keep their presented frame. Reload only when needed again;
    // immediately refetching active meshes would undo the user's cleanup.
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.config.mapGeometries(), refetchType: 'none' }),
      queryClient.invalidateQueries({ queryKey: qk.projects.cameraPreviews(), refetchType: 'none' }),
    ]).then(() => undefined),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.config.mapGeometryCache() }),
  });
}
