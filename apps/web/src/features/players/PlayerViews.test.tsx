import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { EvidenceSearchResponse, PlayerMapPage, PlayerMatchPage, PlayerProfile } from '../../shared/desktop/dto';
import { evidenceParticipants, PlayerCrossMatchEvidence, PlayerDetailView } from './PlayerViews';

const profile: PlayerProfile = {
  player: {
    steam_id: '76561198000000001',
    name: 'Local Player',
    aliases: ['Old Name'],
    aliases_total: 1,
    last_team: 'CT',
    last_match_date: null,
    last_cataloged_at: '2026-08-10T08:00:00Z',
    stats: {
      matches: 2,
      kills: 30,
      deaths: 20,
      assists: 8,
      headshots: 15,
      damage: 3_200,
      average_adr: 82.25,
      average_kill_death_ratio: 1.1,
    },
    steam: {
      state: 'available',
      persona_name: 'Public Player',
      real_name: null,
      profile_url: 'https://steamcommunity.com/profiles/76561198000000001/',
      country_code: 'CN',
      persona_state: 1,
      last_logoff: null,
      created_at: null,
      avatar_url: '/api/players/76561198000000001/avatar',
      reason: null,
    },
  },
  coverage: { projected_demos: 2, total_analyses: 2, projection_complete: true },
};

const matches: PlayerMatchPage = {
  steam_id: '76561198000000001',
  items: [{
    demo_id: '23d5a6ee-23a4-43b7-8654-b48e1989e231',
    demo_name: 'Local match',
    map_name: 'de_inferno',
    match_date: null,
    cataloged_at: '2026-08-10T08:00:00Z',
    team: 'CT',
    kills: 20,
    deaths: 10,
    assists: 4,
    headshots: 10,
    damage: 2_000,
    adr: 90,
    kill_death_ratio: 2,
  }],
  total: 2,
  page: 1,
  page_size: 20,
  coverage: { projected_demos: 2, total_analyses: 2, projection_complete: true },
};

const maps: PlayerMapPage = {
  steam_id: '76561198000000001',
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
  coverage: { projected_demos: 2, total_analyses: 2, projection_complete: true },
};

function render(value: PlayerProfile): string {
  return renderToStaticMarkup(
    <MemoryRouter><PlayerDetailView profile={value} matches={matches} /></MemoryRouter>,
  );
}

