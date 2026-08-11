import { currentLocale, msg } from '../../shared/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readableError } from '../../shared/api/client';
import type {
  ObsVideoBackup,
  ObsVideoField,
  ObsVideoSettingsSnapshot,
  ObsVideoTuningPlan,
} from '../../shared/api/dto';
import {
  ObsTuningPanel,
  type ObsTuningActionResult,
  type ObsTuningPanelState,
} from './ObsTuningPanel';

type ObsTuningSectionProps = {
  serviceAvailable: boolean;
  serviceLoading: boolean;
  savedConfigAvailable: boolean;
  savedObsConfigured: boolean;
  hasUnsavedRuntimeSettings: boolean;
};

const FIELD_LABELS: Record<ObsVideoField, string> = {
  output_resolution: msg("m1186"),
  frame_rate: msg("m0549"),
};

const EXCLUDED_FIELD_LABELS: Record<string, string> = {
  base_canvas: msg("m0406"),
  encoder: msg("m1085"),
  bitrate: msg("m1027"),
  scene: msg("m0401"),
};

const WARNING_LABELS: Record<string, string> = {
  'OBS is recording; applying this plan is blocked': msg("m0056"),
  'OBS output video settings already match the saved defaults': msg("m0063"),
};

const BACKUP_DATE_FORMATTER = new Intl.DateTimeFormat(currentLocale(), {
  dateStyle: 'short',
  timeStyle: 'short',
  hour12: false,
});

export function toObsTuningPanelState(
  plan: ObsVideoTuningPlan,
  backups: ObsVideoBackup[],
): ObsTuningPanelState {
  return {
    status: 'ready',
    plan: {
      expectedFingerprint: plan.expected_fingerprint,
      recordingActive: plan.recording_active,
      currentResolution: formatResolution(plan.current),
      currentFrameRate: formatFrameRate(plan.current),
      targetResolution: formatResolution(plan.target),
      targetFrameRate: formatFrameRate(plan.target),
      changes: plan.diff.map((change) => ({
        id: change.field,
        label: FIELD_LABELS[change.field],
        current: change.current,
        target: change.target,
      })),
      warnings: plan.warnings.map((warning) => WARNING_LABELS[warning] ?? warning),
      excludedFields: plan.excluded_fields.map(
        (field) => EXCLUDED_FIELD_LABELS[field] ?? field,
      ),
    },
    backups: backups.map((backup) => ({
      id: backup.id,
      createdAt: formatBackupDate(backup.created_at),
      reason: backup.reason === 'before_restore' ? msg("m0621") : msg("m0554"),
      resolution: formatResolution(backup.settings),
      frameRate: formatFrameRate(backup.settings),
    })),
  };
}

function formatResolution(settings: ObsVideoSettingsSnapshot): string {
  return `${settings.output_width} × ${settings.output_height}`;
}

function formatFrameRate(settings: ObsVideoSettingsSnapshot): string {
  if (settings.fps_denominator <= 0) return msg("m0147");
  const ratio = `${settings.fps_numerator}/${settings.fps_denominator}`;
  const value = settings.fps_numerator / settings.fps_denominator;
  const fps = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return `${ratio} · ${fps} FPS`;
}

function formatBackupDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return BACKUP_DATE_FORMATTER.format(date);
}

export function obsTuningGateState({
  serviceAvailable,
  serviceLoading,
  savedConfigAvailable,
  savedObsConfigured,
  hasUnsavedRuntimeSettings,
}: ObsTuningSectionProps): Exclude<ObsTuningPanelState, { status: 'ready' }> | null {
  if (serviceLoading) {
    return { status: 'loading', message: msg("m0859") };
  }
  if (!serviceAvailable) {
    return { status: 'unavailable', message: msg("m0793") };
  }
  if (!savedConfigAvailable || !savedObsConfigured) {
    return { status: 'unavailable', message: msg("m1132") };
  }
  if (hasUnsavedRuntimeSettings) {
    return { status: 'unavailable', message: msg("m0439") };
  }
  return null;
}

export function canCommitObsTuningRefresh(
  requestGeneration: number,
  currentGeneration: number,
  aborted: boolean,
  latestGate: ObsTuningPanelState | null,
): boolean {
  return requestGeneration === currentGeneration && !aborted && latestGate === null;
}

