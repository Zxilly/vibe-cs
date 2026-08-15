import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Inspector } from './Inspector';

const BODY = (
  <p>
    <Trans>Aurora 在 A 点丢失包点后，Kael 在 44 秒内完成三杀并拆包。</Trans>
  </p>
);

const FOOTER = (
  <button type="button">
    <Trans>把这个回合加入视频</Trans>
  </button>
);

describe('Inspector docked', () => {
  it('draws the 380px complementary panel of 03 比赛工作区', () => {
    const html = renderMarkup(
      <Inspector title={<Trans>选中：第 21 回合</Trans>} label="选中：第 21 回合" footer={FOOTER} collapsed={false}>
        {BODY}
      </Inspector>,
    );

    expect(html).toContain('data-inspector="docked"');
    expect(html).toContain('<aside aria-label="选中：第 21 回合"');
    expect(html).toContain('w-[var(--w-inspector)]');
    expect(html).toContain('data-inspector-body');
    expect(html).toContain('data-inspector-footer');
    expect(html).toContain('把这个回合加入视频');
  });

  it('sizes the panel head from the §3.2 scale, not from base.css', () => {
    const html = renderMarkup(
      <Inspector title={<Trans>比赛详情</Trans>} label="比赛详情" collapsed={false}>
        {BODY}
      </Inspector>,
    );

    expect(html).toContain('data-inspector-title="true"');
    expect(html).toContain('style="font-size:var(--text-base)"');
    expect(html).toContain('h-[var(--h-panel-head)]');
  });

  it('takes the wide step when asked', () => {
    const html = renderMarkup(
      <Inspector title={<Trans>方案</Trans>} label="方案" width="wide" collapsed={false}>
        {BODY}
      </Inspector>,
    );

    expect(html).toContain('w-[var(--w-inspector-wide)]');
  });

  it('shows no drawer machinery while it is docked', () => {
    const html = renderMarkup(
      <Inspector title={<Trans>方案</Trans>} label="方案" collapsed={false}>
        {BODY}
      </Inspector>,
    );

    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('data-inspector-trigger');
  });
});

describe('Inspector folded (§8 rule 2)', () => {
  it('collapses to the selection strip with a drawer trigger', () => {
    const html = renderMarkup(
      <Inspector
        title={<Trans>选中：第 21 回合</Trans>}
        label="选中：第 21 回合"
        summary={<Trans>选中 R21 · 1v3 残局</Trans>}
        openLabel={<Trans>证据详情 ›</Trans>}
        collapsed
      >
        {BODY}
      </Inspector>,
    );

    expect(html).toContain('data-inspector="summary"');
    // BAR_HEIGHT_MERGE raw 50: the strip §8 calls 44 folds into --h-bar.
    expect(html).toContain('h-[var(--h-bar)]');
    expect(html).toContain('选中 R21 · 1v3 残局');
    expect(html).toContain('data-inspector-trigger');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('证据详情 ›');
    expect(html).not.toContain('role="dialog"');
  });

  it('keeps the main action on the strip beside the trigger (§8)', () => {
    const html = renderMarkup(
      <Inspector
        title={<Trans>选中：第 21 回合</Trans>}
        label="选中：第 21 回合"
        summaryActions={
          <button type="button">
            <Trans>加入视频</Trans>
          </button>
        }
        collapsed
      >
        {BODY}
      </Inspector>,
    );

    expect(html).toContain('data-inspector-summary-actions');
    expect(html).toContain('加入视频');
  });

  it('opens as a modal drawer with a name and a close control', () => {
    const html = renderMarkup(
      <Inspector
        title={<Trans>选中：第 21 回合</Trans>}
        label="选中：第 21 回合"
        footer={FOOTER}
        collapsed
        defaultOpen
      >
        {BODY}
      </Inspector>,
    );

    expect(html).toContain('data-inspector="drawer"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="选中：第 21 回合"');
    expect(html).toContain('data-inspector-close');
    expect(html).toContain('aria-label="关闭"');
    expect(html).toContain('aria-expanded="true"');
    // Same body and footer as the docked form — folding changes where the
    // panel lives, never what it says.
    expect(html).toContain('data-inspector-body');
    expect(html).toContain('把这个回合加入视频');
  });
});
