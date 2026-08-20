/*
 * `markup` project — 「08」's four blocks, rendered.
 *
 * `renderToStaticMarkup` runs no effects, so the *shell* cannot mint a plan
 * lease here (that is `recordingPage.interaction.test.tsx`'s job). What it can
 * do — and what this file is for — is render each block against a plan state
 * built by hand, which is the only way to see the markup of a state the page
 * reaches through several async steps.
 *
 * The assertions are about what is *printed*: the merge count rather than the
 * artboard's phrasing of it, the English `detail` beside a Chinese label, the
 * wording of `camera_collision_unverified`. Those are the three places this page
 * could most easily say something untrue.
 */

import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { RecordingPreflightGate } from '../../data/recording';
import { renderMarkup } from '../../test/render';
import { RecordingPlanWorkspace } from '../RecordingPage';
import { PreflightBlock } from './PreflightBlock';
import { ShotListBlock } from './ShotListBlock';
import {
  AGENT_PLAN_ID,
  ITEMS,
  blockedPreflight,
  preflight,
  recordingPlan,
} from './recordingFixtures.testing';
import type {
  RecordingBlockProps,
  RecordingPlanState,
  RecordingShot,
  RecordingStartDesk,
} from './recordingContract';

/* ── props ───────────────────────────────────────────────────────────────── */

function planState(overrides: Partial<RecordingPlanState> = {}): RecordingPlanState {
  return {
    plan: recordingPlan(),
    items: ITEMS,
    loading: false,
    error: null,
    dirty: false,
    expired: false,
    remainingMs: 300_000,
    replan: () => {},
    editShot: () => {},
    editEveryShot: () => {},
    reorder: () => {},
    removeShot: () => {},
    ...overrides,
  };
}

function gate(overrides: Partial<RecordingPreflightGate> = {}): RecordingPreflightGate {
  return {
    status: 'ready',
    result: preflight(),
    error: null,
    canStart: true,
    run: () => {},
    reset: () => {},
    ...overrides,
  };
}

function startDesk(overrides: Partial<RecordingStartDesk> = {}): RecordingStartDesk {
  return {
    action: { disabled: false },
    shotCount: 4,
    starting: false,
    error: null,
    start: () => {},
    ...overrides,
  };
}

function blockProps(overrides: Partial<RecordingBlockProps> = {}): RecordingBlockProps {
  return {
    agentPlanId: AGENT_PLAN_ID,
    plan: planState(),
    selection: { shotId: 'item-2', select: () => {} },
    preflight: gate(),
    start: startDesk(),
    service: { blocked: false, buttonProps: { disabled: false }, suffix: undefined },
    collapsed: false,
    ...overrides,
  };
}

function render(node: React.ReactElement): string {
  return renderMarkup(<MemoryRouter initialEntries={['/recording/P-118']}>{node}</MemoryRouter>);
}

/* ── the shell ───────────────────────────────────────────────────────────── */

describe('the address', () => {
  function at(path: string): string {
    return renderMarkup(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/recording/:taskId?" element={<RecordingPlanWorkspace agentPlanId={AGENT_PLAN_ID} />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('names the Agent plan it came from, because that is what :taskId is', () => {
    const html = at('/recording/P-118');
    expect(html).toContain('来自方案');
    expect(html).toContain('P-118');
  });

  it('offers the way back to the plan, not to a task', () => {
    expect(at('/recording/P-118')).toContain('返回剪辑单');
  });

});

/* ── block A ─────────────────────────────────────────────────────────────── */

