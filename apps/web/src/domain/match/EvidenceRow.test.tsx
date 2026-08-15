import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { EvidenceRow, EvidenceRowSkeleton } from './EvidenceRow';
import { EVIDENCE } from './matchFixtures.testing';
import { formatTickCount, formatTickTimecode, TICK_GROUP_SEPARATOR } from './matchTime';

describe('EvidenceRow', () => {
  it('draws the Inspector 「回合内证据」 row of the 03 比赛工作区 artboard', () => {
    const html = renderMarkup(<EvidenceRow evidence={EVIDENCE} />);

    expect(html).toContain('data-evidence-row="ev-148920"');
    expect(html).toContain('data-kind="kill"');
    expect(html).toContain('Kael');
    expect(html).toContain('Sable');
    expect(html).toContain('AK-47');
    expect(html).toContain('爆头');
    expect(html).toContain('A 点连接处 · 距离 12.4m');
  });

  it('takes the 52px two-line box from --h-row-evidence, not from a literal', () => {
    const html = renderMarkup(<EvidenceRow evidence={EVIDENCE} />);

    expect(html).toContain('min-h-[var(--h-row-evidence)]');
    expect(html).not.toContain('min-h-[52px]');
  });

  it('prints the tick both as the number a deep link carries and as a timecode', () => {
    const html = renderMarkup(<EvidenceRow evidence={EVIDENCE} />);

    expect(html).toContain(`148${TICK_GROUP_SEPARATOR}920`);
    expect(html).toContain(formatTickTimecode(148_920, 64));
    expect(html).toContain('data-tick="148920"');
  });

  it('honours a per-row tick rate over the match-level one', () => {
    const html = renderMarkup(
      <EvidenceRow evidence={{ ...EVIDENCE, tickRate: 128 }} tickRate={64} density="comfortable" />,
    );

    expect(html).toContain('19:23');
  });

  it('is one component at three densities, not three components', () => {
    for (const density of ['comfortable', 'default', 'inline'] as const) {
      const html = renderMarkup(<EvidenceRow evidence={EVIDENCE} density={density} />);
      expect(html).toContain(`data-density="${density}"`);
      expect(html).toContain('Kael');
    }
  });

  it('drops the second line and the annotation at the Agent citation density', () => {
    const html = renderMarkup(<EvidenceRow evidence={EVIDENCE} density="inline" />);

    expect(html).not.toContain('A 点连接处 · 距离 12.4m');
    expect(html).not.toContain('data-evidence-annotation');
    expect(html).not.toContain('border-b');
  });

  it('shows the clock rather than the raw tick at the one-line densities', () => {
    const html = renderMarkup(<EvidenceRow evidence={EVIDENCE} density="comfortable" />);

    expect(html).toContain('38:46');
    expect(html).not.toContain(`>148${TICK_GROUP_SEPARATOR}920<`);
    // The raw number is still reachable, on the title of the same span.
    expect(html).toContain(formatTickCount(148_920));
  });

  it('names the evidence kind in words as well as with a glyph', () => {
    const html = renderMarkup(<EvidenceRow evidence={EVIDENCE} />);

    expect(html).toContain('sr-only');
    expect(html).toContain('击杀');
  });

  it('carries the annotation as an outline tag until it is resolved', () => {
    const open = renderMarkup(<EvidenceRow evidence={EVIDENCE} />);
    const done = renderMarkup(
      <EvidenceRow evidence={{ ...EVIDENCE, annotation: { label: '已处理', resolved: true } }} />,
    );

    expect(open).toContain('待处理');
    expect(open).toContain('border-accent');
    expect(done).toContain('已处理');
    expect(done).toContain('bg-neutral-100');
  });

  it('makes the row selectable with a real button, not a click on the container', () => {
    const html = renderMarkup(<EvidenceRow evidence={EVIDENCE} onSelect={() => {}} />);

    expect(html).toContain('data-evidence-select=""');
    expect(html).toContain('<button');
    expect(html).toContain('aria-pressed="false"');
  });

  it('marks the current row with aria-current and the accent plate', () => {
    const html = renderMarkup(<EvidenceRow evidence={EVIDENCE} selected onSelect={() => {}} />);

    expect(html).toContain('aria-current="true"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('bg-accent-100');
  });

  it('offers 定位 — the action that makes evidence deep-linkable', () => {
    const html = renderMarkup(<EvidenceRow evidence={EVIDENCE} onLocate={() => {}} />);

    expect(html).toContain('data-evidence-locate=""');
    expect(html).toContain('定位');
  });

  it('disables 定位 with the reason written down rather than hiding it', () => {
    const html = renderMarkup(
      <EvidenceRow evidence={EVIDENCE} onLocate={() => {}} locateDisabledReason="Demo 文件缺失" />,
    );

    expect(html).toContain('data-evidence-locate=""');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Demo 文件缺失');
  });

  it('takes a page-supplied secondary action such as 加入视频', () => {
    const html = renderMarkup(
      <EvidenceRow evidence={EVIDENCE} action={<button type="button">加入视频</button>} />,
    );

    expect(html).toContain('data-evidence-action=""');
    expect(html).toContain('加入视频');
  });

  it('renders a row that has only a tick and a kind', () => {
    const html = renderMarkup(<EvidenceRow evidence={{ id: 'bare', tick: 0, kind: 'round' }} />);

    expect(html).toContain('data-evidence-row="bare"');
    expect(html).toContain('00:00:00:00');
  });

  it('renders with no backend, no store and no query', () => {
    expect(() => renderMarkup(<EvidenceRow evidence={EVIDENCE} />)).not.toThrow();
  });
});

describe('EvidenceRowSkeleton', () => {
  it('holds the row box and says nothing about progress', () => {
    const html = renderMarkup(<EvidenceRowSkeleton />);

    expect(html).toContain('data-evidence-row-skeleton=""');
    expect(html).toContain('min-h-[var(--h-row-evidence)]');
    expect(html).toContain('animate-pulse');
    expect(html).not.toMatch(/\d+\s*%<\//u);
  });
});
