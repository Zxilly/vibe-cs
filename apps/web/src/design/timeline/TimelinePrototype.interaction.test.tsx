/*
 * Interaction tests, part 1 of 2 — the commands.
 *
 * §0.5 asks for six capabilities to be proven. Four are driven from the toolbar
 * and the keyboard and live here (剃刀 / 波纹删除 / 滑移 / 缩放); the two that need a
 * pointer (拖拽 and its 吸附) are in `timelineDrag.interaction.test.tsx`.
 *
 * Everything is addressed the way a user would address it — a button by its
 * label, a tool by its radio, the playhead by its slider — so a failure here
 * means a capability became unreachable, not that a class name changed.
 */

import { act, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderInteractive } from '../../test/render';
import { createSampleTimeline } from './sampleTimeline';
import { TimelinePrototype } from './TimelinePrototype';
import { createTimeline, type Timeline } from './timelineModel';

/**
 * A time in frames, as the editor holds it.
 *
 * The fixture transcribes the artboard's pixels ÷ 12, which does not land on
 * the 60fps grid: 42.167s is 2530.02 frames. `useTimelineEditor` quantises the
 * document on mount and after every commit (`frameGrid.ts`), so the DOM
 * carries `2530 / 60` and not the transcription. Writing the frame count is
 * how these assertions stay readable — and `frames(2530)` says the artboard's
 * 42.167s in the unit the editor actually works in.
 */
const frames = (count: number) => count / 60;

function setup(initial: Timeline = createSampleTimeline()) {
  const view = renderInteractive(<TimelinePrototype initial={initial} />);
  const { container, getByRole } = view;

  const clip = (id: string) => container.querySelector<HTMLButtonElement>(`[data-clip="${id}"]`);
  const clipCount = () => container.querySelectorAll('.tl-clip').length;
  const start = (id: string) => Number(clip(id)?.dataset.start);
  const sourceIn = (id: string) => Number(clip(id)?.dataset.sourceIn);
  const laneOf = (id: string) => clip(id)?.closest('.tl-lane')?.getAttribute('data-track');
  /**
   * Focus is what selects a clip, so this is also the keyboard's own path.
   * `act` is needed because a raw `.focus()` is not a Testing Library event:
   * without it the selection would still be queued when the next click's
   * handler closure is read.
   */
  const select = (id: string) => {
    const element = clip(id);
    if (element === null) throw new Error(`no clip ${id}`);
    act(() => {
      element.focus();
    });
    return element;
  };
  const button = (name: string | RegExp) => getByRole('button', { name }) as HTMLButtonElement;
  const playhead = () => getByRole('slider', { name: '播放头' });
  const notice = () => view.queryByRole('alert');

  return { ...view, clip, clipCount, start, sourceIn, laneOf, select, button, playhead, notice };
}

/** Two video lanes with one clip between them: room to move across tracks. */
function sparseTimeline(): Timeline {
  return createTimeline({
    tracks: [
      { id: 'v2', kind: 'video', name: 'V2', role: '叠加' },
      { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
      { id: 'a1', kind: 'audio', name: 'A1', role: '原声' },
    ],
    clips: [{ id: 'x', trackId: 'v1', start: 10, duration: 4, sourceIn: 2, sourceDuration: 20, label: 'X' }],
    playhead: 12,
  });
}

describe('the playhead', () => {
  it('is a slider the keyboard can drive', () => {
    const { playhead } = setup();
    const slider = playhead();

    slider.focus();
    expect(document.activeElement).toBe(slider);
    expect(slider.getAttribute('aria-valuenow')).toBe(String(frames(1870)));

    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider.getAttribute('aria-valuenow')).toBe('0');

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuenow')).toBe('1');

    fireEvent.keyDown(slider, { key: 'ArrowRight', shiftKey: true });
    expect(slider.getAttribute('aria-valuenow')).toBe('11');

    fireEvent.keyDown(slider, { key: 'ArrowLeft', shiftKey: true });
    expect(slider.getAttribute('aria-valuenow')).toBe('1');
  });

  it('never goes below zero', () => {
    const { playhead } = setup();
    fireEvent.keyDown(playhead(), { key: 'Home' });
    fireEvent.keyDown(playhead(), { key: 'ArrowLeft' });
    expect(playhead().getAttribute('aria-valuenow')).toBe('0');
  });

  it('moves the drawn playhead with it', () => {
    const { playhead, container } = setup();
    fireEvent.keyDown(playhead(), { key: 'Home' });
    expect(container.querySelector<HTMLElement>('.tl-playhead')?.dataset.time).toBe('0');
  });
});

