import { describe, expect, it } from 'vitest';

import {
  parsePlayerDirectoryPage,
  parsePlayerHeatmap,
  parsePlayerMapPage,
  parsePlayerMatchPage,
  parsePlayerComparison,
  parsePlayerProfile,
} from './playerContract';

describe('player current contract', () => {
  it('accepts only exact identity-bound per-map aggregates', () => {
    const current = {
      steam_id: '76561197960690195',
      items: [{
        map_name: 'de_mirage',
        stats: {
          matches: 2,
          kills: 27,
          deaths: 24,
          assists: 10,
          headshots: 15,
          damage: 3_738,
          average_adr: 89,
          average_kill_death_ratio: 1.22,
        },
      }],
      total: 1,
      page: 1,
      page_size: 20,
      coverage: {
        projected_demos: 3,
        total_analyses: 3,
        projection_complete: true,
      },
    };

    expect(parsePlayerMapPage(current).items[0]?.map_name).toBe('de_mirage');
    expect(() => parsePlayerMapPage({
      ...current,
      items: [{ ...current.items[0], win_rate: 0.67 }],
    })).toThrow(/current contract/i);
  });

  it('accepts exact source-bound player heatmap points and rejects partial or mismatched evidence', () => {
    const demoId = '00000000-0000-0000-0000-000000000001';
    const evidenceId = `demo:${demoId}/event:kill-640`;
    const current = {
      steam_id: '76561198000000001',
      map_name: 'de_mirage',
      points: [{
        demo_id: demoId,
        evidence_id: evidenceId,
        round: 7,
        tick: 640,
        kind: 'kills',
        x: 100,
        y: 200,
        floor: 1,
        analysis_href: `/analysis?demo=${demoId}&tab=rounds&round=7&tick=640&evidence=${encodeURIComponent(evidenceId)}&player=76561198000000001`,
        replay_href: `/analysis?demo=${demoId}&tab=replay&round=7&tick=640&evidence=${encodeURIComponent(evidenceId)}&player=76561198000000001`,
      }],
      total: 1,
      maximum_points: 5000,
      complete: true,
      coverage: { projected_demos: 3, total_analyses: 3, projection_complete: true },
    };

    expect(parsePlayerHeatmap(current).points[0]?.kind).toBe('kills');
    expect(() => parsePlayerHeatmap({
      ...current,
      points: [{ ...current.points[0], demo_id: '00000000-0000-0000-0000-000000000002' }],
    })).toThrow(/current contract/i);
    expect(() => parsePlayerHeatmap({ ...current, total: 2 })).toThrow(/current contract/i);
  });

  it('keeps an unknown match date nullable instead of substituting the catalog timestamp', () => {
    const current = {
      steam_id: '76561197960690195',
      items: [{
        demo_id: '23d5a6ee-23a4-43b7-8654-b48e1989e231',
        demo_name: 'Major Mirage',
        map_name: 'de_mirage',
        match_date: null,
        cataloged_at: '2026-08-13T18:31:55Z',
        team: 'A',
        kills: 9,
        deaths: 14,
        assists: 6,
        headshots: 4,
        damage: 1_638,
        adr: 78,
        kill_death_ratio: 0.64,
      }],
      total: 1,
      page: 1,
      page_size: 20,
      coverage: {
        projected_demos: 3,
        total_analyses: 3,
        projection_complete: true,
      },
    };

    const currentItem = current.items[0];
    if (currentItem === undefined) throw new Error('missing current test item');
    expect(parsePlayerMatchPage(current).items[0]?.match_date).toBeNull();
    expect(() => parsePlayerMatchPage({
      ...current,
      items: [{
        ...currentItem,
        played_at: currentItem.cataloged_at,
      }],
    })).toThrow(/current contract/i);
  });

  it('keeps the directory last-match date nullable while exposing its catalog timestamp separately', () => {
    const current = {
      items: [{
        steam_id: '76561197960690195',
        name: 'FalleN',
        aliases: [],
        aliases_total: 0,
        last_team: 'A',
        last_match_date: null,
        last_cataloged_at: '2026-08-13T18:44:19Z',
        stats: {
          matches: 3,
          kills: 37,
          deaths: 44,
          assists: 17,
          headshots: 10,
          damage: 5_619,
          average_adr: 89.13,
          average_kill_death_ratio: 0.84,
        },
        steam: {
          state: 'not_configured',
          persona_name: null,
          real_name: null,
          profile_url: null,
          country_code: null,
          persona_state: null,
          last_logoff: null,
          created_at: null,
          avatar_url: null,
          reason: 'Steam Web API key is not configured',
        },
      }],
      total: 1,
      page: 1,
      page_size: 24,
      coverage: {
        projected_demos: 3,
        total_analyses: 3,
        projection_complete: true,
      },
    };

    const parsed = parsePlayerDirectoryPage(current);
    expect(parsed.items[0]?.last_match_date).toBeNull();
    expect(parsed.items[0]?.last_cataloged_at).toBe('2026-08-13T18:44:19Z');
  });

  it('binds an exact profile to projection coverage instead of a runtime scan count', () => {
    const item = {
      steam_id: '76561197960690195',
      name: 'FalleN',
      aliases: [],
      aliases_total: 0,
      last_team: 'A',
      last_match_date: null,
      last_cataloged_at: '2026-08-13T18:44:19Z',
      stats: {
        matches: 3,
        kills: 37,
        deaths: 44,
        assists: 17,
        headshots: 10,
        damage: 5_619,
        average_adr: 89.13,
        average_kill_death_ratio: 0.84,
      },
      steam: {
        state: 'not_configured',
        persona_name: null,
        real_name: null,
        profile_url: null,
        country_code: null,
        persona_state: null,
        last_logoff: null,
        created_at: null,
        avatar_url: null,
        reason: 'Steam Web API key is not configured',
      },
    };
    const current = {
      player: item,
      coverage: {
        projected_demos: 3,
        total_analyses: 3,
        projection_complete: true,
      },
    };

    expect(parsePlayerProfile(current).player.steam_id).toBe(item.steam_id);
    expect(() => parsePlayerProfile({ ...current, scanned_demos: 3 })).toThrow(/current contract/i);
    expect(() => parsePlayerProfile({
      ...current,
      player: { ...item, steam_id: '00000000000000000' },
    })).toThrow(/current contract/i);
  });

  it('preserves the explicit comparison order from one projection response', () => {
    const player = (steamId: string, name: string) => ({
      steam_id: steamId,
      name,
      aliases: [],
      aliases_total: 0,
      last_team: null,
      last_match_date: null,
      last_cataloged_at: '2026-08-13T18:44:19Z',
      stats: {
        matches: 3,
        kills: 1,
        deaths: 1,
        assists: 0,
        headshots: 0,
        damage: 100,
        average_adr: 33.3,
        average_kill_death_ratio: 1,
      },
      steam: {
        state: 'not_configured',
        persona_name: null,
        real_name: null,
        profile_url: null,
        country_code: null,
        persona_state: null,
        last_logoff: null,
        created_at: null,
        avatar_url: null,
        reason: 'Steam Web API key is not configured',
      },
    });
    const parsed = parsePlayerComparison({
      players: [
        player('76561198041683378', 'NiKo'),
        player('76561197960690195', 'FalleN'),
      ],
      coverage: {
        projected_demos: 3,
        total_analyses: 3,
        projection_complete: true,
      },
    });

    expect(parsed.players.map((item) => item.steam_id)).toEqual([
      '76561198041683378',
      '76561197960690195',
    ]);
  });

  it('rejects Steam enrichment fields that contradict their declared state', () => {
    const player = {
      steam_id: '76561197960690195',
      name: 'FalleN',
      aliases: [],
      aliases_total: 0,
      last_team: 'A',
      last_match_date: null,
      last_cataloged_at: '2026-08-13T18:44:19Z',
      stats: {
        matches: 3,
        kills: 37,
        deaths: 44,
        assists: 17,
        headshots: 10,
        damage: 5_619,
        average_adr: 89.13,
        average_kill_death_ratio: 0.84,
      },
      steam: {
        state: 'available',
        persona_name: 'FalleN',
        real_name: null,
        profile_url: null,
        country_code: null,
        persona_state: 1,
        last_logoff: null,
        created_at: null,
        avatar_url: null,
        reason: null,
      },
    };
    const response = {
      player,
      coverage: { projected_demos: 3, total_analyses: 3, projection_complete: true },
    };

    expect(parsePlayerProfile(response).player.steam.persona_name).toBe('FalleN');
    expect(() => parsePlayerProfile({
      ...response,
      player: {
        ...player,
        steam: { ...player.steam, persona_name: null },
      },
    })).toThrow(/current contract/i);
    expect(() => parsePlayerProfile({
      ...response,
      player: {
        ...player,
        steam: { ...player.steam, reason: 'stale failure' },
      },
    })).toThrow(/current contract/i);
    expect(() => parsePlayerProfile({
      ...response,
      player: {
        ...player,
        steam: {
          ...player.steam,
          state: 'not_configured',
          persona_name: 'stale persona',
          reason: 'Steam Web API key is not configured',
        },
      },
    })).toThrow(/current contract/i);
    expect(() => parsePlayerProfile({
      ...response,
      player: {
        ...player,
        steam: { ...player.steam, persona_state: 256 },
      },
    })).toThrow(/current contract/i);
  });

  it('rejects date-only strings that are not serialized DateTime values', () => {
    const page = {
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
      coverage: { projected_demos: 0, total_analyses: 0, projection_complete: true },
    };
    const item = {
      steam_id: '76561197960690195',
      name: 'FalleN',
      aliases: [],
      aliases_total: 0,
      last_team: null,
      last_match_date: null,
      last_cataloged_at: '2026-08-13',
      stats: {
        matches: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        headshots: 0,
        damage: 0,
        average_adr: null,
        average_kill_death_ratio: null,
      },
      steam: {
        state: 'not_configured',
        persona_name: null,
        real_name: null,
        profile_url: null,
        country_code: null,
        persona_state: null,
        last_logoff: null,
        created_at: null,
        avatar_url: null,
        reason: 'Steam Web API key is not configured',
      },
    };

    expect(() => parsePlayerDirectoryPage({ ...page, items: [item], total: 1 })).toThrow(
      /current contract/i,
    );
  });

  it('rejects calendar-invalid DateTime values instead of accepting JavaScript normalization', () => {
    const item = {
      steam_id: '76561197960690195',
      name: 'FalleN',
      aliases: [],
      aliases_total: 0,
      last_team: null,
      last_match_date: null,
      last_cataloged_at: '2026-02-30T18:44:19Z',
      stats: {
        matches: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        headshots: 0,
        damage: 0,
        average_adr: null,
        average_kill_death_ratio: null,
      },
      steam: {
        state: 'not_configured',
        persona_name: null,
        real_name: null,
        profile_url: null,
        country_code: null,
        persona_state: null,
        last_logoff: null,
        created_at: null,
        avatar_url: null,
        reason: 'Steam Web API key is not configured',
      },
    };

    expect(() => parsePlayerDirectoryPage({
      items: [item],
      total: 1,
      page: 1,
      page_size: 20,
      coverage: { projected_demos: 1, total_analyses: 1, projection_complete: true },
    })).toThrow(/current contract/i);
  });

  it('rejects negative projected ADR or kill-death metrics instead of treating them as truth', () => {
    const page = {
      steam_id: '76561197960690195',
      items: [{
        demo_id: '23d5a6ee-23a4-43b7-8654-b48e1989e231',
        demo_name: 'Major Mirage',
        map_name: 'de_mirage',
        match_date: null,
        cataloged_at: '2026-08-13T18:31:55Z',
        team: 'A',
        kills: 9,
        deaths: 14,
        assists: 6,
        headshots: 4,
        damage: 1_638,
        adr: -1,
        kill_death_ratio: 0.64,
      }],
      total: 1,
      page: 1,
      page_size: 20,
      coverage: { projected_demos: 1, total_analyses: 1, projection_complete: true },
    };

    expect(() => parsePlayerMatchPage(page)).toThrow(/current contract/i);
    expect(() => parsePlayerMatchPage({
      ...page,
      items: [{ ...page.items[0], adr: 78, kill_death_ratio: -0.1 }],
    })).toThrow(/current contract/i);
  });

  it('rejects page numbers beyond the current server bound', () => {
    const page = {
      items: [],
      total: 0,
      page: 10_001,
      page_size: 20,
      coverage: { projected_demos: 0, total_analyses: 0, projection_complete: true },
    };

    expect(() => parsePlayerDirectoryPage(page)).toThrow(/current contract/i);
    expect(() => parsePlayerMatchPage({
      steam_id: '76561197960690195',
      ...page,
    })).toThrow(/current contract/i);
  });

  it('keeps aliases explicitly bounded while preserving the complete alias count', () => {
    const aliases = Array.from({ length: 32 }, (_, index) => `Alias ${index + 1}`);
    const item = {
      steam_id: '76561197960690195',
      name: 'FalleN',
      aliases,
      aliases_total: 40,
      last_team: null,
      last_match_date: null,
      last_cataloged_at: '2026-08-13T18:44:19Z',
      stats: {
        matches: 41,
        kills: 0,
        deaths: 0,
        assists: 0,
        headshots: 0,
        damage: 0,
        average_adr: null,
        average_kill_death_ratio: null,
      },
      steam: {
        state: 'not_configured',
        persona_name: null,
        real_name: null,
        profile_url: null,
        country_code: null,
        persona_state: null,
        last_logoff: null,
        created_at: null,
        avatar_url: null,
        reason: 'Steam Web API key is not configured',
      },
    };
    const page = {
      items: [item],
      total: 1,
      page: 1,
      page_size: 20,
      coverage: { projected_demos: 41, total_analyses: 41, projection_complete: true },
    };

    expect(parsePlayerDirectoryPage(page).items[0]?.aliases_total).toBe(40);
    expect(() => parsePlayerDirectoryPage({
      ...page,
      items: [{ ...item, aliases: [...aliases, 'Alias 33'] }],
    })).toThrow(/current contract/i);
    expect(() => parsePlayerDirectoryPage({
      ...page,
      items: [{ ...item, aliases_total: 31 }],
    })).toThrow(/current contract/i);
    expect(() => parsePlayerDirectoryPage({
      ...page,
      items: [{ ...item, aliases: [item.name], aliases_total: 1 }],
    })).toThrow(/current contract/i);
    expect(() => parsePlayerDirectoryPage({
      ...page,
      items: [{ ...item, aliases: [], aliases_total: 1 }],
    })).toThrow(/current contract/i);
  });
});
