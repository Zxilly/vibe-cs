import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { PlanChangeCard } from './PlanChangeCard';
import { readPlanChangeSet } from './types';
import { PLAN_PROPOSAL } from './agentFixtures.testing';
import { STALE_OPACITY_CLASS } from './planRevision';
import type { PlanChange } from './types';

const CHANGES = readPlanChangeSet(PLAN_PROPOSAL)?.changes ?? [];
const SHORTEN = CHANGES[0] as PlanChange;
const DELETE = CHANGES[1] as PlanChange;

const noop = () => undefined;

describe('PlanChangeCard', () => {
  it('writes the header the 2a card writes: 变更 N · op · delta', () => {
    const html = renderMarkup(<PlanChangeCard change={SHORTEN} index={1} targetLabel="02 跟随突破" />);

    expect(html).toContain('变更 1');
    expect(html).toContain('缩短');
    expect(html).toContain('−5.5s');
    expect(html).toContain('02 跟随突破');
    expect(html).toContain('8.5s');
    expect(html).toContain('3.0s');
  });

  it('resolves the target’s name from the caller and never from the id', () => {
    const html = renderMarkup(<PlanChangeCard change={SHORTEN} index={1} />);

    // Without a `targetLabel` the card prints the before/after and no name —
    // it does not print 「shot-02」 at the reader.
    expect(html).not.toContain('shot-02');
    expect(html).toContain('data-plan-change="change-1"');
  });

  it('draws the warning with an icon on the warn surface, not colour alone', () => {
    const html = renderMarkup(<PlanChangeCard change={DELETE} index={2} />);

    expect(html).toContain('data-change-warning');
    expect(html).toContain('结尾会变硬');
    expect(html).toContain('bg-warn-surface');
  });

  it('omits every line the payload did not carry', () => {
    const bare: PlanChange = {
      id: 'c',
      op: 'insert',
      targetShotId: 'shot-01',
      before: null,
      after: null,
      deltaSeconds: null,
      rationale: null,
      warning: null,
      state: 'pending',
    };
    const html = renderMarkup(<PlanChangeCard change={bare} index={1} />);

    expect(html).not.toContain('data-change-title');
    expect(html).not.toContain('data-change-warning');
    expect(html).not.toContain('±0s');
  });

  it('carries its state as data for the panel around it', () => {
    for (const state of ['pending', 'accepted', 'rejected', 'stale'] as const) {
      const html = renderMarkup(<PlanChangeCard change={{ ...SHORTEN, state }} index={1} />);
      expect(html).toContain(`data-change-state="${state}"`);
    }
  });
});

describe('PlanChangeCard · §4.5.3 rule ③, a stale card', () => {
  const stale = renderMarkup(
    <PlanChangeCard
      change={{ ...SHORTEN, state: 'stale' }}
      index={1}
      targetLabel="02 跟随突破"
      onAccept={noop}
      onReject={noop}
    />,
  );

  it('dims to the 55% the spec names, from the one place that number lives', () => {
    expect(stale).toContain(STALE_OPACITY_CLASS);
  });

  it('says 「已过期」 in words as well — the opacity is never the only signal', () => {
    expect(stale).toContain('data-change-status');
    expect(stale).toContain('已过期');
  });

  it('keeps the whole body readable — 过期不等于错误', () => {
    expect(stale).toContain('02 跟随突破');
    expect(stale).toContain('8.5s');
    expect(stale).toContain('只保留从中路进入 A 大道的一段');
  });

  it('disables 接受 with a written reason, and leaves 拒绝 alive', () => {
    expect(stale).toContain('这条变更基于方案旧版本');
    expect(stale).toContain('拒绝');
  });

  it('does not dim a card that is merely accepted or rejected', () => {
    for (const state of ['accepted', 'rejected'] as const) {
      const html = renderMarkup(<PlanChangeCard change={{ ...SHORTEN, state }} index={1} />);
      expect(html).not.toContain(STALE_OPACITY_CLASS);
    }
  });
});

describe('PlanChangeCard · a rejected card', () => {
  it('offers 撤销拒绝 in place of the accept / reject pair', () => {
    const html = renderMarkup(
      <PlanChangeCard change={{ ...SHORTEN, state: 'rejected' }} index={1} onAccept={noop} onReject={noop} />,
    );

    expect(html).toContain('撤销拒绝');
    expect(html).toContain('已拒绝');
    expect(html).not.toContain('>接受<');
  });
});
