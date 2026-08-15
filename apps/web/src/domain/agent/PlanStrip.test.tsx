import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { PlanStrip } from './PlanStrip';
import { PLAN_SHOTS, SHOT_CRANE_REMOVED, SHOT_ESTABLISH, SHOT_POV, SHOT_TRACKING } from './agentFixtures.testing';

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('PlanStrip', () => {
  it('draws one block per shot, at its share of the length', () => {
    const html = renderMarkup(<PlanStrip shots={PLAN_SHOTS} label="当前方案" />);

    expect(occurrences(html, 'data-plan-strip-segment=')).toBe(4);
    // 8.5 of 42.0 seconds.
    expect(html).toContain('width:20.238095238095237%');
  });

  it('labels the band so the two compare rows can be told apart', () => {
    const html = renderMarkup(<PlanStrip shots={PLAN_SHOTS} label="接受全部变更后" />);

    expect(html).toContain('aria-label="接受全部变更后"');
  });

  it('prints the number and the title inside every block — colour is not the reading', () => {
    const html = renderMarkup(<PlanStrip shots={PLAN_SHOTS} label="当前方案" />);

    expect(html).toContain('01');
    expect(html).toContain('建立地点');
    // …and the accessible name carries the length as well, which the block is
    // too narrow to print.
    expect(html).toContain('aria-label="03 选手 POV · 三杀主体 24.0s"');
  });

  it('marks the longest shot with its own tone and the rest with theirs', () => {
    const html = renderMarkup(<PlanStrip shots={PLAN_SHOTS} label="当前方案" />);

    expect(occurrences(html, 'data-tone="main"')).toBe(1);
    expect(occurrences(html, 'data-tone="shot"')).toBe(3);
  });

  it('says 「已删除」 in words beside the dashed outline', () => {
    const html = renderMarkup(
      <PlanStrip shots={[SHOT_ESTABLISH, SHOT_TRACKING, SHOT_POV, SHOT_CRANE_REMOVED]} label="当前方案" />,
    );

    expect(html).toContain('data-tone="removed"');
    expect(html).toContain('已删除');
    expect(html).toContain('border-dashed');
  });

  it('draws the 留白 block only when it has a length', () => {
    expect(renderMarkup(<PlanStrip shots={PLAN_SHOTS} leadSeconds={3} label="当前方案" />)).toContain('留白');
    expect(renderMarkup(<PlanStrip shots={PLAN_SHOTS} label="当前方案" />)).not.toContain('留白');
  });

  it('ends the ruler on the plan’s real length, not a round number', () => {
    const html = renderMarkup(<PlanStrip shots={PLAN_SHOTS} ruler label="当前方案" />);

    expect(html).toContain('data-plan-strip-ruler');
    expect(html).toContain('00:00');
    expect(html).toContain('00:42');
  });

  it('draws no ruler unless it is asked for', () => {
    expect(renderMarkup(<PlanStrip shots={PLAN_SHOTS} label="当前方案" />)).not.toContain('data-plan-strip-ruler');
  });

  it('puts the row caption left of the band, where the compare view wants it', () => {
    const html = renderMarkup(<PlanStrip shots={PLAN_SHOTS} caption="当前 42.0s" label="当前方案" />);

    expect(html).toContain('data-plan-strip-caption');
    expect(html).toContain('当前 42.0s');
  });

  it('is a list of spans when nothing can be selected', () => {
    const html = renderMarkup(<PlanStrip shots={PLAN_SHOTS} label="当前方案" />);

    expect(html).not.toContain('<button');
  });

  it('clips a long title rather than widening the band', () => {
    const html = renderMarkup(<PlanStrip shots={PLAN_SHOTS} label="当前方案" />);

    expect(occurrences(html, 'truncate')).toBe(4);
  });
});
