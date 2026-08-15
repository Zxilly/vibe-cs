import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { FilmStrip } from './FilmStrip';
import type { FilmFrame } from './types';

const frames: FilmFrame[] = [
  { time: 0, src: 'asset://f0.jpg' },
  { time: 10, src: 'asset://f1.jpg' },
  { time: 20, src: 'asset://f2.jpg' },
];

describe('FilmStrip markup', () => {
  it('is a list, one cell per frame', () => {
    const markup = renderMarkup(<FilmStrip frames={frames} />);
    expect(markup).toContain('role="list"');
    expect(markup.match(/<li/gu)).toHaveLength(3);
    expect(markup).toContain('aria-label="缩略图条，共 3 帧"');
  });

  it('takes its cell size from the §3.5 track-head token, at 16:9', () => {
    // theme.css: `--w-track-head` (132px) also carries the 132×74 thumbnail.
    const markup = renderMarkup(<FilmStrip frames={frames} />);
    expect(markup).toContain('w-[var(--w-track-head)]');
    expect(markup).toContain('aspect-video');
  });

  it('renders the thumbnails it is given and decodes nothing', () => {
    const markup = renderMarkup(<FilmStrip frames={frames} />);
    expect(markup).toContain('src="asset://f0.jpg"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).not.toContain('<video');
    expect(markup).not.toContain('<canvas');
  });

  it('stamps every cell with its time', () => {
    const markup = renderMarkup(<FilmStrip frames={frames} />);
    expect(markup).toContain('>00:00<');
    expect(markup).toContain('>00:10<');
    expect(markup).toContain('>00:20<');
  });

  it('describes an image by the moment it shows', () => {
    const markup = renderMarkup(<FilmStrip frames={frames} />);
    expect(markup).toContain('alt="00:10 的画面"');
  });

  it('lets a caller override that description', () => {
    const markup = renderMarkup(<FilmStrip frames={[{ time: 3, src: 'a://x', alt: '烟雾散开的一刻' }]} />);
    expect(markup).toContain('alt="烟雾散开的一刻"');
  });

  it('draws evenly spaced placeholder cells when there are no thumbnails', () => {
    const markup = renderMarkup(<FilmStrip durationSeconds={40} placeholderCount={4} />);
    expect(markup.match(/<li/gu)).toHaveLength(4);
    expect(markup).not.toContain('<img');
    expect(markup).toContain('repeating-linear-gradient');
    expect(markup).toContain('>00:00<');
    expect(markup).toContain('>00:30<');
  });

  it('marks the cell the playhead is inside, not the nearest one', () => {
    const markup = renderMarkup(<FilmStrip frames={frames} currentTime={19.5} />);
    expect(markup).toContain('data-time="10" data-current="true"');
    expect(markup.match(/data-current="true"/gu)).toHaveLength(1);
  });

  it('marks nothing when there is no playhead', () => {
    expect(renderMarkup(<FilmStrip frames={frames} />)).not.toContain('data-current="true"');
  });

  it('is static unless it is given somewhere to seek to', () => {
    const still = renderMarkup(<FilmStrip frames={frames} />);
    expect(still).not.toContain('<button');

    const seekable = renderMarkup(<FilmStrip frames={frames} onSeek={() => {}} />);
    expect(seekable.match(/<button/gu)).toHaveLength(3);
    expect(seekable).toContain('aria-label="跳到 00:10"');
  });

  it('renders an empty state when there is nothing and no duration to guess from', () => {
    const markup = renderMarkup(<FilmStrip />);
    expect(markup).toContain('还没有缩略图');
    expect(markup).not.toContain('role="list"');
  });

  it('renders a skeleton while the thumbnails are being made', () => {
    const markup = renderMarkup(<FilmStrip durationSeconds={40} loading />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('正在生成缩略图');
    expect(markup).toContain('animate-pulse');
    expect(markup).not.toContain('还没有缩略图');
  });

  it('renders the same markup twice — nothing here measures anything', () => {
    const markup = renderMarkup(<FilmStrip frames={frames} currentTime={5} />);
    expect(renderMarkup(<FilmStrip frames={frames} currentTime={5} />)).toBe(markup);
  });
});
