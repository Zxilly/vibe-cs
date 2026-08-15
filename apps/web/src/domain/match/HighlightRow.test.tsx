import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { HighlightRow, HighlightRowSkeleton } from './HighlightRow';
import { HIGHLIGHT } from './matchFixtures.testing';
import { TICK_GROUP_SEPARATOR, TICK_RANGE_DASH } from './matchTime';

describe('HighlightRow', () => {
  it('draws the 「高光列表」 row of the 比赛工作区子视图 artboard', () => {
    const html = renderMarkup(<HighlightRow highlight={HIGHLIGHT} />);

    expect(html).toContain('data-highlight-row="hl-r21-clutch"');
    expect(html).toContain('data-kind="clutch"');
    expect(html).toContain('R21');
    expect(html).toContain('1v3 残局');
    expect(html).toContain('Kael');
    expect(html).toContain('三杀后拆包，剩余 1.8 秒');
  });

  it('is a tick range, which is what makes it a clip and not a point', () => {
    const html = renderMarkup(<HighlightRow highlight={HIGHLIGHT} />);

    expect(html).toContain(
      `148${TICK_GROUP_SEPARATOR}920${TICK_RANGE_DASH}150${TICK_GROUP_SEPARATOR}440`,
    );
    // And the same interval in seconds, which is what a person judges a clip by.
    expect(html).toContain('23.8');
  });

  it('takes the 42px row from --h-row rather than the artboard literal 40', () => {
    const html = renderMarkup(<HighlightRow highlight={HIGHLIGHT} />);

    expect(html).toContain('min-h-[var(--h-row)]');
    expect(html).not.toContain('min-h-[40px]');
  });

  it('falls back to the kind table when the analysis gave no phrase of its own', () => {
    const html = renderMarkup(<HighlightRow highlight={{ ...HIGHLIGHT, label: undefined }} />);

    expect(html).toContain('残局');
  });

  it('offers multi-select — the mechanism 「已选 2 条」 needs — only when asked', () => {
    const without = renderMarkup(<HighlightRow highlight={HIGHLIGHT} />);
    const with_ = renderMarkup(<HighlightRow highlight={HIGHLIGHT} selected={false} />);

    expect(without).not.toContain('data-highlight-select');
    expect(with_).toContain('data-highlight-select=""');
    expect(with_).toContain('type="checkbox"');
    expect(with_).toContain('选择这条高光');
  });

  it('reflects the checked state of a selected candidate', () => {
    const html = renderMarkup(<HighlightRow highlight={HIGHLIGHT} selected />);

    expect(html).toContain('checked=""');
  });

  it('marks the current row with aria-current, not with colour alone', () => {
    const html = renderMarkup(<HighlightRow highlight={HIGHLIGHT} current />);

    expect(html).toContain('aria-current="true"');
    expect(html).toContain('bg-accent-100');
  });

  it('drops the description, the tags and the seconds at the compact density', () => {
    const html = renderMarkup(<HighlightRow highlight={HIGHLIGHT} density="compact" />);

    expect(html).toContain('data-density="compact"');
    expect(html).toContain('min-h-[var(--h-row-compact)]');
    expect(html).not.toContain('三杀后拆包，剩余 1.8 秒');
    expect(html).not.toContain('data-highlight-tags');
  });

  it('lists the extra type filters a candidate also matches', () => {
    const html = renderMarkup(<HighlightRow highlight={HIGHLIGHT} />);

    expect(html).toContain('data-highlight-tags=""');
    expect(html).toContain('赛点');
  });

  it('takes the page-supplied 加入视频 action', () => {
    const html = renderMarkup(
      <HighlightRow highlight={HIGHLIGHT} action={<button type="button">加入视频</button>} />,
    );

    expect(html).toContain('data-highlight-action=""');
    expect(html).toContain('加入视频');
  });

  it('carries a team-level candidate, which is why the subject is not a player', () => {
    const html = renderMarkup(
      <HighlightRow
        highlight={{
          id: 'hl-r11-eco',
          kind: 'eco-comeback',
          round: 11,
          subject: 'Aurora',
          description: '手枪局赢下强起',
          startTick: 78_220,
          endTick: 80_940,
        }}
      />,
    );

    expect(html).toContain('经济翻盘');
    expect(html).toContain('Aurora');
  });

  it('renders with no backend, no store and no query', () => {
    expect(() => renderMarkup(<HighlightRow highlight={HIGHLIGHT} />)).not.toThrow();
  });
});

describe('HighlightRowSkeleton', () => {
  it('holds the row box and shows no fabricated progress', () => {
    const html = renderMarkup(<HighlightRowSkeleton />);

    expect(html).toContain('data-highlight-row-skeleton=""');
    expect(html).toContain('min-h-[var(--h-row)]');
    expect(html).toContain('animate-pulse');
  });
});
