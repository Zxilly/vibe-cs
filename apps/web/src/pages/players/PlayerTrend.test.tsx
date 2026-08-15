/*
 * `markup` project — the trend line.
 *
 * A line drawn from a picture alone is unreadable to half its audience, so the
 * assertions here are as much about the written channel — the accessible name,
 * the axis figures, the sample count — as about the `d` attribute.
 */

import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { PlayerTrend } from './PlayerTrend';
import { playerMatch, playerMatches } from './test/fixtures';

const noop = () => undefined;

describe('with matches', () => {
  const html = renderMarkup(
    <PlayerTrend matches={playerMatches(6)} metric="kd" onMetricChange={noop} />,
  );

  it('draws one polyline and one average rule', () => {
    expect(html).toContain('data-trend-path');
    expect(html).toContain('data-trend-average');
    expect(html).toContain('stroke-dasharray="5 4"');
  });

  it('says in words what the line shows', () => {
    expect(html).toMatch(/aria-label="K\/D 趋势，共 6 场/u);
    expect(html).toContain('role="img"');
  });

  it('prints the observed extremes rather than a round number', () => {
    expect(html).toContain('均值');
    expect(html).toMatch(/低 \d/u);
    expect(html).toMatch(/高 \d/u);
  });

  it('says how many of the window actually had the metric', () => {
    expect(html).toContain('最近 20 场里有 6 场有这个指标');
  });

  it('offers the artboard s three metrics', () => {
    expect(html).toContain('K/D');
    expect(html).toContain('ADR');
    expect(html).toContain('爆头率');
  });
});

describe('with no usable matches', () => {
  it('says why there is no line instead of drawing an empty box', () => {
    const html = renderMarkup(
      <PlayerTrend
        matches={[playerMatch({ kill_death_ratio: null })]}
        metric="kd"
        onMetricChange={noop}
      />,
    );
    expect(html).toContain('还没有可画的趋势');
    expect(html).not.toContain('data-trend-path');
  });

  it('names the metric that is missing, so the user can switch to another', () => {
    const html = renderMarkup(
      <PlayerTrend
        matches={[playerMatch({ kills: 0, headshots: 0 })]}
        metric="headshot"
        onMetricChange={noop}
      />,
    );
    expect(html).toContain('没有 爆头率 的取值');
  });
});

describe('the 爆头率 metric', () => {
  it('prints as a percentage, not as a ratio', () => {
    const html = renderMarkup(
      <PlayerTrend
        matches={[playerMatch({ kills: 20, headshots: 5 })]}
        metric="headshot"
        onMetricChange={noop}
      />,
    );
    expect(html).toContain('25%');
  });
});
