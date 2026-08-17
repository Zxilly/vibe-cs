import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { PlanChangeCard } from './PlanChangeCard';
import { PLAN_PROPOSAL } from './agentFixtures.testing';
import { readPlanChangeSet, type PlanChange } from './types';
import { reasonOf } from '../../test/reason';

const CHANGES = readPlanChangeSet(PLAN_PROPOSAL)?.changes ?? [];
const SHORTEN = CHANGES[0] as PlanChange;

describe('PlanChangeCard accept / reject', () => {
  it('reports the whole change, so the panel need not look it up again', () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const { getByRole } = renderInteractive(
      <PlanChangeCard change={SHORTEN} index={1} onAccept={onAccept} onReject={onReject} />,
    );

    fireEvent.click(getByRole('button', { name: '接受' }));
    expect(onAccept).toHaveBeenCalledWith(SHORTEN);

    fireEvent.click(getByRole('button', { name: '拒绝' }));
    expect(onReject).toHaveBeenCalledWith(SHORTEN);
  });

  it('does not record anything by itself — accepting is the caller’s write', () => {
    // §4.5.3 ①'s first line of defence: this component has no mutation and no
    // client. It can only call back.
    const onAccept = vi.fn();
    const { getByRole } = renderInteractive(<PlanChangeCard change={SHORTEN} index={1} onAccept={onAccept} />);

    fireEvent.click(getByRole('button', { name: '接受' }));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});

describe('PlanChangeCard · a stale card cannot be accepted', () => {
  it('disables 接受 and says why, rather than failing on click', () => {
    const onAccept = vi.fn();
    const { getByRole } = renderInteractive(
      <PlanChangeCard change={{ ...SHORTEN, state: 'stale' }} index={1} onAccept={onAccept} onReject={vi.fn()} />,
    );
    const accept = getByRole('button', { name: '接受' }) as HTMLButtonElement;

    expect(accept.disabled).toBe(true);
    expect(reasonOf(accept)).toContain('基于方案的旧版本');

    fireEvent.click(accept);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('still lets the change be rejected — an expired proposal can be dismissed', () => {
    const onReject = vi.fn();
    const { getByRole } = renderInteractive(
      <PlanChangeCard change={{ ...SHORTEN, state: 'stale' }} index={1} onReject={onReject} />,
    );

    fireEvent.click(getByRole('button', { name: '拒绝' }));
    expect(onReject).toHaveBeenCalledWith({ ...SHORTEN, state: 'stale' });
  });
});

describe('PlanChangeCard · an accepted card', () => {
  it('cannot be accepted twice, and says so', () => {
    const onAccept = vi.fn();
    const { getByRole } = renderInteractive(
      <PlanChangeCard change={{ ...SHORTEN, state: 'accepted' }} index={1} onAccept={onAccept} onReject={vi.fn()} />,
    );
    const accept = getByRole('button', { name: '接受' }) as HTMLButtonElement;

    expect(accept.disabled).toBe(true);
    expect(reasonOf(accept)).toContain('已经接受过了');
    fireEvent.click(accept);
    expect(onAccept).not.toHaveBeenCalled();
  });
});

describe('PlanChangeCard · 撤销拒绝', () => {
  it('un-rejecting is accepting it now, so it is the same callback', () => {
    const onAccept = vi.fn();
    const rejected = { ...SHORTEN, state: 'rejected' as const };
    const { getByRole } = renderInteractive(
      <PlanChangeCard change={rejected} index={1} onAccept={onAccept} onReject={vi.fn()} />,
    );

    fireEvent.click(getByRole('button', { name: '撤销拒绝' }));
    expect(onAccept).toHaveBeenCalledWith(rejected);
  });
});

describe('PlanChangeCard · 预览这条', () => {
  it('is not drawn at all when the caller has nothing to preview', () => {
    const { queryByRole } = renderInteractive(<PlanChangeCard change={SHORTEN} index={1} onAccept={vi.fn()} />);

    expect(queryByRole('button', { name: '预览这条' })).toBeNull();
  });

  it('stays visible and says why when preview is unavailable', () => {
    const onPreview = vi.fn();
    const { getByRole } = renderInteractive(
      <PlanChangeCard
        change={SHORTEN}
        index={1}
        onPreview={onPreview}
        previewDisabledReason="这一版还不能渲染单条变更的预览"
      />,
    );
    const preview = getByRole('button', { name: '预览这条' }) as HTMLButtonElement;

    expect(preview.disabled).toBe(true);
    expect(reasonOf(preview)).toContain('这一版还不能渲染单条变更的预览');
    fireEvent.click(preview);
    expect(onPreview).not.toHaveBeenCalled();
  });
});

describe('PlanChangeCard · a caller-supplied reason', () => {
  it('disables 接受 for the caller’s reason when the change itself is fine', () => {
    const onAccept = vi.fn();
    const { getByRole } = renderInteractive(
      <PlanChangeCard
        change={SHORTEN}
        index={1}
        onAccept={onAccept}
        acceptDisabledReason="编辑会记入会话，请先选择或新建一条会话"
      />,
    );
    const accept = getByRole('button', { name: '接受' }) as HTMLButtonElement;

    expect(accept.disabled).toBe(true);
    expect(reasonOf(accept)).toContain('编辑会记入会话，请先选择或新建一条会话');
  });

  it('lets the staleness reason win, because it is the one that explains the card', () => {
    const { getByRole } = renderInteractive(
      <PlanChangeCard
        change={{ ...SHORTEN, state: 'stale' }}
        index={1}
        onAccept={vi.fn()}
        acceptDisabledReason="编辑会记入会话，请先选择或新建一条会话"
      />,
    );

    expect(reasonOf(getByRole('button', { name: '接受' }))).toContain('基于方案的旧版本');
  });
});
