import { describe, expect, it } from 'vitest';

import type { CosmeticInspectionItem } from '../../shared/api/dto';
import {
  buildCosmeticRewriteRequest,
  cosmeticDraftsFromPatches,
  cosmeticFieldEditable,
  initialCosmeticDrafts,
} from './cosmetics';

const item: CosmeticInspectionItem = {
  owner: { steam_id64: '76561197960389184', account_id: 123_456 },
  item_definition_index: 7,
  match_basis: 'both',
  entity_handles: [1, 2],
  class_names: ['CWeaponAK47'],
  paint_kit: 600,
  seed: 321,
  wear: 0.12,
  stat_trak: null,
  incompatible_fields: ['stat_trak'],
  conflicting_fields: [],
};

describe('cosmetic rewrite request', () => {
  it('emits only changed, allow-listed values with the stable target', () => {
    const drafts = initialCosmeticDrafts([item]);
    const key = Object.keys(drafts)[0]!;
    drafts[key]!.paint_kit = '700';
    const built = buildCosmeticRewriteRequest([item], drafts);
    expect(built.error).toBeNull();
    if (built.request) {
      expect(built.request).toEqual({ confirm_new_file: true, patches: [{
        target: { owner: item.owner, item_definition_index: 7 },
        values: { paint_kit: 700 },
      }] });
      expect(built.changedFields).toBe(1);
    }
  });

  it('rejects out-of-range seed values before sending', () => {
    const drafts = initialCosmeticDrafts([item]);
    const key = Object.keys(drafts)[0]!;
    drafts[key]!.seed = '1001';
    expect(buildCosmeticRewriteRequest([item], drafts).error).toContain('0 到 1000');
  });

  it('does not offer a field with incompatible wire evidence', () => {
    expect(cosmeticFieldEditable(item, 'stat_trak')).toBe(false);
  });

  it('loads a saved plan only into the matching stable item and writable fields', () => {
    const drafts = cosmeticDraftsFromPatches([item], [{
      target: { owner: item.owner, item_definition_index: 7 },
      values: { paint_kit: 701, stat_trak: 99 },
    }]);
    const draft = drafts[Object.keys(drafts)[0]!]!;
    expect(draft.paint_kit).toBe('701');
    expect(draft.stat_trak).toBe('');
  });
});
