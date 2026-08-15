import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { PlanShotRow, PlanShotRowSkeleton } from './PlanShotRow';
import { formatTickRange } from './shotFormat';
import {
  SHOT_CRANE_REMOVED,
  SHOT_ESTABLISH,
  SHOT_POV,
  SHOT_TRACKING,
  SHOT_TRACKING_EDITED,
} from './agentFixtures.testing';

describe('PlanShotRow · the card', () => {
  it('writes the header the artboard writes: 番号 · 种类 · 标题 · 时长', () => {
    const html = renderMarkup(<PlanShotRow shot={SHOT_ESTABLISH} index={1} />);

    expect(html).toContain('01');
    expect(html).toContain('Static');
    expect(html).toContain('建立地点');
    expect(html).toContain('3.0s');
  });

  it('gives the Latin camera term its Chinese gloss as an accessible name', () => {
    const html = renderMarkup(<PlanShotRow shot={SHOT_TRACKING} index={2} />);

    expect(html).toContain('Tracking');
    expect(html).toContain('跟随');
  });

  it('states why the shot exists and what it is cut from', () => {
    const html = renderMarkup(<PlanShotRow shot={SHOT_ESTABLISH} index={1} />);

    expect(html).toContain('先交代 A 点与包点的位置关系');
    expect(html).toContain('data-shot-evidence');
    expect(html).toContain('雷达相对坐标');
    expect(html).toContain('tick');
    // The grouped reading, from `domain/match` — not a second spelling of it.
    expect(html).toContain(formatTickRange(SHOT_ESTABLISH.start_tick, SHOT_ESTABLISH.end_tick));
  });

  it('omits the 依据 line entirely when the shot cites nothing', () => {
    const html = renderMarkup(<PlanShotRow shot={{ ...SHOT_ESTABLISH, evidence_refs: [] }} index={1} />);

    expect(html).not.toContain('data-shot-evidence');
  });

  it('omits the rationale rather than drawing an empty paragraph', () => {
    const html = renderMarkup(<PlanShotRow shot={{ ...SHOT_ESTABLISH, rationale: '' }} index={1} />);

    expect(html).not.toContain('先交代 A 点');
  });

  it('draws each risk with an icon and the warn surface, never colour alone', () => {
    const html = renderMarkup(<PlanShotRow shot={SHOT_TRACKING} index={2} />);

    expect(html).toContain('data-shot-risks');
    expect(html).toContain('无完整碰撞几何');
    expect(html).toContain('bg-warn-surface');
    // The card's own frame warns too, so the risk is visible before it is read.
    expect(html).toContain('border-warn-border');
  });

  it('draws no risk block for a shot with none', () => {
    expect(renderMarkup(<PlanShotRow shot={SHOT_POV} index={3} />)).not.toContain('data-shot-risks');
  });

  it('badges an Agent shot 「Agent」 and one the user touched 「你改过」', () => {
    expect(renderMarkup(<PlanShotRow shot={SHOT_ESTABLISH} index={1} />)).toContain('data-shot-source="agent"');
    const edited = renderMarkup(<PlanShotRow shot={SHOT_TRACKING_EDITED} index={2} />);

    expect(edited).toContain('data-shot-source="user"');
    expect(edited).toContain('你改过');
    // §4.5.3 ②: a manual edit never waits for the Agent.
    expect(edited).not.toContain('待批准');
    expect(edited).not.toContain('等待确认');
  });

  it('keeps a deleted shot readable, badged 「你删除的」 and undoable', () => {
    const html = renderMarkup(
      <PlanShotRow shot={SHOT_CRANE_REMOVED} index={4} onRestore={() => undefined} />,
    );

    expect(html).toContain('data-shot-state="removed"');
    expect(html).toContain('你删除的');
    expect(html).toContain('撤销删除');
    // Dashed, so the removal is legible without the colour.
    expect(html).toContain('border-dashed');
    // …and its title is still there to be read.
    expect(html).toContain('高潮后升起');
  });

  it('offers 撤销删除 only on a shot that is actually removed', () => {
    const html = renderMarkup(<PlanShotRow shot={SHOT_ESTABLISH} index={1} onRestore={() => undefined} />);

    expect(html).not.toContain('撤销删除');
  });

  it('places the page’s own action in the footer', () => {
    const html = renderMarkup(
      <PlanShotRow shot={SHOT_ESTABLISH} index={1} action={<span>替换镜头</span>} hint="双击编辑 · 拖动可排序" />,
    );

    expect(html).toContain('替换镜头');
    expect(html).toContain('双击编辑 · 拖动可排序');
  });
});

describe('PlanShotRow · compact', () => {
  it('collapses to the two lines the 2b header row draws', () => {
    const html = renderMarkup(<PlanShotRow shot={SHOT_TRACKING} index={2} density="compact" />);

    expect(html).toContain('data-density="compact"');
    expect(html).toContain('跟随突破');
    expect(html).toContain('8.5s');
    // No tick column, no evidence line, no risk block at this density.
    expect(html).not.toContain('data-shot-evidence');
    expect(html).not.toContain('data-shot-risks');
  });
});

describe('PlanShotRowSkeleton', () => {
  it('holds the box and says nothing about how far along anything is', () => {
    const html = renderMarkup(<PlanShotRowSkeleton />);

    expect(html).toContain('aria-busy="true"');
    // Bar widths are percentages of the box; a *printed* percentage would be a
    // fabricated progress reading, and there is none.
    expect(html).not.toMatch(/>[^<]*\d+\s*%/u);
  });
});