describe('剃刀 — cutting at the playhead', () => {
  it('cuts every clip the playhead crosses and gets the in points right', () => {
    const { button, clipCount, clip, start, sourceIn } = setup();
    expect(clipCount()).toBe(10);

    fireEvent.click(button('在播放头切开'));

    // At 31.167 the blade crosses V1 Kael, its A1 partner and the A2 music.
    expect(clipCount()).toBe(13);
    expect(start('v1-kael')).toBe(0);
    expect(Number(clip('v1-kael')?.dataset.duration)).toBeCloseTo(frames(1870), 9);
    expect(start('v1-kael~2')).toBe(frames(1870));
    // The right half starts 31.167s into the same source file.
    expect(sourceIn('v1-kael~2')).toBeCloseTo(frames(1870), 9);
    expect(sourceIn('v1-kael')).toBe(0);
  });

  it('cuts the A/V pair together', () => {
    const { button, clip } = setup();
    fireEvent.click(button('在播放头切开'));
    expect(clip('a1-kael~2')).not.toBeNull();
    expect(Number(clip('a1-kael~2')?.dataset.start)).toBe(frames(1870));
  });

  it('says so instead of doing nothing when the blade misses everything', () => {
    const { button, playhead, clipCount, notice } = setup();
    fireEvent.keyDown(playhead(), { key: 'End' }); // past the last clip

    fireEvent.click(button('在播放头切开'));
    expect(clipCount()).toBe(10);
    expect(notice()?.textContent).toContain('这个位置没有可以操作的片段');
  });

  it('cuts the selected clip alone from the keyboard', () => {
    const { select, clipCount, clip } = setup();
    select('v1-kael');
    fireEvent.keyDown(clip('v1-kael')!, { key: 's' });
    // The A/V pair still goes together, but the music on A2 does not.
    expect(clipCount()).toBe(12);
    expect(clip('a2-music~2')).toBeNull();
  });
});

describe('波纹删除', () => {
  it('is unavailable until something is selected, and says why', () => {
    const { button } = setup();
    const action = button('波纹删除');
    expect(action.disabled).toBe(true);
    expect(action.getAttribute('aria-describedby')).not.toBeNull();
    expect(action.title).toContain('先选中一个片段');
  });

  it('removes the pair and pulls the rest of both lanes left', () => {
    const { select, button, start, clip, clipCount } = setup();
    select('v1-kael');
    fireEvent.click(button('波纹删除'));

    expect(clip('v1-kael')).toBeNull();
    expect(clip('a1-kael')).toBeNull();
    expect(clipCount()).toBe(8);
    // 42.167 − 42 on both lanes, and they stay in sync.
    expect(start('v1-aurora')).toBeCloseTo(frames(10), 9);
    expect(start('a1-aurora')).toBeCloseTo(frames(10), 9);
    // A2's music never moves: the default scope is the link group, not all lanes.
    expect(start('a2-music')).toBe(0);
  });

  it('is also Shift+Delete on the clip itself', () => {
    const { select, clip, start } = setup();
    select('v1-kael');
    fireEvent.keyDown(clip('v1-kael')!, { key: 'Delete', shiftKey: true });
    expect(clip('v1-kael')).toBeNull();
    expect(start('v1-aurora')).toBeCloseTo(frames(10), 9);
  });

  it('plain Delete leaves the gap where it was', () => {
    const { select, clip, start } = setup();
    select('v1-kael');
    fireEvent.keyDown(clip('v1-kael')!, { key: 'Delete' });
    expect(clip('v1-kael')).toBeNull();
    expect(start('v1-aurora')).toBe(frames(2530));
  });
});

describe('滑移', () => {
  it('moves the source window and leaves the clip where it is', () => {
    const { getByRole, select, clip, start, sourceIn } = setup();
    fireEvent.click(getByRole('radio', { name: '滑移' }));

    select('v1-aurora');
    const before = { start: start('v1-aurora'), sourceIn: sourceIn('v1-aurora') };
    fireEvent.keyDown(clip('v1-aurora')!, { key: 'ArrowRight', shiftKey: true });

    expect(start('v1-aurora')).toBe(before.start);
    expect(sourceIn('v1-aurora')).toBeCloseTo(before.sourceIn + 1, 6);
    // The linked audio slips with it, or the pair would drift out of sync.
    expect(sourceIn('a1-aurora')).toBeCloseTo(before.sourceIn + 1, 6);
  });

  it('shows the source in / out points while the tool is active', () => {
    const { getByRole, container } = setup();
    // `00:00:04:08` is the artboard's own Inspector reading for Aurora's in
    // point, and until the frame grid existed the timeline printed 04:07: the
    // fixture's 4.133s is 247.98 frames, and a timecode floors. Quantising the
    // document on mount makes it frame 248, which is what was drawn.
    expect(container.textContent).not.toContain('00:00:04:08');
    fireEvent.click(getByRole('radio', { name: '滑移' }));
    expect(container.textContent).toContain('00:00:04:08');
  });

  it('stops at the end of the source and says why', () => {
    const { getByRole, select, clip, sourceIn, notice } = setup();
    fireEvent.click(getByRole('radio', { name: '滑移' }));
    select('v1-aurora');

    // 3.867s of tail: four 1s shoves reach it, the fifth has nowhere to go.
    for (let shove = 0; shove < 5; shove += 1) {
      fireEvent.keyDown(clip('v1-aurora')!, { key: 'ArrowRight', shiftKey: true });
    }
    expect(sourceIn('v1-aurora')).toBeCloseTo(8, 6);
    expect(notice()?.textContent).toContain('素材已经到头了');
  });

  it('leaves the arrow keys as a move while the select tool is active', () => {
    const { select, clip, start, sourceIn } = setup();
    select('v2-kael');
    const before = sourceIn('v2-kael');
    fireEvent.keyDown(clip('v2-kael')!, { key: 'ArrowRight', shiftKey: true });
    expect(start('v2-kael')).toBe(9);
    expect(sourceIn('v2-kael')).toBe(before);
  });
});

