import { msg } from '../../shared/i18n';
import type { ReplayCacheMetadata } from '../../shared/desktop/dto';

export type ReplayEffectPresentation = {
  className: 'smoke' | 'inferno' | 'decoy' | 'he' | 'flash' | 'event';
  label: string;
  eventOnly: boolean;
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