describe('player detail evidence', () => {
  it('labels bounded aliases with the complete persisted count', () => {
    const markup = render(profile);

    expect(markup).toContain('最近曾用名 1 / 1：Old Name');
  });

  it('renders canonical cross-match evidence with exact Round and Replay links', () => {
    const evidence: EvidenceSearchResponse = {
      items: [{
        evidence_id: 'demo:demo-1/event:kill-7',
        demo_id: 'demo-1',
        demo_display_name: 'Major Mirage',
        map_name: 'de_mirage',
        match_date: '2026-08-10T08:00:00Z',
        round: 7,
        tick: 42_000,
        end_tick: 42_000,
        event_type: 'kill',
        actor_id: '76561198000000001',
        actor_name: 'Local Player',
        target_id: '76561198000000002',
        target_name: 'Opponent',
        weapon: 'ak47',
        headshot: true,
        penetrated: false,
        source_kind: 'event',
        source_id: 'kill-7',
        attributes: {},
        analysis_href: '/analysis?demo=demo-1&tab=rounds&round=7&tick=42000&evidence=demo%3Ademo-1%2Fevent%3Akill-7',
        replay_href: '/analysis?demo=demo-1&tab=replay&round=7&tick=42000&evidence=demo%3Ademo-1%2Fevent%3Akill-7',
      }],
      total: 18,
      page: 1,
      page_size: 10,
      availability: {
        indexed_items: 120,
        indexed_demos: 4,
        total_analyses: 4,
        scan_complete: false,
        match_date: { available: true, indexed_items: 120, reason: null },
        source: { available: true, indexed_items: 120, reason: null },
      },
    };

    const markup = renderToStaticMarkup(
      <MemoryRouter><PlayerCrossMatchEvidence playerId="76561198000000001" evidence={evidence} /></MemoryRouter>,
    );

    expect(markup).toContain('跨比赛原子证据');
    expect(markup).toContain('18');
    expect(markup).toContain('Major Mirage');
    expect(markup).toContain('Local Player → Opponent');
    expect(markup).toContain('tab=rounds');
    expect(markup).toContain('tab=replay');
    expect(markup).toContain('player=76561198000000001');
    expect(markup).toContain('demo:demo-1/event:kill-7');
    expect(markup).toContain('当前结果只覆盖已经扫描完成的分析');
    expect(markup).toContain('/evidence-search?player=76561198000000001&amp;page=1&amp;page_size=50');

    expect(evidenceParticipants({
      ...evidence.items[0]!,
      source_kind: 'highlight',
      target_id: null,
      target_name: null,
      attributes: { victim_ids: ['victim-a', 'victim-b'], victim_names: ['Victim A', null] },
    }, 'unknown')).toBe('Local Player → Victim A, victim-b');
    expect(evidenceParticipants({
      ...evidence.items[0]!,
      actor_name: null,
      target_name: null,
    }, 'unknown')).toBe('76561198000000001 → 76561198000000002');
  });

  it('renders exact paged matches with player-preserving analysis and evidence links', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PlayerDetailView profile={profile} matches={matches} />
      </MemoryRouter>,
    );

    expect(markup).toContain('Steam 公开资料可用');
    expect(markup).toContain('de_inferno');
    expect(markup).toContain('1.50');
    expect(markup).toMatch(
      /(?:vibe-cs-media:\/\/localhost|http:\/\/vibe-cs-media\.localhost)\/players\/76561198000000001\/avatar/,
    );
    expect(markup).not.toContain('avatars.steamstatic.com');
    expect(markup).toContain('不推断胜负');
    expect(markup).toContain('本地比赛明细');
    expect(markup).toContain('1–1 / 2');
    expect(markup).toContain('比赛日期不可用');
    expect(markup).toContain('编入本地目录');
    expect(markup).toContain('tab=players&amp;player=76561198000000001');
    expect(markup).toContain('player=76561198000000001&amp;demo_id=23d5a6ee-23a4-43b7-8654-b48e1989e231');
  });

  it('renders truthful per-map aggregates without inventing a win rate', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PlayerDetailView profile={profile} matches={matches} maps={maps} />
      </MemoryRouter>,
    );

    expect(markup).toContain('地图表现');
    expect(markup).toContain('de_mirage');
    expect(markup).toContain('2 场');
    expect(markup).toContain('27 / 24 / 10');
    expect(markup).toContain('89.0');
    expect(markup).toContain('1.22');
    expect(markup).toContain('只聚合已验证的本地比赛，不推断地图胜率');
    expect(markup).toContain('查看热图');
    expect(markup).not.toContain('<dt>胜率</dt>');
  });

  it('keeps the paged match region pending until the exact window arrives', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PlayerDetailView profile={profile} matches={null} matchesLoading />
      </MemoryRouter>,
    );

    expect(markup).toContain('正在读取该玩家的比赛');
    expect(markup).not.toContain('没有本地比赛');
  });

  it('offers a local retry when only the exact match page failed', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PlayerDetailView
          profile={profile}
          matches={null}
          matchesError="match page unavailable"
          onRetryMatches={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain('match page unavailable');
    expect(markup).toContain('重试读取比赛');
  });

  it('shows the unconfigured evidence state without requesting an avatar', () => {
    const markup = render({
      ...profile,
      player: {
        ...profile.player,
        steam: {
          ...profile.player.steam,
          state: 'not_configured',
          avatar_url: null,
          profile_url: null,
          persona_name: null,
        },
      },
    });

    expect(markup).toContain('Steam 资料未配置');
    expect(markup).not.toContain('<img');
  });

  it('presents the explicit ratio fields as K/D', () => {
    const markup = render(profile);

    expect(markup).toContain('<dt>平均 K/D</dt><dd>1.10</dd>');
    expect(markup).toContain('<dt>K/D</dt><dd>2.00</dd>');
    expect(markup).not.toMatch(/Rating/i);
  });
});
