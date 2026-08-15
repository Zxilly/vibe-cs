import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Dialog } from './Dialog';

const noop = () => {};

/** The confirm button's opening tag, so assertions do not depend on attribute order. */
function confirmTag(markup: string): string {
  return /<button[^>]*data-dialog-action="confirm"[^>]*>/u.exec(markup)?.[0] ?? '';
}

function stopRecording(props: { tone?: 'default' | 'destructive' } = {}) {
  return (
    <Dialog
      open
      title={<Trans>停止这次录制？</Trans>}
      confirmLabel={<Trans>停止</Trans>}
      cancelLabel={<Trans>继续录制</Trans>}
      onConfirm={noop}
      onClose={noop}
      {...props}
    >
      <Trans>已完成的 2 个片段会保留在输出里，未开始的 2 个不会录。CS2 会被关闭。</Trans>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('renders nothing while closed', () => {
    const markup = renderMarkup(
      <Dialog open={false} title="删除 3 条记录？" confirmLabel="删除" onConfirm={noop} onClose={noop} />,
    );

    expect(markup).toBe('');
  });

  it('is a modal dialog labelled by its own title', () => {
    const markup = renderMarkup(stopRecording());

    expect(markup).toContain('role="dialog"');
    // Dialog blocks; Drawer does not. This is the difference.
    expect(markup).toContain('aria-modal="true"');

    const labelledBy = /aria-labelledby="(?<id>[^"]+)"/u.exec(markup)?.groups?.['id'];
    expect(labelledBy).toBeDefined();
    expect(markup).toContain(`<h2 id="${labelledBy ?? ''}"`);
    expect(markup).toContain('停止这次录制？');
  });

  it('spells out what the action will do', () => {
    expect(renderMarkup(stopRecording())).toContain(
      '已完成的 2 个片段会保留在输出里，未开始的 2 个不会录。CS2 会被关闭。',
    );
  });

  it('puts cancel before confirm in a row pinned bottom-right', () => {
    const markup = renderMarkup(stopRecording());

    expect(markup).toContain('justify-end');
    expect(markup.indexOf('继续录制')).toBeLessThan(markup.indexOf('停止<'));
  });

  it('defaults the cancel label to 取消', () => {
    const markup = renderMarkup(
      <Dialog open title="保存为视图" confirmLabel="保存" onConfirm={noop} onClose={noop} />,
    );

    expect(markup).toContain('取消');
  });

  it('paints an ordinary confirmation in steel blue', () => {
    const markup = renderMarkup(stopRecording());

    expect(markup).toContain('data-tone="default"');
    expect(confirmTag(markup)).toContain('bg-accent');
    expect(markup).not.toContain('bg-fail');
  });

  it('paints a destructive confirmation in brick red, border and title included', () => {
    const markup = renderMarkup(
      <Dialog
        open
        tone="destructive"
        title={<Trans>删除 3 条记录？</Trans>}
        confirmLabel={<Trans>删除</Trans>}
        onConfirm={noop}
        onClose={noop}
      >
        <Trans>其中 2 条是受管文件，会进入可回滚暂存，24 小时后清除；1 条是外部文件，只移除记录。</Trans>
      </Dialog>,
    );

    expect(markup).toContain('data-tone="destructive"');
    expect(markup).toContain('border-fail-border');
    expect(markup).toContain('text-fail-text');
    expect(confirmTag(markup)).toContain('bg-fail');
  });

  it('can disable the confirm button without hiding it', () => {
    const markup = renderMarkup(
      <Dialog open title="应用" confirmLabel="应用" confirmDisabled onConfirm={noop} onClose={noop} />,
    );

    expect(confirmTag(markup)).toContain('disabled');
  });

  it('sits above the page on a scrim', () => {
    const markup = renderMarkup(stopRecording());

    expect(markup).toContain('data-overlay="dialog-backdrop"');
    expect(markup).toContain('bg-neutral-900/50');
  });
});
