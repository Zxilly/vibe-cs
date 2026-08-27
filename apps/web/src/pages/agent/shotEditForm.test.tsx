/*
 * `markup` project — the shot's edit card.
 *
 * Two things are asserted that no interaction test states as plainly: that the
 * card offers the seven camera kinds the *recorder* can execute rather than
 * §4.5.2's five, and that there is no approval control on it at all — §4.5.3 ②
 * is kept by the absence, and an absence is what gets added back by accident.
 */

import { describe, expect, it, vi } from 'vitest';

import { AGENT_SHOT_KINDS } from '../../domain/agent';
import { SHOT_TRACKING, SHOT_TRACKING_EDITED } from '../../domain/agent/agentFixtures.testing';

import { readShotDraft } from './planEditModel';
import { ShotEditForm } from './ShotEditForm';
import { markupPanel } from './test/renderPlanPanel';

function form(overrides: Partial<Parameters<typeof ShotEditForm>[0]> = {}) {
  return markupPanel(
    <ShotEditForm
      shot={SHOT_TRACKING}
      index={2}
      draft={readShotDraft(SHOT_TRACKING)}
      onChange={vi.fn()}
      onSave={vi.fn()}
      onCancel={vi.fn()}
      {...overrides}
    />,
  );
}

describe('the fields', () => {
  it('opens on the shot’s own values', () => {
    const html = form();

    expect(html).toContain('data-shot-edit="shot-02"');
    expect(html).toContain('value="跟随突破"');
    expect(html).toContain('value="8.5"');
    expect(html).toContain('value="148812"');
  });

  it('offers every camera kind the recorder can execute, not just §4.5.2’s five', () => {
    const html = form();

    for (const kind of AGENT_SHOT_KINDS) {
      expect(html).toContain(`value="${kind}"`);
    }
    expect(html).toContain('Dolly');
    expect(html).toContain('Orbit');
  });

  it('says out loud that the tick range does not follow the duration', () => {
    expect(form()).toContain('tick 区间不会跟着动');
  });

  it('strikes the old duration through once the new one differs', () => {
    const html = form({ draft: { ...readShotDraft(SHOT_TRACKING), duration: '5' } });

    expect(html).toContain('<s class=');
    expect(html).toContain('8.5s');
  });

  it('shows no struck-through number while the value is untouched', () => {
    expect(form()).not.toContain('<s class=');
  });
});

describe('what the card does not have', () => {
  it('carries no approval, review or 待批准 control of any kind', () => {
    const html = form({
      shot: SHOT_TRACKING_EDITED,
      draft: readShotDraft(SHOT_TRACKING_EDITED),
    });

    for (const word of ['待批准', '等待批准', '待审核', '提交审核', '请求 Agent']) {
      expect(html).not.toContain(word);
    }
    // What it says instead: the edit is recorded and the Agent is told.
    expect(html).toContain('改动会记入方案版本，并通知 Agent');
    expect(html).toContain('你改过');
  });

  it('offers exactly 放弃 and 保存改动 as its own actions', () => {
    const html = form();

    expect(html).toContain('放弃');
    expect(html).toContain('保存改动');
    expect(html).toContain('Esc 放弃 · ⌘↵ 保存');
  });
});

describe('when editing is blocked', () => {
  it('disables every control and states the reason on 保存改动', () => {
    const html = form({ disabled: true, disabledReason: '编辑会记入会话，请先选择或新建一条会话' });

    expect(html).toContain('编辑会记入会话，请先选择或新建一条会话');
    // The fields are read-only rather than allowed to fail at flush time.
    expect(html.match(/disabled=""/gu)?.length ?? 0).toBeGreaterThan(3);
  });

  it('refuses to save a draft the plan cannot hold, and names the field', () => {
    const html = form({ draft: { ...readShotDraft(SHOT_TRACKING), endTick: '1' } });

    expect(html).toContain('结束 tick 应晚于或等于起始 tick');
    expect(html).toContain('还有内容填得不对');
  });
});