export function ObsTuningSection({
  serviceAvailable,
  serviceLoading,
  savedConfigAvailable,
  savedObsConfigured,
  hasUnsavedRuntimeSettings,
}: ObsTuningSectionProps) {
  const [state, setState] = useState<ObsTuningPanelState>(() =>
    obsTuningGateState({
      serviceAvailable,
      serviceLoading,
      savedConfigAvailable,
      savedObsConfigured,
      hasUnsavedRuntimeSettings,
    }) ?? { status: 'loading', message: msg("m0864") },
  );
  const refreshController = useRef<AbortController | null>(null);
  const operationGeneration = useRef(0);
  const mounted = useRef(true);
  const gateProps = useRef<ObsTuningSectionProps>({
    serviceAvailable,
    serviceLoading,
    savedConfigAvailable,
    savedObsConfigured,
    hasUnsavedRuntimeSettings,
  });
  gateProps.current = {
    serviceAvailable,
    serviceLoading,
    savedConfigAvailable,
    savedObsConfigured,
    hasUnsavedRuntimeSettings,
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationGeneration.current += 1;
      refreshController.current?.abort();
    };
  }, []);

  const refresh = useCallback(async () => {
    refreshController.current?.abort();
    refreshController.current = null;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    const unavailable = obsTuningGateState(gateProps.current);
    if (unavailable) {
      if (mounted.current) setState(unavailable);
      return;
    }

    const controller = new AbortController();
    refreshController.current = controller;
    setState({ status: 'loading', message: msg("m0864") });
    try {
      const [plan, backups] = await Promise.all([
        api.getObsVideoTuningPlan(controller.signal),
        api.listObsVideoBackups(controller.signal),
      ]);
      const latestGate = obsTuningGateState(gateProps.current);
      if (canCommitObsTuningRefresh(
        generation,
        operationGeneration.current,
        controller.signal.aborted,
        latestGate,
      ) && mounted.current) {
        setState(toObsTuningPanelState(plan, backups));
      } else if (
        generation === operationGeneration.current
        && !controller.signal.aborted
        && latestGate
        && mounted.current
      ) {
        setState(latestGate);
      }
    } catch (error) {
      if (controller.signal.aborted || generation !== operationGeneration.current) return;
      const latestGate = obsTuningGateState(gateProps.current);
      if (mounted.current) {
        setState(latestGate ?? { status: 'error', message: readableError(error) });
      }
      if (!latestGate) throw error;
    } finally {
      if (generation === operationGeneration.current) refreshController.current = null;
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
    return () => refreshController.current?.abort();
  }, [
    hasUnsavedRuntimeSettings,
    refresh,
    savedConfigAvailable,
    savedObsConfigured,
    serviceAvailable,
    serviceLoading,
  ]);

  const beginMutation = useCallback(() => {
    operationGeneration.current += 1;
    refreshController.current?.abort();
    refreshController.current = null;
    const unavailable = obsTuningGateState(gateProps.current);
    if (unavailable) {
      if (mounted.current) setState(unavailable);
      throw new Error(unavailable.message);
    }
  }, []);

  const apply = useCallback(async (expectedFingerprint: string): Promise<ObsTuningActionResult> => {
    beginMutation();
    const result = await api.applyObsVideoTuningPlan(expectedFingerprint);
    try {
      if (mounted.current) await refresh();
    } catch {
      return {
        tone: 'warning',
        message: msg("m0052"),
      };
    }
    return {
      message: result.applied
        ? msg("m0064")
        : msg("m0062"),
    };
  }, [beginMutation, refresh]);

  const restore = useCallback(async (backupId: string): Promise<ObsTuningActionResult> => {
    beginMutation();
    await api.restoreObsVideoBackup(backupId);
    try {
      if (mounted.current) await refresh();
    } catch {
      return {
        tone: 'warning',
        message: msg("m0412"),
      };
    }
    return { message: msg("m0410") };
  }, [beginMutation, refresh]);

  const remove = useCallback(async (backupId: string): Promise<ObsTuningActionResult> => {
    beginMutation();
    await api.deleteObsVideoBackup(backupId);
    try {
      if (mounted.current) await refresh();
    } catch {
      return {
        tone: 'warning',
        message: msg("m0411"),
      };
    }
    return { message: msg("m0776") };
  }, [beginMutation, refresh]);

  return (
    <ObsTuningPanel
      state={state}
      onRefresh={refresh}
      onApply={apply}
      onRestore={restore}
      onDelete={remove}
    />
  );
}