describe('片段列表', () => {
  it('prints the artboard’s four rows with their ordinals', () => {
    const html = render(<ShotListBlock {...blockProps()} />);
    for (const title of ['建立地点', '跟随突破', '选手 POV · 三杀', '高潮后升起']) {
      expect(html).toContain(title);
    }
    expect(html).toContain('01');
    expect(html).toContain('04');
  });

  it('prints the real merge count, not the artboard’s sentence about merging', () => {
    const html = render(<ShotListBlock {...blockProps()} />);
    expect(html).toContain('data-merged-items="2"');
    expect(html).toContain('合并了 2 个片段');
  });

  it('says so when the director merged nothing, rather than omitting the line', () => {
    const plan = recordingPlan();
    const html = render(
      <ShotListBlock
        {...blockProps({
          plan: planState({
            plan: { ...plan, director: { ...plan.director, merged_item_count: 0 } },
          }),
        })}
      />,
    );
    expect(html).toContain('data-merged-items="0"');
    expect(html).toContain('没有发生合并');
  });

  it('turns the invalidation sentence into a statement about now once edited', () => {
    const clean = render(<ShotListBlock {...blockProps()} />);
    expect(clean).toContain('修改任何片段都会让当前预览计划失效');
    expect(clean).not.toContain('data-shot-list-dirty');

    const dirty = render(<ShotListBlock {...blockProps({ plan: planState({ dirty: true }) })} />);
    expect(dirty).toContain('data-shot-list-dirty="true"');
    expect(dirty).toContain('当前预览计划已失效');
  });

  it('draws a skeleton with no invented percentage while the lease is being minted', () => {
    const html = render(<ShotListBlock {...blockProps({ plan: planState({ loading: true, items: [] }) })} />);
    expect(html).toContain('data-shot-list="loading"');
    expect(html).not.toContain('role="progressbar"');
  });

  it('offers a way out when there are no shots at all', () => {
    const html = render(<ShotListBlock {...blockProps({ plan: planState({ items: [] }) })} />);
    expect(html).toContain('打开剪辑单');
  });
});

/* ── block C ─────────────────────────────────────────────────────────────── */

describe('录制前校验', () => {
  it('renders all eight rows of the closed set', () => {
    const html = render(<PreflightBlock {...blockProps()} />);
    expect(html).toContain('data-preflight-checks="8"');
    expect(html).toContain('grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))]');
    expect(html).toContain('max-h-[55%]');
    expect(html).not.toContain('break-all');
    for (const code of [
      'game_ready',
      'capture_component_ready',
      'demo_content_matches',
      'output_directory_writable',
      'spectator_evidence_complete',
      'encoder_available',
      'tick_range_within_demo',
      'camera_collision_unverified',
    ]) {
      expect(html).toContain(`data-check="${code}"`);
    }
  });

  it('prints `detail` as it came, in English, with a Chinese label beside it', () => {
    const html = render(<PreflightBlock {...blockProps()} />);
    expect(html).toContain('218 GB free');
    expect(html).toContain('HLAE 2.176.1 verified');
    expect(html).toContain('服务返回');
  });

  it('says the collision geometry is unknown — never that a collision was found', () => {
    const html = render(<PreflightBlock {...blockProps()} />);
    expect(html).toContain('碰撞几何未知');
    expect(html).not.toContain('检测到碰撞');
  });

  it('gives a row that names shots a way back to them', () => {
    const html = render(<PreflightBlock {...blockProps()} />);
    expect(html).toContain('影响 1 个片段');
  });

  it('shows the plan’s free-text warnings, which are not checks', () => {
    const html = render(<PreflightBlock {...blockProps()} />);
    expect(html).toContain('data-plan-warnings="1"');
    expect(html).toContain('Duration estimate unavailable for 1 shot.');
  });

  it('carries the count on the one start action', () => {
    const html = render(<PreflightBlock {...blockProps()} />);
    expect(html).toContain('开始录制 4 个片段');
    expect(html).toContain('data-recording-start="true"');
  });

  it('disables the start and says which reason while a row blocks', () => {
    const html = render(
      <PreflightBlock
        {...blockProps({
          preflight: gate({ result: blockedPreflight(), canStart: false }),
          start: startDesk({
            action: { disabled: true, disabledReason: '录制前校验有阻塞项，先解决它们' },
          }),
        })}
      />,
    );
    expect(html).toContain('data-check-state="blocked"');
    expect(html).toContain('录制前校验有阻塞项');
    expect(html).toContain('2 GB free, 14 GB required');
  });

  it('says the check list has not been run rather than showing nothing', () => {
    const html = render(
      <PreflightBlock {...blockProps({ preflight: gate({ status: 'idle', result: null, canStart: false }) })} />,
    );
    expect(html).toContain('还没有对这份片段列表跑过校验');
    expect(html).toContain('运行录制前校验');
  });
});

/* ── the one start ───────────────────────────────────────────────────────── */

describe('§4.5.3 rule ①', () => {
  it('puts exactly one 开始录制 on the page', () => {
    const items: RecordingShot[] = [...ITEMS];
    const html = render(
      <>
        <ShotListBlock {...blockProps({ plan: planState({ items }) })} />
        <PreflightBlock {...blockProps({ plan: planState({ items }) })} />
      </>,
    );
    expect(html.split('data-recording-start="true"')).toHaveLength(2);
  });
});
