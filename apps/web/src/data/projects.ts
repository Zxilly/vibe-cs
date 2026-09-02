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

export function useProjectRenderPreviews(projectId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.projects.renderPreviews(projectId ?? ''),
    queryFn: projectId === null
      ? skipToken
      : ({ signal }: { signal: AbortSignal }) => client.listProjectRenderPreviews(projectId, signal),
    ...resolveQueryTuning(tuning, { enabled: projectId !== null }),
    refetchInterval: (query) => query.state.data?.some((record) => (
      !['completed', 'failed', 'cancelled'].includes(record.job.status)
    )) ? 500 : false,
  });
}

export function useRenderProjectPreview(projectId: string) {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rangeStartSeconds, rangeEndSeconds }: {
      readonly rangeStartSeconds: number;
      readonly rangeEndSeconds: number;
    }) => client.renderProjectPreview(projectId, {
      encoder: 'auto',
      quality: 70,
      range_start_seconds: rangeStartSeconds,
      range_end_seconds: rangeEndSeconds,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.projects.renderPreviews(projectId) }),
  });
}

export function useClearProjectRenderPreviews(projectId: string) {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.clearProjectRenderPreviews(projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.projects.renderPreviews(projectId) }),
  });
}

export function useNestedSequenceMedia(projectId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.projects.nestedSequences(projectId ?? ''),
    queryFn: projectId === null
      ? skipToken
      : ({ signal }: { signal: AbortSignal }) => client.listNestedSequenceMedia(projectId, signal),
    ...resolveQueryTuning(tuning, { enabled: projectId !== null }),
    refetchInterval: (query) => query.state.data?.some((item) => item.status === 'rendering') ? 500 : false,
  });
}

export function useCreateNestedSequence(projectId: string) {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ baseRevision, name, clipIds }: {
      readonly baseRevision: number;
      readonly name: string;
      readonly clipIds: readonly string[];
    }) => client.createNestedSequence(projectId, {
      base_revision: baseRevision,
      name,
      clip_ids: [...clipIds],
    }),
    onSuccess: ({ parent_project: parent, nested_project: nested, change_group: changeGroup }) => {
      queryClient.setQueryData(qk.projects.detail(parent.id), parent);
      queryClient.setQueryData(qk.projects.detail(nested.id), nested);
      queryClient.setQueryData(
        qk.projects.changeGroups(parent.id),
        (current: readonly ProjectChangeGroup[] | undefined) => [changeGroup, ...(current ?? [])],
      );
      return Promise.all([
        invalidateProjects(queryClient),
        queryClient.invalidateQueries({ queryKey: qk.projects.deliveryGate(parent.id) }),
        queryClient.invalidateQueries({ queryKey: qk.projects.nestedSequences(parent.id) }),
      ]).then(() => undefined);
    },
  });
}

export function useRefreshNestedSequence(projectId: string) {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ clipId, baseRevision }: { readonly clipId: string; readonly baseRevision: number }) =>
      client.refreshNestedSequence(projectId, clipId, baseRevision),
    onSuccess: ({ parent_project: parent, change_group: changeGroup }) => {
      queryClient.setQueryData(qk.projects.detail(parent.id), parent);
      queryClient.setQueryData(
        qk.projects.changeGroups(parent.id),
        (current: readonly ProjectChangeGroup[] | undefined) => [changeGroup, ...(current ?? [])],
      );
      return Promise.all([
        invalidateProjects(queryClient),
        queryClient.invalidateQueries({ queryKey: qk.projects.deliveryGate(parent.id) }),
        queryClient.invalidateQueries({ queryKey: qk.projects.nestedSequences(parent.id) }),
      ]).then(() => undefined);
    },
  });
}

export function useCreateMulticam(projectId: string) {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: import('../shared/desktop/dto').CreateMulticamRequest) =>
      client.createMulticam(projectId, request),
    onSuccess: ({ project, change_group: changeGroup }) => {
      queryClient.setQueryData(qk.projects.detail(project.id), project);
      queryClient.setQueryData(
        qk.projects.changeGroups(project.id),
        (current: readonly ProjectChangeGroup[] | undefined) => [changeGroup, ...(current ?? [])],
      );
      return Promise.all([
        invalidateProjects(queryClient),
        queryClient.invalidateQueries({ queryKey: qk.projects.deliveryGate(project.id) }),
      ]).then(() => undefined);
    },
  });
}

export function useSwitchMulticamAngle(projectId: string) {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: { readonly baseRevision: number; readonly groupId: string; readonly angle: number; readonly timelineTime: number }) =>
      client.switchMulticamAngle(projectId, {
        base_revision: request.baseRevision,
        group_id: request.groupId,
        angle: request.angle,
        timeline_time: request.timelineTime,
      }),
    onSuccess: ({ project, change_group: changeGroup }) => {
      queryClient.setQueryData(qk.projects.detail(project.id), project);
      queryClient.setQueryData(
        qk.projects.changeGroups(project.id),
        (current: readonly ProjectChangeGroup[] | undefined) => [changeGroup, ...(current ?? [])],
      );
      return invalidateProjects(queryClient);
    },
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
