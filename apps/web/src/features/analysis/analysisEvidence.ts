import type { LanguagePreference } from '../../shared/stores/uiStore';
import type { TimelineEvent } from '../../shared/desktop/dto';
import { translate, type MessageKey } from '../../shared/i18n';

const roundReasonCatalog: Record<string, MessageKey> = {
  '#SFUI_Notice_CTs_Win': 'analysis.reason.ctElimination',
  '#SFUI_Notice_Terrorists_Win': 'analysis.reason.tElimination',
  '#SFUI_Notice_Target_Bombed': 'analysis.reason.bombExploded',
  '#SFUI_Notice_Bomb_Defused': 'analysis.reason.bombDefused',
  '#SFUI_Notice_Target_Saved': 'analysis.reason.timeExpired',
};

export function roundReasonLabel(reason: string, locale: LanguagePreference): string {
  const normalized = reason.trim();
  if (!normalized) return '';
  const key = roundReasonCatalog[normalized];
  return key ? translate(locale, key) : normalized;
}

export function timelineEventItemEvidence(event: TimelineEvent): string | null {
  const weapon = event.weapon?.trim();
  if (weapon) return weapon;
  if (event.kind !== 'purchase' || typeof event.detail !== 'object' || event.detail === null) return null;
  const itemName = (event.detail as Record<string, unknown>).item_name;
  return typeof itemName === 'string' && itemName.trim() ? itemName.trim() : null;
}
