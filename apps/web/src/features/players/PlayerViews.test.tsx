import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { PlayerProfile } from '../../shared/desktop/dto';
import { PlayerDetailView } from './PlayerViews';

const profile: PlayerProfile = {
  player: {
    steam_id: '76561198000000001',
    name: 'Local Player',
    aliases: ['Old Name'],
    last_team: 'CT',
    last_match_at: '2026-08-10T08:00:00Z',
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
  recent_matches: [{
    demo_id: '23d5a6ee-23a4-43b7-8654-b48e1989e231',
    demo_name: 'Local match',
    map_name: 'de_inferno',
    played_at: '2026-08-10T08:00:00Z',
    team: 'CT',
    kills: 20,
    deaths: 10,
    assists: 4,
    headshots: 10,
    damage: 2_000,
    adr: 90,
    kill_death_ratio: 2,
  }],
  scanned_demos: 2,
  scan_complete: true,
};

function render(value: PlayerProfile): string {
  return renderToStaticMarkup(
    <MemoryRouter><PlayerDetailView profile={value} /></MemoryRouter>,
  );
}

describe('player detail evidence', () => {
  it('renders local statistics, recent matches, and only the local avatar route', () => {
    const markup = render(profile);

    expect(markup).toContain('Steam 公开资料可用');
    expect(markup).toContain('de_inferno');
    expect(markup).toContain('1.50');
    expect(markup).toMatch(
      /(?:vibe-cs-media:\/\/localhost|http:\/\/vibe-cs-media\.localhost)\/players\/76561198000000001\/avatar/,
    );
    expect(markup).not.toContain('avatars.steamstatic.com');
    expect(markup).toContain('不推断胜负');
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
