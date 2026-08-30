import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import type {
  AcquireProjectEditLeaseRequest,
  CreateProjectRequest,
  HeartbeatProjectEditLeaseRequest,
  ProjectChangeGroup,
  ProjectPatch,
} from '../shared/desktop/dto';
import { useDesktopClient } from './desktopClient';
import { qk } from './keys';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

export function useProjects(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.projects.list(),
    queryFn: ({ signal }) => client.listProjects(signal),
    ...resolveQueryTuning(tuning),
  });
}

export function useProject(projectId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.projects.detail(projectId ?? ''),
    queryFn: projectId === null
      ? skipToken
      : ({ signal }: { signal: AbortSignal }) => client.getProject(projectId, signal),
    ...resolveQueryTuning(tuning, { enabled: projectId !== null }),
  });
}

export function useProjectDeliveryGate(projectId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.projects.deliveryGate(projectId ?? ''),
    queryFn: projectId === null
      ? skipToken
      : ({ signal }: { signal: AbortSignal }) => client.getProjectDeliveryGate(projectId, signal),
    ...resolveQueryTuning(tuning, { enabled: projectId !== null }),
  });
}

export function useProjectChangeGroups(projectId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.projects.changeGroups(projectId ?? ''),
    queryFn: projectId === null
      ? skipToken
      : ({ signal }: { signal: AbortSignal }) => client.listProjectChangeGroups(projectId, signal),
    ...resolveQueryTuning(tuning, { enabled: projectId !== null }),
  });
}

export function useProjectEditLease(projectId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.projects.editLease(projectId ?? ''),
    queryFn: projectId === null
      ? skipToken
      : ({ signal }: { signal: AbortSignal }) => client.getProjectEditLease(projectId, signal),
    ...resolveQueryTuning({ ...tuning, pollMs: tuning.pollMs ?? 1_000 }, { enabled: projectId !== null }),
  });
}

export function useCreateProject() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateProjectRequest) => client.createProject(request),
    onSuccess: (project) => {
      queryClient.setQueryData(qk.projects.detail(project.id), project);
      return invalidateProjects(queryClient);
    },
  });
}

export function useApplyProjectPatch() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: ProjectPatch) => client.applyProjectPatch(patch),
    onSuccess: ({ project, change_group: changeGroup }) => {
      queryClient.setQueryData(qk.projects.detail(project.id), project);
      queryClient.setQueryData(
        qk.projects.changeGroups(project.id),
        (current: readonly ProjectChangeGroup[] | undefined) => [
          changeGroup,
          ...(current ?? []).filter((group) => group.id !== changeGroup.id),
        ],
      );
      return invalidateProjects(queryClient);
    },
  });
}

export function useStartProjectRecording() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, clipIds = [] }: {
      readonly projectId: string;
      readonly clipIds?: string[];
    }) => {
      const plan = await client.createProjectRecordingPlan(projectId, clipIds);
      return client.executeRecordingPlan(projectId, plan.plan_id, true);
    },
    onSuccess: (_job, input) => Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.projects.detail(input.projectId) }),
      queryClient.invalidateQueries({ queryKey: qk.tasks.all }),
    ]).then(() => undefined),
  });
}

export function useExportProject() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, encoder = 'auto', quality = 80, rangeStartSeconds, rangeEndSeconds }: {
      readonly projectId: string;
      readonly encoder?: string;
      readonly quality?: number;
      readonly rangeStartSeconds?: number;
      readonly rangeEndSeconds?: number;
    }) => client.exportProject(projectId, {
      encoder,
      quality,
      ...(rangeStartSeconds === undefined ? {} : { range_start_seconds: rangeStartSeconds }),
      ...(rangeEndSeconds === undefined ? {} : { range_end_seconds: rangeEndSeconds }),
    }),
    onSuccess: (_job, input) => Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.projects.detail(input.projectId) }),
      queryClient.invalidateQueries({ queryKey: qk.tasks.all }),
    ]).then(() => undefined),
  });
}

export function useRevertProjectChangeGroup(projectId: string) {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ changeGroupId, expectedRevision }: {
      readonly changeGroupId: string;
      readonly expectedRevision: number;
    }) => client.revertProjectChangeGroup(projectId, changeGroupId, expectedRevision),
    onSuccess: ({ project }) => {
      queryClient.setQueryData(qk.projects.detail(project.id), project);
      return Promise.all([
        invalidateProjects(queryClient),
        queryClient.invalidateQueries({ queryKey: qk.projects.changeGroups(project.id) }),
      ]).then(() => undefined);
    },
  });
}

export function useAcquireProjectEditLease(projectId: string) {
  const client = useDesktopClient();
  return useMutation({
    mutationFn: (request: AcquireProjectEditLeaseRequest) =>
      client.acquireProjectEditLease(projectId, request),
  });
}

export function useHeartbeatProjectEditLease(projectId: string, leaseId: string) {
  const client = useDesktopClient();
  return useMutation({
    mutationFn: (request: HeartbeatProjectEditLeaseRequest) =>
      client.heartbeatProjectEditLease(projectId, leaseId, request),
  });
}

export function useReleaseProjectEditLease(projectId: string) {
  const client = useDesktopClient();
  return useMutation({
    mutationFn: (leaseId: string) => client.releaseProjectEditLease(projectId, leaseId),
  });
}

export function invalidateProjects(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.projects.all });
}
