/*
 * Domain layer, 2 of 3 — agent/, the shared test fixtures.
 *
 * 方案 #P-118 「Kael · Mirage 1v3 残局」, verbatim from the artboards: four
 * shots, 42.0 seconds, 03 the 24-second POV body, 02 carrying the 穿墙 risk, 04
 * the one the user deleted. Using the reference's own numbers means a failing
 * test says 「the artboard says otherwise」 rather than 「the number I made up
 * moved」 — the rule `match/matchFixtures.testing.ts` set.
 *
 * Not imported by any component. Nothing here goes through a Lingui macro:
 * `lingui.config.ts` excludes `*.test.*` and `**\/test\/**` from extraction but
 * not this path, so a macro here would push fixture copy into the shipped
 * catalogue. Every string is a plain literal, and a plain literal renders as
 * itself in any `ReactNode` slot.
 */

import type {
  AgentObjectRef,
  AgentPlanShot,
  AgentSessionEntry,
  AgentSessionProposal,
  AgentSessionSummary,
  WorkspaceEditNotice,
} from '../../shared/desktop/dto';
import type { KnownWorkspaceReference } from './types';

/* ── the plan ────────────────────────────────────────────────────────────── */

function shot(overrides: Partial<AgentPlanShot> & Pick<AgentPlanShot, 'id' | 'title'>): AgentPlanShot {
  return {
    kind: 'static',
    view: 'observer',
    start_tick: 148_620,
    end_tick: 148_812,
    duration_seconds: 3,
    rationale: '',
    evidence_refs: [],
    risks: [],
    source: 'agent',
    removed_by: null,
    params: null,
    ...overrides,
  };
}

/** 「01 建立地点 · Static · 3.0s」. */
export const SHOT_ESTABLISH: AgentPlanShot = shot({
  id: 'shot-01',
  title: '建立地点',
  kind: 'static',
  rationale: '先交代 A 点与包点的位置关系，让后面的绕后有参照。',
  evidence_refs: ['雷达相对坐标'],
});

/** 「02 跟随突破 · Tracking · 8.5s」, the one with the 穿墙 risk. */
export const SHOT_TRACKING: AgentPlanShot = shot({
  id: 'shot-02',
  title: '跟随突破',
  kind: 'tracking',
  start_tick: 148_812,
  end_tick: 149_356,
  duration_seconds: 8.5,
  rationale: '沿 Kael 的真实移动轴从中路跟到 A 大道，交代他绕过防守的路径。',
  evidence_refs: ['位置样本移动轴'],
  risks: ['无完整碰撞几何，运动镜头可能穿墙；可改为 POV 规避'],
});

/** 「03 选手 POV · 三杀主体 · 24.0s」, the longest — the strip's 主体段. */
export const SHOT_POV: AgentPlanShot = shot({
  id: 'shot-03',
  title: '选手 POV · 三杀主体',
  kind: 'pov',
  view: 'player_pov',
  start_tick: 148_920,
  end_tick: 150_440,
  duration_seconds: 24,
  rationale: '主体段用第一人称，三次击杀连续发生，切换视角会打断读秒的紧张感。',
  evidence_refs: ['击杀事件 tick 区间'],
});

/** 「04 高潮后升起 · Crane · 6.5s」, and the one 手动编辑 deletes. */
export const SHOT_CRANE: AgentPlanShot = shot({
  id: 'shot-04',
  title: '高潮后升起',
  kind: 'crane',
  start_tick: 150_440,
  end_tick: 150_856,
  duration_seconds: 6.5,
  rationale: '拆包完成后从包点缓慢升起收尾，给结果一个停顿。',
  evidence_refs: ['目标事件（拆包成功）'],
});

/** The four shots of 方案 #P-118, in order. 42.0 seconds with a 3s 留白. */
export const PLAN_SHOTS: readonly AgentPlanShot[] = [SHOT_ESTABLISH, SHOT_TRACKING, SHOT_POV, SHOT_CRANE];

/** 「02」 after the user shortened it to 5.0s — 「你改过」. */
export const SHOT_TRACKING_EDITED: AgentPlanShot = {
  ...SHOT_TRACKING,
  duration_seconds: 5,
  end_tick: 149_132,
  source: 'user',
  rationale: '沿他的真实移动轴从中路跟到 A 大道。我把它压短了，起手那段留给建立镜头交代。',
};

