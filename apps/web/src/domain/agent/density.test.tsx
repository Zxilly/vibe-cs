/*
 * 1100 × 700 density review — `domain/agent/` (spec §9 risk 6).
 *
 * Four volumes matter here, and only one of them is on `densityFixtures.ts`
 * (which this round may not edit), so the other three are declared below with
 * the same provenance tags that file uses — 「[画板]」 printed on an artboard,
 * 「[推导]」 arithmetic on top of one.
 *
 *   会话抽屉    14 sessions, each with its object chips
 *   对话流      dozens of entries, mixed bubbles and edit lines
 *   镜头方案    a plan longer than the artboard's four shots
 *   镜头带      the same plan as a proportional band, which must stay exactly
 *               as wide as its container or the ruler under it lies
 */

import { describe, expect, it } from 'vitest';

import { FOLD_CONTENT_WIDTH_PX } from '../densityFixtures';
import { renderMarkup } from '../../test/render';
import { AgentSessionRow } from './AgentSessionRow';
import { AgentTranscript } from './AgentTranscript';
import { PlanShotRow } from './PlanShotRow';
import { PlanStrip } from './PlanStrip';
import { makePlanShots, makeSessions, makeTranscript } from './agentFixtures.testing';
import { planStripSegments } from './planStripLayout';

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** [画板] 「补齐 · Agent 会话历史与设置」 drawer header: 「会话 · 共 14 条」. */
const SESSION_COUNT = 14;

/**
 * [推导] 「12 设置与诊断」's retention default is 「最近 50 条」 and a session that
 * produced a four-shot plan has already exchanged 「你的目标」, four 工作进度
 * steps, a proposal and the edits that followed. Forty is the order a real
 * editing session reaches; nothing measures it, which is why it is derived
 * from the artboards' own traffic rather than stated as observed.
 */
const TRANSCRIPT_ENTRY_COUNT = 40;

/**
 * [推导] The artboards draw four shots (07) and five (Take C). A 42-second cut
 * at the shortest length any of them uses (3.0s) is fourteen; fifteen is the
 * round number just past it, and it is where a 2×2 card grid becomes a scroller.
 */
const PLAN_SHOT_COUNT = 15;

const UTC = { timeZone: 'UTC' } as const;
const NOW = new Date('2026-08-15T10:00:00.000Z');

describe('density · a session的对话流 at forty entries', () => {
  const entries = makeTranscript(TRANSCRIPT_ENTRY_COUNT);

  it('draws every entry, with the edit notices still lines rather than bubbles', () => {
    const html = renderMarkup(<AgentTranscript entries={entries} label="会话" {...UTC} />);

    const notices = entries.filter((entry) => entry.kind === 'workspace_edit').length;
    expect(notices).toBeGreaterThan(0);
    expect(occurrences(html, 'data-agent-bubble=')).toBe(TRANSCRIPT_ENTRY_COUNT - notices);
    expect(occurrences(html, 'data-workspace-edit-line=')).toBe(notices);
  });

  it('scrolls inside the column instead of pushing the composer off the shell', () => {
    const html = renderMarkup(<AgentTranscript entries={entries} label="会话" {...UTC} />);
    const container = /<div[^>]*data-agent-transcript=""[^>]*class="([^"]*)"/u.exec(html)?.[1] ?? '';

    expect(container).toContain('overflow-y-auto');
    // …and the column has to be allowed to shrink, or the scroll never engages
    // and the overflow goes back out to the page.
    expect(container).toContain('min-h-0');
    // Forty entries at ~64px is ~2500px inside a 700px window.
    expect(TRANSCRIPT_ENTRY_COUNT * 64).toBeGreaterThan(700);
  });

  it('keeps every edit notice folded, so a long session is not a wall of JSON', () => {
    const html = renderMarkup(<AgentTranscript entries={entries} label="会话" {...UTC} />);

    expect(occurrences(html, 'data-expanded="false"')).toBeGreaterThan(0);
    expect(html).not.toContain('data-workspace-edit-original');
  });
});

describe('density · the 会话抽屉 at 「共 14 条」', () => {
  const sessions = makeSessions(SESSION_COUNT);

  it('draws all fourteen rows with their object chips', () => {
    const html = renderMarkup(
      <div>
        {sessions.map((session) => (
          <AgentSessionRow key={session.id} session={session} now={NOW} {...UTC} />
        ))}
      </div>,
    );

    expect(occurrences(html, 'data-agent-session=')).toBe(SESSION_COUNT);
    expect(occurrences(html, 'data-agent-object-ref=')).toBe(SESSION_COUNT * 2);
  });

  it('clips the title and lets the chips wrap — the drawer is 470px, not elastic', () => {
    const html = renderMarkup(
      <div>
        {sessions.map((session) => (
          <AgentSessionRow key={session.id} session={session} now={NOW} {...UTC} />
        ))}
      </div>,
    );

    const rows = html.split('<article').slice(1);
    expect(rows).toHaveLength(SESSION_COUNT);
    for (const row of rows) {
      expect(row).toContain('truncate');
      expect(row).toContain('flex-wrap');
    }
  });
});

describe('density · a fifteen-shot plan', () => {
  const shots = makePlanShots(PLAN_SHOT_COUNT);

  it('truncates every card’s title rather than widening the grid', () => {
    const html = renderMarkup(
      <div>
        {shots.map((shot, index) => (
          <PlanShotRow key={shot.id} shot={shot} index={index + 1} />
        ))}
      </div>,
    );

    const cards = html.split('<article').slice(1);
    expect(cards).toHaveLength(PLAN_SHOT_COUNT);
    for (const card of cards) expect(card).toContain('truncate');
  });

  it('keeps the deleted and user-edited shots individually legible in the long list', () => {
    const html = renderMarkup(
      <div>
        {shots.map((shot, index) => (
          <PlanShotRow key={shot.id} shot={shot} index={index + 1} onRestore={() => undefined} />
        ))}
      </div>,
    );

    const removed = shots.filter((shot) => shot.removed_by !== null).length;
    expect(removed).toBeGreaterThan(0);
    // One 撤销删除 per deleted shot — not one 「恢复全部」 at the top standing in
    // for all of them.
    expect(occurrences(html, '撤销删除')).toBe(removed);
    expect(occurrences(html, 'data-shot-source="user"')).toBe(
      shots.filter((shot) => shot.source === 'user').length,
    );
  });
});

describe('density · the strip stays exactly as wide as its container', () => {
  const shots = makePlanShots(PLAN_SHOT_COUNT);

  it('sums to 100% however many shots there are, so the ruler under it is true', () => {
    const segments = planStripSegments(shots, { leadSeconds: 3, leadLabel: '留白' });

    expect(segments).toHaveLength(PLAN_SHOT_COUNT + 1);
    expect(segments.reduce((sum, segment) => sum + segment.percent, 0)).toBeCloseTo(100, 6);
  });

  it('clips the block labels instead of letting a title widen the band', () => {
    const html = renderMarkup(<PlanStrip shots={shots} ruler label="当前方案" />);

    expect(occurrences(html, 'truncate')).toBe(PLAN_SHOT_COUNT);
    expect(html).toContain('overflow-hidden');
    // The narrowest block at the fold: the shortest shot of the plan is a
    // sliver, and a sliver is what it should be — the ruler is the reading.
    const narrowest = Math.min(...planStripSegments(shots).map((segment) => segment.percent));
    expect((narrowest / 100) * FOLD_CONTENT_WIDTH_PX).toBeGreaterThan(0);
  });
});
