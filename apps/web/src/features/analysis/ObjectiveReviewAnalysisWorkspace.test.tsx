import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace, PlayerAnalysis } from '../../shared/desktop/viewModels';
import { ObjectiveReviewAnalysisWorkspace } from './ObjectiveReviewAnalysisWorkspace';

const a = ['a1', 'a2', 'a3', 'a4', 'a5'];
const b = ['b1', 'b2', 'b3', 'b4', 'b5'];
const player = (id: string, team: PlayerAnalysis['team']): PlayerAnalysis => ({
  id, name: id.toUpperCase(), team, kills: 0, deaths: 0, assists: 0,
  headshot_rate: 0, kill_death_ratio: 0, adr: 0,
});
const event = (
  id: string,
  tick: number,
  kind: TimelineEvent['kind'],
  overrides: Partial<TimelineEvent> = {},
): TimelineEvent => ({
  id, tick, seconds: tick / 64, kind, actor: null, target: null, weapon: null,
  headshot: false, penetrated: false, position: null, detail: {}, ...overrides,
});

function workspace(): AnalysisWorkspace {
  const roster = Object.fromEntries([...a.map((id) => [id, 'T']), ...b.map((id) => [id, 'CT'])]);
  return {
    demo_id: 'major-m1', map_name: 'de_mirage', tick_rate: 64, duration_seconds: 60,
    teams: [
      { name: 'Team A', side: 'A', score: 1, players: a },
      { name: 'Team B', side: 'B', score: 0, players: b },
    ],
    players: [...a.map((id) => player(id, 'A')), ...b.map((id) => player(id, 'B'))],
    rounds: [{
      number: 1, winner: 'A', reason: 'target_bombed', start_tick: 1_000, end_tick: 2_000,
      team_a_score: 1, team_b_score: 0,
      events: [
        event('start-r1', 1_000, 'round_start', { detail: { _round_roster: roster } }),
        event('plant-r1', 1_200, 'bomb_plant', { actor: 'a1', detail: { site: 407 } }),
        event('damage-z', 1_400, 'damage', {
          actor: 'a2', target: 'b2', detail: { dmg_health: 18 },
        }),
        event('kill-a', 1_400, 'kill', { actor: 'a1', target: 'b1', weapon: 'ak47' }),
        event('damage-a', 1_400, 'damage', {
          actor: 'b3', target: 'a3', detail: { dmg_health: 7 },
        }),
        event('explode-r1', 1_900, 'bomb_explode', { actor: null }),
        event('end-r1', 1_900, 'round_end'),
      ],
    }],
    highlights: [],
  };
}

describe('ObjectiveReviewAnalysisWorkspace component', () => {
  it('renders the plant-round summary, same-tick groups, canonical atoms, and inspector actions', () => {
    const markup = renderToStaticMarkup(
      <ObjectiveReviewAnalysisWorkspace
        workspace={workspace()}
        selectedRound={1}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-testid="objective-review-workspace"');
    expect(markup).toContain('data-verified-plants="1/1"');
    expect(markup.match(/data-testid="objective-round"/g)).toHaveLength(1);
    expect(markup.match(/data-testid="objective-tick-group"/g)).toHaveLength(3);
    expect(markup).toContain('data-tick="1400"');
    expect(markup).toContain('data-atomic-count="3"');
    expect(markup).toContain('data-tick="1900" data-atomic-count="2"');
    expect(markup.match(/data-testid="objective-atom"/g)).toHaveLength(6);
    expect(markup).toContain('2 条伤害事件 · 25 已解析生命值伤害');
    expect(markup).toContain('Team A · T');
    expect(markup).toContain('原始 site code');
    expect(markup).toContain('<strong>407</strong>');
    expect(markup).toContain('Canonical 爆炸');
    expect(markup).not.toContain(
      '当前分析未记录 canonical terminal objective event；不推断结束方式',
    );
    expect(markup).toContain('demo:major-m1/event:plant-r1');
    expect(markup).toContain('demo:major-m1/event:end-r1');
    expect(markup).toContain('aria-label="同 tick 原子组 1900; 2"');
    for (const action of ['round', 'replay', 'watch', 'add']) {
      expect(markup.match(new RegExp('data-action="' + action + '"', 'g'))).toHaveLength(1);
      expect(markup).toContain(
        `data-action="${action}" data-action-evidence-id="demo:major-m1/event:plant-r1"`,
      );
    }
    for (const forbidden of ['A site', 'B site', 'bomb position', 'retake', 'save', 'trade', 'KAST', 'rating']) {
      expect(markup.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('distinguishes an absent terminal atom from a decoded defuse or explosion', () => {
    const noTerminal = workspace();
    noTerminal.rounds[0]!.events = noTerminal.rounds[0]!.events
      .filter((candidate) => candidate.kind !== 'bomb_explode');

    const markup = renderToStaticMarkup(
      <ObjectiveReviewAnalysisWorkspace
        workspace={noTerminal}
        selectedRound={1}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain(
      '当前分析未记录 canonical terminal objective event；不推断结束方式',
    );
    expect(markup).not.toContain('<span>终局目标事件 <strong>Canonical 爆炸');
    expect(markup).not.toContain('<span>终局目标事件 <strong>Canonical 拆除');
  });

  it('does not substitute another atom when a deep-linked evidence ID is stale', () => {
    const markup = renderToStaticMarkup(
      <ObjectiveReviewAnalysisWorkspace
        workspace={workspace()}
        selectedRound={1}
        focusedEvidenceId="demo:major-m1/event:missing-objective"
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('深链接目标证据不可用');
    expect(markup).not.toContain('data-action="round"');
    expect(markup).not.toMatch(/data-testid="objective-atom"[^>]*aria-current="true"/);
  });

  it('does not silently activate a plant round when the URL selects a non-plant round', () => {
    const source = workspace();
    source.rounds.push({
      number: 2,
      winner: 'B',
      reason: 'ct_win',
      start_tick: 2_100,
      end_tick: 3_000,
      team_a_score: 1,
      team_b_score: 1,
      events: [
        event('start-r2', 2_100, 'round_start', {
          detail: { _round_roster: Object.fromEntries([
            ...a.map((id) => [id, 'CT']),
            ...b.map((id) => [id, 'T']),
          ]) },
        }),
        event('end-r2', 2_900, 'round_end'),
      ],
    });

    const markup = renderToStaticMarkup(
      <ObjectiveReviewAnalysisWorkspace
        workspace={source}
        selectedRound={2}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).not.toContain('aria-current="true"');
    expect(markup).not.toContain('data-action="round"');
    expect(markup).not.toContain('<span>终局目标事件 <strong>Canonical 爆炸');
    expect(markup).toContain('当前选中回合没有 canonical Plant');
    expect(markup).toContain('从左侧选择有 Plant 的回合');
    expect(markup).not.toContain('当前分析没有可发布的唯一 Plant 窗口');
  });
});