/** 「04 高潮后升起」 soft-deleted by the user — 「你删除的」, still undoable. */
export const SHOT_CRANE_REMOVED: AgentPlanShot = { ...SHOT_CRANE, removed_by: 'user' };

/* ── the session ─────────────────────────────────────────────────────────── */

export const OBJECT_REF_PLAN: AgentObjectRef = {
  kind: 'plan',
  id: 'P-118',
  label: '方案 #P-118',
  touched_at: '2026-08-15T09:24:00.000Z',
  touch_count: 2,
  summary: '镜头 02 由 Dolly 改为 Tracking；总时长 38 → 42 秒',
  status: '等待确认',
};

export const OBJECT_REF_TASK: AgentObjectRef = {
  kind: 'recording_task',
  id: 'A-2481',
  label: '录制任务 #A-2481',
  touched_at: '2026-08-15T09:26:00.000Z',
  touch_count: 1,
  summary: '4 个片段',
  status: '运行中',
};

export const SESSION_SUMMARY: AgentSessionSummary = {
  id: 'session-kael',
  title: 'Kael 的 1v3',
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:02:00.000Z',
  entry_count: 18,
  refs: [OBJECT_REF_PLAN, OBJECT_REF_TASK],
};

/** 「你在方案上做了 2 处改动」 — the artboard's own expanded JSON, as a record. */
export const EDIT_NOTICE: WorkspaceEditNotice = {
  object: { kind: 'plan', id: 'P-118' },
  revision: 7,
  by: 'user',
  at: '2026-08-15T09:47:12.000Z',
  changes: [
    { shot: 2, op: 'updated', field: 'duration', from: '8.5s', to: '5.0s' },
    { shot: 4, op: 'removed', field: null, from: null, to: null },
  ],
  note: '起手那段留给建立镜头交代',
};

export const USER_ENTRY: AgentSessionEntry = {
  kind: 'user',
  id: 'entry-1',
  at: '2026-08-15T09:44:00.000Z',
  content: '把它压到 30 秒以内',
};

export const ASSISTANT_ENTRY: AgentSessionEntry = {
  kind: 'assistant',
  id: 'entry-2',
  at: '2026-08-15T09:45:00.000Z',
  content: '给了三条变更：镜头 02 缩短到 3 秒、删除镜头 04、删除镜头 01。你接受了前两条，拒绝了第三条。',
  tool_calls: [
    { name: 'read_match_structure', input: null, output: null },
    { name: 'read_spatial_evidence', input: null, output: null },
  ],
  proposals: [],
};

export const EDIT_ENTRY: AgentSessionEntry = {
  kind: 'workspace_edit',
  id: 'entry-3',
  at: '2026-08-15T09:47:12.000Z',
  notice: EDIT_NOTICE,
};

/**
 * The 2a proposal, with the payload shape `readPlanChangeSet` parses: three
 * changes, the third of which the user rejected in the artboard.
 */
export const PLAN_PROPOSAL: AgentSessionProposal = {
  kind: 'plan_change',
  title: '把它压到 30 秒以内',
  plan_id: 'P-118',
  based_on_revision: 6,
  payload: {
    changes: [
      {
        id: 'change-1',
        op: 'shorten',
        target: 'shot-02',
        before: '8.5s',
        after: '3.0s',
        delta_seconds: -5.5,
        rationale: '只保留从中路进入 A 大道的一段，绕后的起手交给 01 的建立镜头交代。',
      },
      {
        id: 'change-2',
        op: 'delete',
        target: 'shot-04',
        delta_seconds: -6.5,
        rationale: '30 秒以内留不住收尾停顿，拆包成功的瞬间本身就是结束点。',
        warning: '结尾会变硬，建议给 03 加 0.5 秒后留白',
      },
      {
        id: 'change-3',
        op: 'delete',
        target: 'shot-01',
        delta_seconds: -3,
        rationale: '你保留了它：没有建立镜头就看不懂后面的绕后路线。',
      },
    ],
  },
};

/* ── the workspace ───────────────────────────────────────────────────────── */

