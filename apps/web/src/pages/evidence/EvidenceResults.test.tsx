/*
 * `markup` project — the result set of 「05 证据检索」.
 *
 * The three assertions that matter are the ones §10.3 turned into rules:
 * the scroll lives in the list's own container, the footer prints the *total*
 * rather than the slice, and a failure renders in place with a way out instead
 * of throwing (§4.1's `throwOnError: false`).
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { EvidenceResults } from './EvidenceResults';
import { evidenceItem, evidenceItems } from './test/fixtures';

function render(node: Parameters<typeof renderMarkup>[0]): string {
  return renderMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

const base = {
  perspective: {},
  page: 1,
  onPageChange: () => undefined,
  activeId: '',
  onSelect: () => undefined,
  onLocate: () => undefined,
  onAddToVideo: () => undefined,
};

describe('the ready state', () => {
  const html = render(<EvidenceResults {...base} rows={evidenceItems(8)} total={47} />);

  it('renders the domain row at the density built for this page', () => {
    expect(html).toContain('data-evidence-row=');
    expect(html).toContain('data-density="comfortable"');
  });

  it('keeps its scroll inside the list — `body` has overflow:hidden', () => {
    expect(html).toMatch(/<ul[^>]*overflow-y-auto/u);
    expect(html).toMatch(/<ul[^>]*overscroll-y-contain/u);
  });

  it('prints the total, not the eight rows on screen — a silent truncation is a bug', () => {
    expect(html).toContain('命中 47 条');
  });

  it('offers 定位 and 加入作品 on every row, as the action column does', () => {
    expect(html).toContain('data-evidence-locate');
    expect(html).toContain('加入作品');
  });
});

describe('what a row says', () => {
  it('writes the qualifiers the artboard prints after the weapon', () => {
    const html = render(
      <EvidenceResults
        {...base}
        rows={[evidenceItem({ penetrated: true, headshot: true })]}
        total={1}
      />,
    );
    expect(html).toContain('穿墙');
    expect(html).toContain('爆头');
  });

  it('claims neither when the projector recorded neither', () => {
    const html = render(
      <EvidenceResults
        {...base}
        rows={[evidenceItem({ penetrated: null, headshot: null })]}
        total={1}
      />,
    );
    expect(html).not.toContain('穿墙');
  });

  it('puts the map and the date on the second line', () => {
    const html = render(<EvidenceResults {...base} rows={[evidenceItem()]} total={1} />);
    expect(html).toContain('de_mirage · 08-14');
  });

  it('marks the row the Inspector is showing', () => {
    const html = render(
      <EvidenceResults
        {...base}
        rows={[evidenceItem()]}
        total={1}
        activeId="demo:aurora/event:e-1"
      />,
    );
    expect(html).toContain('aria-current="true"');
  });
});

describe('the three states', () => {
  it('loads with row-shaped placeholders and no fabricated percentage', () => {
    const html = render(<EvidenceResults {...base} rows={[]} total={0} loading />);
    expect(html).toContain('data-evidence-row-skeleton');
    // Only the stage name is announced; there is no denominator to report, so
    // there is no bar and no figure. (The `%` that does appear is a skeleton
    // bar's own width, which is layout, not a claim about progress.)
    expect(html).toContain('正在检索证据');
    expect(html).not.toMatch(/>\s*\d+\s*%/u);
    expect(html).not.toContain('role="progressbar"');
  });

  it('renders a failure in place, with a recovery action', () => {
    const html = render(
      <EvidenceResults
        {...base}
        rows={[]}
        total={0}
        error={{ message: '服务未启动', onRetry: () => undefined }}
      />,
    );
    expect(html).toContain('检索没能完成：服务未启动');
    expect(html).toContain('data-notice-action="primary"');
    // Not a toast: 「Notice 常驻在页面里直到问题解决」.
    expect(html).toContain('role="alert"');
  });

  it('hands the empty slot to the caller, because only the page knows why', () => {
    const html = render(
      <EvidenceResults {...base} rows={[]} total={0} empty={<p>没有命中的证据</p>} />,
    );
    expect(html).toContain('data-evidence-results="empty"');
    expect(html).toContain('没有命中的证据');
  });
});

describe('an unavailable write', () => {
  it('disables 加入作品 and says why, rather than hiding it', () => {
    const html = render(
      <EvidenceResults
        {...base}
        rows={[evidenceItem()]}
        total={1}
        addDisabledReason="录制队列尚未接通"
      />,
    );
    expect(html).toContain('加入作品');
    expect(html).toContain('disabled=""');
    expect(html).toContain('录制队列尚未接通');
  });
});
