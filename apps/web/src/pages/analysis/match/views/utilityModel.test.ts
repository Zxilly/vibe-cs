/*
 * `unit` project — the 道具与经济 arithmetic.
 *
 * The two assertions worth the file: 「生命周期不完整」 is a subtraction with a
 * floor rather than a mood, and a `null` spend stays `null` instead of being
 * summed with the prices that did decode.
 */

import { describe, expect, it } from 'vitest';

import {
  capabilityReason,
  ECONOMY_SIDES,
  economyPurchaseTotal,
  economyRows,
  economySide,
  UTILITY_ITEM_LABEL,
  utilityItemKind,
  utilityItems,
  utilityRows,
  utilityTotals,
} from './utilityModel';
import { rosterIndex } from './duelsModel';
import { ANALYSIS, BARE_ANALYSIS, INSIGHTS } from './test/rosterFixtures';

const INDEX = rosterIndex(ANALYSIS);

describe('the item vocabulary', () => {
  it('recognises the five grenades under every spelling the service emits', () => {
    expect(utilityItemKind('flashbang')).toBe('flash');
    expect(utilityItemKind('smokegrenade')).toBe('smoke');
    expect(utilityItemKind('hegrenade')).toBe('he');
    expect(utilityItemKind('decoy')).toBe('decoy');
    for (const fire of ['molotov', 'incgrenade', 'inferno']) {
      expect(`${fire}:${String(utilityItemKind(fire))}`).toBe(`${fire}:fire`);
    }
  });

  it('is case- and whitespace-insensitive, as `normalized_item_name` is', () => {
    expect(utilityItemKind('  FlashBang ')).toBe('flash');
  });

  it('returns null for an unfamiliar name so the caller can print it verbatim', () => {
    expect(utilityItemKind('weapon_snowball')).toBeNull();
  });

  it('tags every label with the same context, so none inherits another screen’s', () => {
    /* The macro emits `context` onto the descriptor but `MessageDescriptor`
       does not declare it, so the read is widened here rather than the table
       being typed around a `@lingui/core` omission. §10.4 deviation 3: the
       whole vocabulary is tagged, not only the word that collides today. */
    for (const [key, label] of Object.entries(UTILITY_ITEM_LABEL)) {
      const context = (label as { readonly context?: string }).context;
      expect(`${key}:${String(context)}`).toBe(`${key}:utility-item`);
    }
  });

  it('gives every member its own catalogue entry', () => {
    const ids = Object.values(UTILITY_ITEM_LABEL).map((label) => label.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the utility totals', () => {
  const totals = utilityTotals(INSIGHTS);

  it('sums the measured fields across the roster', () => {
    expect(totals.throws).toBe(41);
    expect(totals.detonations).toBe(34);
    expect(totals.damage).toBe(396);
    expect(totals.flashEvents).toBe(19);
  });

  it('reads 「生命周期不完整」 as throws that produced no activation', () => {
    expect(totals.incompleteLifecycle).toBe(7);
  });

  it('never reports a negative degradation', () => {
    const totals2 = utilityTotals({
      ...INSIGHTS,
      player_utility: [
        {
          player_id: 'kael',
          throws: 2,
          detonations: 5,
          items: [],
          damage: 0,
          damage_events: 0,
          flash_events: 0,
          players_flashed: 0,
          flash_duration_seconds: null,
        },
      ],
    });
    expect(totals2.incompleteLifecycle).toBe(0);
  });

  it('is all zeros rather than thrown when there is no insight block', () => {
    expect(utilityTotals(undefined).throws).toBe(0);
  });
});

describe('the utility rows', () => {
  const rows = utilityRows(INSIGHTS, INDEX);

  it('is busiest first', () => {
    expect(rows.map((row) => row.name)).toEqual(['Sable', 'Kael', 'Rhea', 'Corvin']);
  });

  it('names the player through the roster and keeps the raw id when it cannot', () => {
    const orphan = utilityRows(
      {
        ...INSIGHTS,
        player_utility: [
          {
            player_id: 'STEAM_1:0:404',
            throws: 1,
            detonations: 1,
            items: [],
            damage: 0,
            damage_events: 0,
            flash_events: 0,
            players_flashed: 0,
            flash_duration_seconds: null,
          },
        ],
      },
      INDEX,
    );
    expect(orphan[0]?.name).toBe('STEAM_1:0:404');
    expect(orphan[0]?.team).toBeNull();
  });

  it('keeps a null flash duration null — the wire says the duration was missing', () => {
    expect(rows.find((row) => row.name === 'Rhea')?.flashDurationSeconds).toBeNull();
    expect(rows.find((row) => row.name === 'Kael')?.flashDurationSeconds).toBe(9.4);
  });

  it('is empty when the insight block has no utility records', () => {
    expect(utilityRows(BARE_ANALYSIS.insights, INDEX)).toEqual([]);
  });
});

describe('one player’s items', () => {
  it('is most thrown first', () => {
    const kael = utilityRows(INSIGHTS, INDEX).find((row) => row.name === 'Kael');
    expect(utilityItems(kael).map((item) => item.name)).toEqual([
      'flashbang',
      'smokegrenade',
      'hegrenade',
    ]);
  });

  it('is empty rather than thrown for a player with no row', () => {
    expect(utilityItems(undefined)).toEqual([]);
  });
});

describe('the economy rows', () => {
  const rows = economyRows(INSIGHTS, ANALYSIS.rounds);

  it('is in round order even though the wire is not', () => {
    expect(rows.map((row) => row.round)).toEqual([1, 2, 3]);
  });

  it('joins the round’s winner without dropping a round that has none', () => {
    expect(rows.map((row) => row.winner)).toEqual(['A', 'B', 'A']);
    const orphan = economyRows(INSIGHTS, []);
    expect(orphan).toHaveLength(3);
    expect(orphan.every((row) => row.winner === null)).toBe(true);
  });

  it('keeps the unattributed purchases visible rather than folding them into a side', () => {
    expect(rows.find((row) => row.round === 2)?.unattributed).toBe(1);
  });

  it('addresses a side by name, and answers null for one that is not there', () => {
    const first = rows[0];
    expect(first === undefined ? null : economySide(first, 'CT')?.purchaseCount).toBe(12);
    expect(first === undefined ? null : economySide(first, 'SPEC')).toBeNull();
  });

  it('draws the two sides in the artboard’s order', () => {
    expect([...ECONOMY_SIDES]).toEqual(['CT', 'T']);
  });

  it('totals every decoded purchase, attributed or not', () => {
    expect(economyPurchaseTotal(rows)).toBe(63);
  });

  it('is empty when the insight block has no economy', () => {
    expect(economyRows(BARE_ANALYSIS.insights, ANALYSIS.rounds)).toEqual([]);
    expect(economyRows(undefined, ANALYSIS.rounds)).toEqual([]);
  });
});

describe('the capability reason', () => {
  it('is null while the capability is available', () => {
    expect(capabilityReason(INSIGHTS.availability.matchups)).toBeNull();
  });

  it('is the service’s own sentence once it is not', () => {
    expect(capabilityReason(BARE_ANALYSIS.insights?.availability.utility_events)).toBe(
      'no grenade lifecycle events were decoded',
    );
  });

  it('is null rather than an empty line when the service sent no reason', () => {
    expect(capabilityReason({ available: false, reason: '  ' })).toBeNull();
    expect(capabilityReason(undefined)).toBeNull();
  });
});
