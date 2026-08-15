/*
 * `markup` project — the workspace frame and the view contract.
 *
 * Two things are pinned here, and both are contracts the three phase-3c agents
 * build on top of:
 *
 *   1. the nine ids are exactly §7's merge table, in the artboard's order, and
 *      the registry is total over them;
 *   2. the shell renders the constant chrome — context bar, 190px rail, docked
 *      380px Inspector — around whichever view the address selects.
 *
 * The fold (§8 rules 2 and 3) needs a viewport, so it lives in
 * `matchWorkspace.interaction.test.tsx`.
 */

import { describe, expect, it } from 'vitest';

import { EVIDENCE_KIND } from '../../domain/match';
import { MATCH_VIEW, MATCH_VIEW_IDS, MATCH_VIEWS } from './viewContract';
import { markupAt } from './test/renderWorkspace';

/**
 * §7, copied out of the spec rather than derived from the module under test —
 * a test that imports its own expectation proves nothing.
 *
 *   「比赛工作区 `view` 取值（9 个，按设计稿的归并表）：
 *    overview | rounds | players | duels | utility | replay | highlights |
 *    review | teams」
 */
const SPEC_VIEWS = [
  'overview',
  'rounds',
  'players',
  'duels',
  'utility',
  'replay',
  'highlights',
  'review',
  'teams',
] as const;

describe('the nine views', () => {
  it('are exactly §7’s list, in §7’s order', () => {
    expect([...MATCH_VIEW_IDS]).toEqual([...SPEC_VIEWS]);
  });

  it('each have a label and an icon', () => {
    for (const id of MATCH_VIEW_IDS) {
      const meta = MATCH_VIEW[id];
      expect(`${id}:${String(meta.id)}`).toBe(`${id}:${id}`);
      expect(`${id}:${typeof meta.label.id}`).toBe(`${id}:string`);
      expect(`${id}:${typeof meta.icon}`).toBe(`${id}:object`);
    }
  });

  it('keeps 「回合」 apart from the evidence kind of the same name', () => {
    /* `msg({ message, context })` folds the context into the compiled id, so two
       screens that write the same word end up with two catalogue entries and
       can be translated apart. §10.4 deviation 3 is the reason the *whole*
       vocabulary carries `match-view` and not only the word that collides
       today: an untagged member silently inherits another screen's translation
       the moment someone adds one. */
    expect(MATCH_VIEW.rounds.label.id).not.toBe(EVIDENCE_KIND.round.label.id);
    expect(MATCH_VIEW.rounds.label.message).toBe(EVIDENCE_KIND.round.label.message);

    // Distinct ids across the nine, so no two rail entries share a catalogue
    // entry by accident either.
    const ids = MATCH_VIEW_IDS.map((id) => MATCH_VIEW[id].label.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a registry entry for every id, keyed by its own id', () => {
    for (const id of MATCH_VIEW_IDS) {
      expect(`${id}:${MATCH_VIEWS[id].id}`).toBe(`${id}:${id}`);
      expect(`${id}:${typeof MATCH_VIEWS[id].Body}`).toBe(`${id}:function`);
    }
    expect(Object.keys(MATCH_VIEWS)).toHaveLength(MATCH_VIEW_IDS.length);
  });
});

describe('the address selects the view', () => {
  it.each(MATCH_VIEW_IDS)('?view=%s renders that view and marks it current', (id) => {
    const html = markupAt(`/match/aurora?view=${id}`);
    expect(html).toContain(`data-match-view="${id}"`);
    expect(html).toContain(`data-subnav-item="${id}" aria-current="page"`);
  });

  it('falls back to 概览 on an unknown or absent view', () => {
    for (const url of ['/match/aurora', '/match/aurora?view=cosmetics', '/match/aurora?view=']) {
      expect(`${url}:${String(markupAt(url).includes('data-match-view="overview"'))}`).toBe(
        `${url}:true`,
      );
    }
  });

  it('carries the rest of the §4.4 context into the view', () => {
    const html = markupAt('/match/aurora?view=rounds&round=21&player=kael&tick=149380');
    expect(html).toContain('data-match-view="rounds"');
    expect(html).toContain('R21');
  });
});

describe('the constant chrome', () => {
  const html = markupAt('/match/aurora');

  it('is a Page whose body owns its own scrolling', () => {
    expect(html).toContain('data-page=');
    expect(html).toContain('data-page-body');
    expect(html).not.toMatch(/data-page-body="true" class="[^"]*overflow-auto/u);
  });

  it('pins the match context bar above every view', () => {
    expect(html).toContain('data-page-toolbar');
    expect(html).toContain('data-match-context-bar=');
    expect(html).toContain('data-match-back=');
  });

  it('keeps §8’s non-negotiable primary action on the bar', () => {
    expect(html).toContain('用 Agent 制作视频');
    expect(html).toContain('data-match-actions=');
  });

  it('draws the rail as a 190px column and the Inspector as a docked panel', () => {
    expect(html).toContain('data-subnav="rail"');
    expect(html).toContain('w-[var(--w-subnav)]');
    expect(html).toContain('data-inspector="docked"');
    expect(html).toContain('w-[var(--w-inspector)]');
  });

  it('shows the empty Inspector rather than an invented selection', () => {
    expect(html).toContain('data-inspector-title');
    expect(html).toContain('选中项');
    expect(html).toContain('在左侧选择一个回合');
  });

  it('disables 加入视频 and says why, instead of hiding it', () => {
    expect(html).toContain('data-match-add-to-video=');
    expect(html).toContain('录制队列尚未接通');
  });

  it('draws no highlight badge while the analysis is still loading', () => {
    // A badge reading 0 during a pending read is a claim, not a placeholder.
    expect(html).not.toMatch(/data-subnav-item="highlights"[\s\S]{0,400}text-accent-700/u);
  });

  it('invents no progress', () => {
    expect(html).not.toContain('role="progressbar"');
  });
});
