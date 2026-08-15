import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { PlanStrip } from './PlanStrip';
import { TakeCard, type TakeShotPick } from './TakeCard';
import { PLAN_SHOTS, SHOT_CRANE_REMOVED } from './agentFixtures.testing';

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** Take B of the 2c board: 02 shortened, 04 deleted, 01 and 03 from Take A. */
const PICKS: readonly TakeShotPick[] = [
  { shot: PLAN_SHOTS[0]!, index: 1, picked: false },
  { shot: PLAN_SHOTS[1]!, index: 2, picked: true },
  { shot: PLAN_SHOTS[2]!, index: 3, picked: false },
  { shot: SHOT_CRANE_REMOVED, index: 4, picked: false },
];

describe('TakeCard', () => {
  it('writes the header the 2c column writes', () => {
    const html = renderMarkup(
      <TakeCard label="Take B · 压到 30 秒" summary="28.5 秒 · 3 个镜头" badge="正在预览" shots={PICKS} />,
    );

    expect(html).toContain('Take B · 压到 30 秒');
    expect(html).toContain('28.5 秒 · 3 个镜头');
    expect(html).toContain('正在预览');
  });

  it('lists every shot with its kind and length, and marks the picked ones', () => {
    const html = renderMarkup(<TakeCard label="Take A · 原始方案" shots={PICKS} />);

    expect(html).toContain('data-take-shots="4"');
    expect(html).toContain('02 跟随突破 · Tracking · 8.5s');
    expect(occurrences(html, 'checked=""')).toBe(1);
  });

  it('says 「已删除」 in words for a shot this take dropped', () => {
    const html = renderMarkup(<TakeCard label="Take B" shots={PICKS} />);

    expect(html).toContain('已删除');
  });

  it('carries the caller’s strip rather than drawing one of its own', () => {
    const html = renderMarkup(
      <TakeCard label="Take A" shots={PICKS} strip={<PlanStrip shots={PLAN_SHOTS} label="Take A 的镜头带" />} />,
    );

    expect(html).toContain('data-plan-strip');
    expect(html).toContain('aria-label="Take A 的镜头带"');
  });

  it('prints the metrics as label / value rows, whatever they are', () => {
    const html = renderMarkup(
      <TakeCard
        label="Take C · 强调路线"
        shots={PICKS}
        metrics={[
          { id: 'duration', label: '与 Take A：时长', value: '+9.0s' },
          { id: 'risk', label: '穿墙风险镜头', value: '+1', tone: 'warn' },
        ]}
      />,
    );

    expect(html).toContain('data-take-metrics="2"');
    expect(html).toContain('与 Take A：时长');
    expect(html).toContain('+9.0s');
    expect(html).toContain('text-warn-text');
  });

  it('draws no metric block when the caller has no numbers to compare', () => {
    expect(renderMarkup(<TakeCard label="Take A" shots={PICKS} />)).not.toContain('data-take-metrics');
  });

  it('says 「预览中」 on the take being previewed and 「预览」 on the others', () => {
    expect(
      renderMarkup(<TakeCard label="Take B" shots={PICKS} selected onPreview={() => undefined} />),
    ).toContain('预览中');
    expect(renderMarkup(<TakeCard label="Take A" shots={PICKS} onPreview={() => undefined} />)).toContain(
      '>预览<',
    );
  });

  it('frames the previewed take, so the badge is not the only signal', () => {
    const html = renderMarkup(<TakeCard label="Take B" shots={PICKS} selected />);

    expect(html).toContain('data-take-state="previewing"');
    expect(html).toContain('border-accent');
  });

  it('offers no buttons at all when the page passes no callbacks', () => {
    const html = renderMarkup(<TakeCard label="Take A" shots={PICKS} note="证据最完整的一版" />);

    expect(html).not.toContain('data-take-preview');
    expect(html).not.toContain('data-take-use');
    expect(html).toContain('证据最完整的一版');
  });
});
