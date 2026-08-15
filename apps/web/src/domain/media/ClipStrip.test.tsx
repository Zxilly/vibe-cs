import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { ClipStrip } from './ClipStrip';
import type { MediaClip } from './types';

/** The artboard's own strip, 「09 快速合辑」. */
const clips: MediaClip[] = [
  { id: 'c1', title: 'Mirage 1v3 残局', durationSeconds: 42, subtitle: 'Kael · R21 · 拆包' },
  { id: 'c2', title: 'Ancient 穿墙双杀', durationSeconds: 18.4, subtitle: 'Kael · R14' },
  { id: 'c3', title: 'Nuke 匪口三杀', durationSeconds: 12.7, subtitle: 'Kael · R18' },
];

describe('ClipStrip markup', () => {
  it('is a list of buttons, so every tile can be reached from the keyboard', () => {
    const markup = renderMarkup(<ClipStrip clips={clips} />);
    expect(markup).toContain('role="list"');
    expect(markup.match(/<button/gu)).toHaveLength(3);
    expect(markup).toContain('type="button"');
  });

  it('numbers the tiles and prints their running time, as drawn', () => {
    const markup = renderMarkup(<ClipStrip clips={clips} />);
    expect(markup).toContain('>01<');
    expect(markup).toContain('>02<');
    expect(markup).toContain('42.0s');
    expect(markup).toContain('18.4s');
  });

  it('shows the title and the composed second line', () => {
    const markup = renderMarkup(<ClipStrip clips={clips} />);
    expect(markup).toContain('Mirage 1v3 残局');
    expect(markup).toContain('Kael · R21 · 拆包');
  });

  it('names each tile by its position, not by its badge', () => {
    const markup = renderMarkup(<ClipStrip clips={clips} />);
    expect(markup).toContain('aria-label="第 1 段：Mirage 1v3 残局，42.0 秒"');
  });

  it('sums the strip into the list name', () => {
    // 42 + 18.4 + 12.7 = 73.1s → 01:13.
    const markup = renderMarkup(<ClipStrip clips={clips} />);
    expect(markup).toContain('aria-label="片段顺序，共 3 段，合计 01:13"');
  });

  it('states the reorder shortcut once, not once per tile', () => {
    const markup = renderMarkup(<ClipStrip clips={clips} />);
    expect(markup.match(/按住 Ctrl 与左右方向键/gu)).toHaveLength(1);
    expect(markup).toContain('aria-describedby');
  });

  it('states selection in aria-pressed as well as in colour', () => {
    const markup = renderMarkup(<ClipStrip clips={clips} selectedId="c2" />);
    expect(markup).toContain('data-clip="c2"');
    expect(markup.match(/aria-pressed="true"/gu)).toHaveLength(1);
    expect(markup.match(/aria-pressed="false"/gu)).toHaveLength(2);
  });

  it('draws the hatched placeholder when a clip has no poster yet', () => {
    const markup = renderMarkup(<ClipStrip clips={clips} />);
    expect(markup).not.toContain('<img');
    expect(markup).toContain('repeating-linear-gradient');
  });

  it('uses the poster when there is one', () => {
    const markup = renderMarkup(
      <ClipStrip clips={[{ ...(clips[0] as MediaClip), posterSrc: 'asset://poster.png' }]} />,
    );
    expect(markup).toContain('src="asset://poster.png"');
    expect(markup).toContain('loading="lazy"');
  });

  it('says in words that a missing asset needs relocating', () => {
    const markup = renderMarkup(
      <ClipStrip clips={[{ ...(clips[0] as MediaClip), status: 'missing' }]} />,
    );
    expect(markup).toContain('需要重新定位');
    expect(markup).toContain('border-fail-border');
  });

  it('renders an empty state instead of an empty row', () => {
    const markup = renderMarkup(<ClipStrip clips={[]} />);
    expect(markup).toContain('还没有片段');
    expect(markup).not.toContain('role="list"');
  });

  it('renders a skeleton while the strip is loading', () => {
    const markup = renderMarkup(<ClipStrip clips={[]} loading />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('animate-pulse');
    expect(markup).not.toContain('还没有片段');
  });

  it('draws the dashed add cell only when there is somewhere to add from', () => {
    expect(renderMarkup(<ClipStrip clips={clips} />)).not.toContain('添加片段');
    expect(renderMarkup(<ClipStrip clips={clips} onAdd={() => {}} />)).toContain('添加片段');
  });

  it('renders statically with no backend and no layout', () => {
    // Nothing is measured at render time; `dropIndex` is only consulted mid-drag.
    const markup = renderMarkup(<ClipStrip clips={clips} />);
    expect(markup).toContain('data-dragging="false"');
    expect(renderMarkup(<ClipStrip clips={clips} />)).toBe(markup);
  });
});
