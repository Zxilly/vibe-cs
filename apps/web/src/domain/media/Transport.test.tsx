import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Transport } from './Transport';

describe('Transport markup', () => {
  it('is a labelled group of real buttons', () => {
    const markup = renderMarkup(<Transport currentTime={31.2} durationSeconds={124} playing={false} />);
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="播放控制"');
    expect(markup).toContain('aria-label="播放"');
    expect(markup).toContain('aria-label="上一帧"');
    expect(markup).toContain('aria-label="下一帧"');
    expect(markup).toContain('aria-label="跳到入点"');
    expect(markup).toContain('aria-label="跳到出点"');
  });

  it('prints the artboard timecode: hh:mm:ss:ff over hh:mm:ss:ff', () => {
    // 「10 多轨编辑器」's monitor reads `00:00:31:12 / 00:02:04:00`.
    const markup = renderMarkup(<Transport currentTime={31.2} durationSeconds={124} playing={false} />);
    expect(markup).toContain('00:00:31:12');
    expect(markup).toContain('00:02:04:00');
  });

  it('can print the ruler form instead', () => {
    const markup = renderMarkup(
      <Transport currentTime={31.2} durationSeconds={124} playing={false} timecode="clock" />,
    );
    expect(markup).toContain('00:31');
    expect(markup).toContain('02:04');
    expect(markup).not.toContain('00:00:31:12');
  });

  it('states play versus pause in the accessible name, not only in the icon', () => {
    const paused = renderMarkup(<Transport currentTime={0} durationSeconds={42} playing={false} />);
    expect(paused).toContain('aria-label="播放"');
    expect(paused).toContain('data-playing="false"');

    const playing = renderMarkup(<Transport currentTime={0} durationSeconds={42} playing />);
    expect(playing).toContain('aria-label="暂停"');
    expect(playing).toContain('data-playing="true"');
    expect(playing).toContain('aria-pressed="true"');
  });

  it('names the two halves of the readout for a screen reader', () => {
    const markup = renderMarkup(<Transport currentTime={4} durationSeconds={42} playing={false} />);
    expect(markup).toContain('当前时间');
    expect(markup).toContain('总时长');
  });

  it('clamps the readout instead of printing a time past the end', () => {
    const markup = renderMarkup(<Transport currentTime={999} durationSeconds={42} playing={false} />);
    expect(markup).toContain('data-current-time="42"');
  });

  it('disables every action with a reason when there is nothing to play', () => {
    const markup = renderMarkup(<Transport currentTime={0} durationSeconds={0} playing={false} />);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('还没有可播放的素材');
  });

  it('hides the rate control unless a rate is given', () => {
    const without = renderMarkup(<Transport currentTime={0} durationSeconds={42} playing={false} />);
    expect(without).not.toContain('播放速率');

    const withRate = renderMarkup(<Transport currentTime={0} durationSeconds={42} playing={false} rate={1} />);
    expect(withRate).toContain('aria-label="播放速率"');
    expect(withRate).toContain('role="radiogroup"');
    expect(withRate).toContain('1×');
    expect(withRate).toContain('0.25×');
  });

  it('renders a trailing slot for the zoom control the artboard puts there', () => {
    const markup = renderMarkup(
      <Transport currentTime={0} durationSeconds={42} playing={false}>
        <span>适应</span>
      </Transport>,
    );
    expect(markup).toContain('适应');
  });

  it('runs no clock of its own — the same props render the same markup', () => {
    const first = renderMarkup(<Transport currentTime={7.5} durationSeconds={42} playing />);
    const second = renderMarkup(<Transport currentTime={7.5} durationSeconds={42} playing />);
    expect(first).toBe(second);
  });
});