export const REFERENCE_PLAN: KnownWorkspaceReference = {
  kind: 'plan',
  id: 'P-118',
  label: '方案 · Kael Mirage 1v3 · 4 个镜头 · 42 秒',
  status: '等待确认',
  progress_percent: null,
  item_count: 4,
  error: null,
  updated_at: '2026-08-15T09:24:00.000Z',
};

export const REFERENCE_TASK: KnownWorkspaceReference = {
  kind: 'recording_task',
  id: 'A-2483',
  label: '录制任务 · Rhea 双杀',
  status: '运行中 · 可停止或调整未开始的片段',
  progress_percent: 33,
  item_count: 6,
  error: null,
  updated_at: '2026-08-15T09:40:00.000Z',
};

export const REFERENCE_FAILED_OUTPUT: KnownWorkspaceReference = {
  kind: 'output',
  id: 'E-131',
  label: '导出任务 · Aurora 赛点集锦',
  status: '失败',
  progress_percent: null,
  item_count: null,
  error: '磁盘空间不足',
  updated_at: '2026-08-15T08:40:00.000Z',
};

/* ── builders, for the density review ────────────────────────────────────── */

const SHOT_CYCLE: readonly AgentPlanShot[] = PLAN_SHOTS;

/**
 * A plan of `count` shots, cycling the four real ones so every kind, a risk, a
 * long rationale and a soft-deleted shot all appear. Titles are long on purpose
 * — a fixture of short strings proves nothing about truncation.
 */
export function makePlanShots(count: number): readonly AgentPlanShot[] {
  return Array.from({ length: count }, (_, index) => {
    const base = SHOT_CYCLE[index % SHOT_CYCLE.length] ?? SHOT_ESTABLISH;
    return {
      ...base,
      id: `shot-${String(index + 1).padStart(2, '0')}`,
      title: `${base.title} · 第 ${String(index + 1)} 段 · 一个长到必须截断的镜头标题`,
      start_tick: base.start_tick + index * 640,
      end_tick: base.end_tick + index * 640,
      ...(index % 7 === 6 ? { removed_by: 'user' as const } : {}),
      ...(index % 5 === 4 ? { source: 'user' as const } : {}),
    };
  });
}

/**
 * A transcript of `count` entries: user, assistant, and every fourth one a
 * `workspace_edit` line — the mix a session that is actually being edited in
 * produces.
 */
export function makeTranscript(count: number): readonly AgentSessionEntry[] {
  return Array.from({ length: count }, (_, index): AgentSessionEntry => {
    const at = `2026-08-15T09:${String(10 + (index % 45)).padStart(2, '0')}:00.000Z`;
    if (index % 4 === 3) {
      return { kind: 'workspace_edit', id: `entry-${String(index)}`, at, notice: EDIT_NOTICE };
    }
    if (index % 2 === 0) {
      return {
        kind: 'user',
        id: `entry-${String(index)}`,
        at,
        content: `把第 ${String((index % 4) + 1)} 个镜头再压短一点，前面留 1 秒，别切掉击杀`,
      };
    }
    return {
      kind: 'assistant',
      id: `entry-${String(index)}`,
      at,
      content:
        '我把第 2 个镜头从 Dolly 改成了 Tracking：这段路线跨越中路到 A 大道，Dolly 的固定轨迹在没有碰撞数据时有穿墙风险。',
      tool_calls: [{ name: 'read_match_structure', input: null, output: null }],
      proposals: [],
    };
  });
}

/** `count` sessions for the drawer, each touching two objects. */
export function makeSessions(count: number): readonly AgentSessionSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${String(index)}`,
    title: `Kael 的 1v3 · 第 ${String(index + 1)} 次 · 一个长到必须截断的会话标题`,
    created_at: '2026-08-14T09:02:00.000Z',
    updated_at: `2026-08-15T09:${String(index % 60).padStart(2, '0')}:00.000Z`,
    entry_count: 18 + index,
    refs: [
      { ...OBJECT_REF_PLAN, id: `P-${String(100 + index)}`, label: `方案 #P-${String(100 + index)}` },
      { ...OBJECT_REF_TASK, id: `A-${String(2400 + index)}`, label: `录制任务 #A-${String(2400 + index)}` },
    ],
  }));
}
