/*
 * pages/settings — the pure half of 设置 · AI 与 Agent
 * (artboard 「补齐 · Agent 会话历史与设置」, §7's fourth section).
 *
 * No React and no copy, so `aiAgentModel.test.ts` exhausts it in the `unit`
 * project. Three things live here because all three would otherwise be
 * re-derived inside a JSX expression:
 *
 *   1. the four retention presets the artboard draws, and what happens when the
 *      stored policy is none of them
 *   2. the take limit's range and its clamp
 *   3. 「录制前始终由你确认」 — which is not a setting at all
 */

import { TASK_REQUIRES_CONFIRMATION } from '../../domain/task';
import { retentionOptionId } from '../../data/sessions';
import type { AgentSessionRetention } from '../../shared/desktop/dto';

/* ── 1. 保留多久 ─────────────────────────────────────────────────────────── */

/**
 * The artboard's four: 全部保留 / 最近 50 条 / 30 天 / 不保留.
 *
 * `AgentSessionRetention` is a tagged union with a payload, so a preset is a
 * whole value rather than a string; `retentionOptionId` (data/sessions.ts)
 * flattens one to the scalar a `Seg` needs, and it is imported rather than
 * re-derived so the two spellings cannot drift.
 */
export const RETENTION_PRESETS: readonly AgentSessionRetention[] = [
  { mode: 'all' },
  { mode: 'recent_count', count: 50 },
  { mode: 'max_age_days', days: 30 },
  { mode: 'none' },
];

/**
 * The options the control offers, given what is stored.
 *
 * A backend that holds 「最近 20 条」 — a number no preset covers — gets a fifth
 * option carrying its own value, appended, and selected. The alternative is a
 * segmented control that shows 「最近 50 条」 while the server keeps 20, and then
 * silently writes 50 the first time the user touches anything else on the page.
 * Showing the truth costs one extra option; hiding it costs the user's data.
 */
export function retentionChoices(current: AgentSessionRetention): readonly AgentSessionRetention[] {
  const currentId = retentionOptionId(current);
  const known = RETENTION_PRESETS.some((preset) => retentionOptionId(preset) === currentId);
  return known ? RETENTION_PRESETS : [...RETENTION_PRESETS, current];
}

/** The option a `Seg` change maps back to, or `null` for an id nobody offered. */
export function retentionFromOptionId(
  id: string,
  choices: readonly AgentSessionRetention[],
): AgentSessionRetention | null {
  return choices.find((choice) => retentionOptionId(choice) === id) ?? null;
}

/* ── 2. take 上限 ────────────────────────────────────────────────────────── */

/**
 * The artboard draws the thumb at 40 % with the readout 「5」 and no end labels,
 * so the range is a decision rather than a measurement. One take is the floor
 * (a limit of zero would discard the take the user is looking at), and ten is a
 * ceiling that keeps the slider's steps meaningful — §4.5.2's takes are whole
 * plans, not undo entries.
 */
export const TAKE_LIMIT_MIN = 1;
export const TAKE_LIMIT_MAX = 10;

/**
 * A stored limit outside the range is clamped for the control but never written
 * back on its own: the panel writes only what the user moved. A non-finite
 * value falls to the floor rather than to `NaN`, which would detach the thumb.
 */
export function clampTakeLimit(value: number): number {
  if (!Number.isFinite(value)) return TAKE_LIMIT_MIN;
  return Math.min(TAKE_LIMIT_MAX, Math.max(TAKE_LIMIT_MIN, Math.round(value)));
}

/* ── 3. 录制前始终由你确认 ───────────────────────────────────────────────── */

/**
 * §4.5.3 rule ①, read from where the product already encodes it rather than
 * re-asserted here: `domain/task`'s task machine is what actually refuses to
 * start a recording without a confirmation, and the settings switch is a
 * *readout* of that. It is drawn on and locked — the artboard paints it at 70 %
 * with the line 「不可关闭：录制会启动游戏并写出文件，必须有一次人工确认」 — and
 * `AgentWorkspaceSettings` has no field for it, which is correct: a rule of the
 * system is not a preference (contract gap 4).
 */
export const RECORDING_CONFIRMATION_LOCKED_ON: boolean = TASK_REQUIRES_CONFIRMATION.recording;