describe('keyboard editing with the select tool', () => {
  it('nudges by a tenth of a second, or a second with Shift', () => {
    const { select, clip, start } = setup();
    select('v2-kael');
    fireEvent.keyDown(clip('v2-kael')!, { key: 'ArrowRight' });
    expect(start('v2-kael')).toBeCloseTo(8.1, 6);
    fireEvent.keyDown(clip('v2-kael')!, { key: 'ArrowLeft', shiftKey: true });
    expect(start('v2-kael')).toBeCloseTo(7.1, 6);
  });

  it('refuses to nudge into a neighbour, and says so', () => {
    const { select, clip, start, notice } = setup();
    select('v1-aurora');
    // V1 Kael ends at 42 and Aurora starts at 42.167: one 1s shove collides.
    fireEvent.keyDown(clip('v1-aurora')!, { key: 'ArrowLeft', shiftKey: true });
    expect(start('v1-aurora')).toBe(frames(2530));
    expect(notice()?.textContent).toContain('这里已经有片段了');
  });

  it('moves to the lane above with ArrowUp and back down with ArrowDown', () => {
    const { select, clip, laneOf, start } = setup(sparseTimeline());
    select('x');
    expect(laneOf('x')).toBe('v1');

    fireEvent.keyDown(clip('x')!, { key: 'ArrowUp' });
    expect(laneOf('x')).toBe('v2');
    // A cross-track move keeps the time: only the lane changes.
    expect(start('x')).toBe(10);

    fireEvent.keyDown(clip('x')!, { key: 'ArrowDown' });
    expect(laneOf('x')).toBe('v1');
  });

  it('refuses to move a video clip down onto an audio lane', () => {
    const { select, clip, laneOf, notice } = setup(sparseTimeline());
    select('x');
    fireEvent.keyDown(clip('x')!, { key: 'ArrowUp' }); // now on V2, the top lane
    fireEvent.keyDown(clip('x')!, { key: 'ArrowUp' }); // nothing above it
    expect(laneOf('x')).toBe('v2');
    expect(notice()?.textContent).toContain('轨道类型不同');
  });

  it('refuses when the only lane below is an audio one', () => {
    const { select, clip, laneOf, notice } = setup();
    select('v1-aurora');
    fireEvent.keyDown(clip('v1-aurora')!, { key: 'ArrowDown' });
    expect(laneOf('v1-aurora')).toBe('v1');
    expect(notice()?.textContent).toContain('轨道类型不同');
  });

  it('leaves keys it does not use to the browser', () => {
    const { select, clip } = setup();
    select('v2-kael');
    expect(fireEvent.keyDown(clip('v2-kael')!, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(clip('v2-kael')!, { key: 'ArrowRight' })).toBe(false);
  });
});

describe('缩放', () => {
  it('changes only the pixels-per-second, and the readout with it', () => {
    const { button, container, getByTestId } = setup();
    const root = container.querySelector<HTMLElement>('.tl')!;
    expect(root.style.getPropertyValue('--tl-pps')).toBe('12');

    fireEvent.click(button('放大'));
    expect(root.style.getPropertyValue('--tl-pps')).toBe('24');
    expect(getByTestId('zoom-readout').textContent).toContain('1 秒 = 24 px');

    fireEvent.click(button('缩小'));
    fireEvent.click(button('缩小'));
    expect(root.style.getPropertyValue('--tl-pps')).toBe('6');
  });

  it('does not re-lay-out the DOM: the clip nodes survive a zoom', () => {
    // Spec §0.5: 「缩放时不要重排 DOM」. The same element object has to still be
    // there afterwards, with an unchanged position in seconds.
    const { button, clip } = setup();
    const before = clip('v1-aurora')!;
    const positionBefore = before.style.getPropertyValue('--tl-t0');

    fireEvent.click(button('放大'));
    fireEvent.click(button('放大'));

    expect(clip('v1-aurora')).toBe(before);
    expect(before.style.getPropertyValue('--tl-t0')).toBe(positionBefore);
    expect(before.style.getPropertyValue('--tl-dur')).toBe('28');
  });

  it('keeps the playhead and the ruler on the same scale as the clips', () => {
    const { button, container } = setup();
    fireEvent.click(button('放大'));
    // Everything positions itself in seconds; one --tl-pps drives them all.
    expect(container.querySelector<HTMLElement>('.tl-playhead')?.dataset.time).toBe(String(frames(1870)));
    expect(container.querySelector<HTMLElement>('.tl-tick')?.style.getPropertyValue('--tl-t')).toBe('0');
    expect(container.querySelectorAll('[style*="--tl-pps"]')).toHaveLength(1);
  });

  it('stops at the ends of the ladder', () => {
    const { button, container } = setup();
    const root = container.querySelector<HTMLElement>('.tl')!;
    for (let step = 0; step < 10; step += 1) fireEvent.click(button('放大'));
    expect(root.style.getPropertyValue('--tl-pps')).toBe('192'); // 16×
    for (let step = 0; step < 20; step += 1) fireEvent.click(button('缩小'));
    expect(root.style.getPropertyValue('--tl-pps')).toBe('1.5'); // 0.125×
  });
});

describe('撤销 / 重做', () => {
  it('starts with nothing to undo and nothing to redo', () => {
    const { button } = setup();
    expect(button('撤销').disabled).toBe(true);
    expect(button('重做').disabled).toBe(true);
  });

  it('takes one entry per gesture and puts the document back', () => {
    const { button, clipCount, start, select } = setup();

    fireEvent.click(button('在播放头切开'));
    expect(clipCount()).toBe(13);

    select('v1-aurora');
    fireEvent.click(button('波纹删除'));
    expect(clipCount()).toBe(11);

    fireEvent.click(button('撤销'));
    expect(clipCount()).toBe(13);
    fireEvent.click(button('撤销'));
    expect(clipCount()).toBe(10);
    expect(start('v1-kael')).toBe(0);
    expect(button('撤销').disabled).toBe(true);

    fireEvent.click(button('重做'));
    expect(clipCount()).toBe(13);
  });

  it('drops the redo branch once a new edit lands', () => {
    const { button, clipCount } = setup();
    fireEvent.click(button('在播放头切开'));
    fireEvent.click(button('撤销'));
    expect(button('重做').disabled).toBe(false);

    fireEvent.click(button('在播放头切开'));
    expect(button('重做').disabled).toBe(true);
    expect(clipCount()).toBe(13);
  });

  it('does not record a refused edit', () => {
    const { select, clip, button } = setup();
    select('v1-aurora');
    fireEvent.keyDown(clip('v1-aurora')!, { key: 'ArrowLeft', shiftKey: true });
    expect(button('撤销').disabled).toBe(true);
  });
});

describe('the refusal notice', () => {
  it('can be dismissed, and clears itself on the next successful edit', () => {
    const { select, clip, button, getByRole, notice } = setup();

    select('v1-aurora');
    fireEvent.keyDown(clip('v1-aurora')!, { key: 'ArrowLeft', shiftKey: true });
    expect(notice()).not.toBeNull();

    fireEvent.click(getByRole('button', { name: '知道了' }));
    expect(notice()).toBeNull();

    fireEvent.keyDown(clip('v1-aurora')!, { key: 'ArrowLeft', shiftKey: true });
    expect(notice()).not.toBeNull();
    fireEvent.click(button('在播放头切开'));
    expect(notice()).toBeNull();
  });
});

describe('selection', () => {
  it('follows focus, so tabbing through a lane keeps the readout honest', () => {
    const { select, getByTestId, clip } = setup();
    expect(getByTestId('selection-readout').textContent).toContain('未选中片段');

    select('v1-aurora');
    expect(getByTestId('selection-readout').textContent).toContain('Aurora_R13_ace.mp4');
    expect(clip('v1-aurora')?.getAttribute('aria-pressed')).toBe('true');

    select('a2-music');
    expect(clip('v1-aurora')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('marks the A/V partner of the selection as linked', () => {
    const { select, clip } = setup();
    select('v1-aurora');
    expect(clip('a1-aurora')?.dataset.linked).toBe('true');
    expect(clip('a2-music')?.dataset.linked).toBe('false');
  });
});
