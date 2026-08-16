import { msg, msgf } from '../../shared/i18n';
import type {
  CosmeticFieldName,
  CosmeticInspectionItem,
  CosmeticPatch,
  CosmeticPlan,
  CosmeticRewriteRequest,
  CosmeticValues,
} from '../../shared/desktop/dto';

export type CosmeticDraft = Record<CosmeticFieldName, string>;
export type CosmeticDrafts = Record<string, CosmeticDraft>;

export const cosmeticItemKey = (item: CosmeticInspectionItem): string =>
  `${item.owner.steam_id64}:${item.item_definition_index}`;

export function initialCosmeticDrafts(items: CosmeticInspectionItem[]): CosmeticDrafts {
  return Object.fromEntries(items.map((item) => [
    cosmeticItemKey(item),
    {
      paint_kit: item.paint_kit?.toString() ?? '',
      seed: item.seed?.toString() ?? '',
      wear: item.wear?.toString() ?? '',
      stat_trak: item.stat_trak?.toString() ?? '',
    },
  ]));
}

/**
 * The patches of a saved plan.
 *
 * `CosmeticPlan.patches` is a `JsonValue` because storage keeps the document
 * as `serde_json::Value` — the hand-written mirror used to claim a typed array
 * the server never guaranteed. Everything that is not a recognisable patch is
 * dropped rather than trusted.
 */
export function cosmeticPlanPatches(plan: CosmeticPlan): CosmeticPatch[] {
  if (!Array.isArray(plan.patches)) return [];
  return plan.patches.filter((entry): entry is CosmeticPatch & Record<string, never> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const target = (entry as Record<string, unknown>).target;
    const values = (entry as Record<string, unknown>).values;
    if (target === null || typeof target !== 'object' || Array.isArray(target)) return false;
    if (values === null || typeof values !== 'object' || Array.isArray(values)) return false;
    const owner = (target as Record<string, unknown>).owner;
    if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) return false;
    return typeof (owner as Record<string, unknown>).steam_id64 === 'string';
  }) as unknown as CosmeticPatch[];
}

export function cosmeticDraftsFromPatches(
  items: CosmeticInspectionItem[],
  patches: CosmeticRewriteRequest['patches'],
): CosmeticDrafts {
  const drafts = initialCosmeticDrafts(items);
  patches.forEach((patch) => {
    const item = items.find((candidate) =>
      candidate.item_definition_index === patch.target.item_definition_index
      && candidate.owner.steam_id64 === patch.target.owner.steam_id64
      && candidate.owner.account_id === patch.target.owner.account_id);
    if (!item) return;
    const key = cosmeticItemKey(item);
    const draft = drafts[key];
    if (!draft) return;
    (Object.entries(patch.values) as Array<[CosmeticFieldName, number | null]>)
      .forEach(([field, value]) => {
        if (value === null) return;
        if (cosmeticFieldEditable(item, field)) draft[field] = value.toString();
      });
  });
  return drafts;
}

export function cosmeticFieldEditable(
  item: CosmeticInspectionItem,
  field: CosmeticFieldName,
): boolean {
  return !item.incompatible_fields.includes(field)
    && (item[field] !== null || item.conflicting_fields.includes(field));
}

export type CosmeticRequestBuild =
  | { request: CosmeticRewriteRequest; changedFields: number; error: null }
  | { request: null; changedFields: 0; error: string };

export function buildCosmeticRewriteRequest(
  items: CosmeticInspectionItem[],
  drafts: CosmeticDrafts,
): CosmeticRequestBuild {
  const patches: CosmeticRewriteRequest['patches'] = [];
  let changedFields = 0;
  for (const item of items) {
    const draft = drafts[cosmeticItemKey(item)];
    if (!draft) continue;
    const values: CosmeticValues = { paint_kit: null, seed: null, wear: null, stat_trak: null };
    for (const field of ['paint_kit', 'seed', 'wear', 'stat_trak'] as const) {
      const raw = draft[field].trim();
      if (!raw || !cosmeticFieldEditable(item, field)) continue;
      const parsed = Number(raw);
      const rangeError = validateField(field, raw, parsed);
      if (rangeError) return { request: null, changedFields: 0, error: rangeError };
      if (item[field] === parsed && !item.conflicting_fields.includes(field)) continue;
      values[field] = parsed;
      changedFields += 1;
    }
    if (Object.values(values).some((value) => value !== null)) {
      patches.push({
        target: {
          owner: item.owner,
          item_definition_index: item.item_definition_index,
        },
        values,
      });
    }
  }
  if (patches.length === 0) {
    return { request: null, changedFields: 0, error: msg("m1146") };
  }
  return { request: { confirm_new_file: true, patches }, changedFields, error: null };
}

function validateField(
  field: CosmeticFieldName,
  raw: string,
  value: number,
): string | null {
  const labels: Record<CosmeticFieldName, string> = {
    paint_kit: msg("m0917"),
    seed: msg("m0837"),
    wear: msg("m1036"),
    stat_trak: 'StatTrak',
  };
  if (!Number.isFinite(value)) return msgf("m0117", [labels[field]]);
  if (field === 'wear') {
    return value >= 0 && value <= 1 ? null : msg("m1037");
  }
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
    return msgf("m0118", [labels[field]]);
  }
  if (field === 'seed' && value > 1000) return msg("m0838");
  if (value > 4_294_967_295) return msgf("m0119", [labels[field]]);
  return null;
}
