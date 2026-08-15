/*
 * `unit` project — the rules of 「Review 与结论」.
 *
 * Two things are pinned here, and the second matters more than the first:
 *
 *   1. each rule computes what it claims to compute;
 *   2. each rule returns `null` — no card at all — when the capability flag the
 *      service publishes says the input was not attributable. The artboard's
 *      condition is 「两者都必须标注证据」, and a card derived from an unavailable
 *      block would be a conclusion with nothing behind it.
 */

import { describe, expect, it } from 'vitest';

import {
  INSIGHT_CAPABILITY_IDS,
  annotationTally,
  capabilityGaps,
  displayName,
  matchupInsight,
  openingKillInsight,
  resolveCitations,
  utilityInsight,
} from './reviewModel';
import { ANALYSIS, ANALYSIS_WITHOUT_INSIGHTS, ANNOTATIONS, REVIEW_RESULT } from './test/fixtures';

describe('capabilityGaps', () => {
  it('lists only the capabilities the service declined, with its own words', () => {
    const gaps = capabilityGaps(ANALYSIS);
    expect(gaps.map((gap) => gap.id)).toEqual(['purchase_events', 'purchase_spend']);
    expect(gaps[0]?.reason).toBe('这批 Demo 没有购买事件，经济曲线画不出来。');
    // A refusal with no sentence stays `null` so the view can say so, rather
    // than an empty string that renders as a blank line.
    expect(gaps[1]?.reason).toBeNull();
  });

  it('is empty while the document has not arrived — 还没读到 is not 不可用', () => {
    expect(capabilityGaps(undefined)).toEqual([]);
  });

  it('covers the six the wire declares', () => {
    expect([...INSIGHT_CAPABILITY_IDS].sort()).toEqual([
      'flash_effects',
      'matchups',
      'purchase_events',
      'purchase_spend',
      'utility_damage',
      'utility_events',
    ]);
    expect(capabilityGaps(ANALYSIS_WITHOUT_INSIGHTS)).toHaveLength(INSIGHT_CAPABILITY_IDS.length);
  });
});

describe('openingKillInsight', () => {
  it('counts the first kill of each round and names the leader', () => {
    const insight = openingKillInsight(ANALYSIS);
    expect(insight?.leaderId).toBe('kael');
    expect(insight?.leaderName).toBe('Kael');
    expect(insight?.leaderCount).toBe(1);
    // Only round 21 carries events in the fixture.
    expect(insight?.roundsWithOpening).toBe(1);
    // The evidence link goes to the actual event, not to the round's start.
    expect(insight?.round).toBe(21);
    expect(insight?.tick).toBe(149_128);
  });

  it('needs no capability flag — the event list is the analysis itself', () => {
    // `ANALYSIS_WITHOUT_INSIGHTS` has every flag off *and* no events, so this
    // is null for lack of kills, not for lack of a flag.
    expect(openingKillInsight(ANALYSIS_WITHOUT_INSIGHTS)).toBeNull();
    expect(openingKillInsight(undefined)).toBeNull();
  });
});

describe('matchupInsight', () => {
  it('reports the most one-sided pair', () => {
    const insight = matchupInsight(ANALYSIS);
    expect(insight?.playerName).toBe('Kael');
    expect(insight?.opponentName).toBe('Sable');
    expect(insight?.kills).toBe(5);
    expect(insight?.deaths).toBe(1);
    expect(insight?.pairCount).toBe(1);
  });

  it('draws nothing when the service says duels were not attributed', () => {
    expect(matchupInsight(ANALYSIS_WITHOUT_INSIGHTS)).toBeNull();
  });

  it('draws nothing when no pair is actually ahead', () => {
    const even = {
      ...ANALYSIS,
      insights: {
        ...ANALYSIS.insights!,
        matchups: [
          {
            player_id: 'kael',
            opponent_id: 'sable',
            kills: 2,
            deaths: 2,
            headshot_kills: 0,
            damage_dealt: 0,
            damage_taken: 0,
            damage_events: 0,
          },
        ],
      },
    };
    expect(matchupInsight(even)).toBeNull();
  });
});

describe('utilityInsight', () => {
  it('needs both the throws and the damage attribution', () => {
    const insight = utilityInsight(ANALYSIS);
    expect(insight?.playerName).toBe('Kael');
    expect(insight?.damage).toBe(184);
    expect(insight?.throws).toBe(12);
    expect(insight?.playersFlashed).toBe(7);
  });

  it('omits the flash clause rather than printing a zero for it', () => {
    const noFlash = {
      ...ANALYSIS,
      insights: {
        ...ANALYSIS.insights!,
        availability: {
          ...ANALYSIS.insights!.availability,
          flash_effects: { available: false, reason: null },
        },
      },
    };
    expect(utilityInsight(noFlash)?.playersFlashed).toBeNull();
  });

  it('draws nothing when either flag is off', () => {
    expect(utilityInsight(ANALYSIS_WITHOUT_INSIGHTS)).toBeNull();
    const noDamage = {
      ...ANALYSIS,
      insights: {
        ...ANALYSIS.insights!,
        availability: {
          ...ANALYSIS.insights!.availability,
          utility_damage: { available: false, reason: null },
        },
      },
    };
    expect(utilityInsight(noDamage)).toBeNull();
  });
});

describe('resolveCitations', () => {
  it('resolves an id against the highlights and the timeline, and keeps the rest', () => {
    const citations = resolveCitations(REVIEW_RESULT.evidence_ids, ANALYSIS);
    expect(citations.map((citation) => citation.kind)).toEqual(['highlight', 'event', 'unknown']);

    const [highlight, event] = citations;
    expect(highlight).toMatchObject({ label: '1v3 残局', round: 21, tick: 148_920 });
    expect(event).toMatchObject({ round: 21, tick: 149_128, actor: 'kael', target: 'sable' });
  });

  it('shows every id it was given, because the claim is that all of them are shown', () => {
    const citations = resolveCitations(['nope'], undefined);
    expect(citations).toEqual([{ kind: 'unknown', id: 'nope' }]);
  });
});

describe('annotationTally', () => {
  it('splits 待处理 from 已处理', () => {
    expect(annotationTally(ANNOTATIONS.items)).toEqual({ total: 2, open: 1, resolved: 1 });
  });

  it('is all zeroes while the read is in flight', () => {
    expect(annotationTally(undefined)).toEqual({ total: 0, open: 0, resolved: 0 });
  });
});

describe('displayName', () => {
  it('resolves an id and returns free text unchanged', () => {
    expect(displayName(ANALYSIS, 'kael')).toBe('Kael');
    // `TimelineEvent.actor` is free text; some producers already write a name.
    expect(displayName(ANALYSIS, 'Kael')).toBe('Kael');
    expect(displayName(undefined, 'kael')).toBe('kael');
  });
});
