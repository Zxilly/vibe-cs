import { currentLocale, msg, translate } from '../../shared/i18n';
import type { ReplayCacheMetadata, ReplayFidelityMetadata, ReplayFrameRecord } from '../../shared/desktop/dto';

export type ReplayEffectPresentation = {
  className: 'smoke' | 'inferno' | 'decoy' | 'he' | 'flash' | 'event';
  label: string;
  eventOnly: boolean;
};

export type ReplayFidelityPresentation = {
  label: string;
  description: string;
  tone: 'success' | 'warning' | 'neutral';
};

export type ReplayPlayerVitalPresentation = {
  healthLabel: string;
  statusLabel: string;
  verified: boolean;
};

export type ReplayPlaybackControlPresentation = {
  buttonLabel: string;
  description: string;
};

export function replayEffectPresentation(kind: string): ReplayEffectPresentation {
  const normalized = kind.trim().toLocaleLowerCase();
  const eventOnly = normalized.endsWith('_event');
  const base = eventOnly ? normalized.slice(0, -'_event'.length) : normalized;
  if (base === 'smoke') return { className: 'smoke', label: msg("m0945"), eventOnly };
  if (base === 'inferno' || base === 'fire' || base === 'molotov') return { className: 'inferno', label: msg("m0948"), eventOnly };
  if (base === 'decoy') return { className: 'decoy', label: msg("m1128"), eventOnly };
  if (base === 'he' || base === 'hegrenade') return { className: 'he', label: msg("m1327"), eventOnly };
  if (base === 'flash' || base === 'flashbang') return { className: 'flash', label: msg("m1276"), eventOnly };
  return { className: 'event', label: msg("m1251"), eventOnly: true };
}

export function replayCacheLabel(cache: ReplayCacheMetadata): string {
  if (cache.state === 'hit') return cache.repaired ? msg("m1084") : msg("m1083");
  if (cache.state === 'generated') return cache.repaired ? msg("m0659") : msg("m0808");
  return msg("m0765");
}

export function replayFidelityPresentation(
  fidelity: ReplayFidelityMetadata,
): ReplayFidelityPresentation {
  if (fidelity.mode === 'event_sparse') {
    return {
      label: translate(currentLocale(), 'analysis.replay.fidelity.eventSparse'),
      description: translate(currentLocale(), 'analysis.replay.fidelity.eventSparseDescription'),
      tone: 'warning',
    };
  }
  if (fidelity.mode === 'hybrid') {
    return {
      label: translate(currentLocale(), 'analysis.replay.fidelity.hybrid'),
      description: translate(currentLocale(), 'analysis.replay.fidelity.hybridDescription'),
      tone: 'neutral',
    };
  }
  return {
    label: translate(currentLocale(), 'analysis.replay.fidelity.entitySnapshots'),
    description: translate(currentLocale(), 'analysis.replay.fidelity.entitySnapshotsDescription'),
    tone: 'success',
  };
}

export function replayPlaybackControlPresentation(
  mode: ReplayFidelityMetadata['mode'],
  speed: 0.5 | 1 | 2,
): ReplayPlaybackControlPresentation {
  if (mode === 'event_sparse') {
    const speedKey = speed === 0.5
      ? 'analysis.replay.timing.sparseSlow'
      : speed === 2
        ? 'analysis.replay.timing.sparseFast'
        : 'analysis.replay.timing.sparseStandard';
    return {
      buttonLabel: translate(currentLocale(), speedKey),
      description: translate(currentLocale(), 'analysis.replay.timing.sparseDescription'),
    };
  }
  return {
    buttonLabel: `${speed.toFixed(1)}×`,
    description: translate(currentLocale(), 'analysis.replay.timing.realtimeDescription'),
  };
}

export function replayPlayerVitalPresentation(
  player: ReplayFrameRecord['players'][number],
): ReplayPlayerVitalPresentation {
  const verified = !player.alive || player.health > 0;
  if (!verified) {
    return {
      healthLabel: 'HP —',
      statusLabel: translate(currentLocale(), 'analysis.replay.statusUnknown'),
      verified: false,
    };
  }
  return {
    healthLabel: `HP ${player.health.toLocaleString(currentLocale())}`,
    statusLabel: player.alive ? msg('m0440') : msg('m1282'),
    verified: true,
  };
}
