import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { CameraPathLayer, type CameraPath } from './CameraPathLayer';
import type { MapCalibration } from './mapCalibration';
import { createMapProjection } from './mapProjection';

const UNIT_MAP: MapCalibration = {
  mapName: 'de_unit',
  originX: 0,
  originY: 1024,
  unitsPerPixel: 1,
  overviewSize: 1024,
  confidence: 'verified',
  provenance: 'test fixture',
};

const projection = createMapProjection(UNIT_MAP, { width: 720, height: 720 });

const tracking: CameraPath = {
  shotId: 'shot-02',
  shotLabel: '02 跟随突破 · Tracking',
  keyframes: [
    { id: 'kf-1', kind: 'start', tick: 148_812, x: 100, y: 900, label: '相机起点' },
    { id: 'kf-2', kind: 'track', tick: 149_000, x: 500, y: 600 },
    { id: 'kf-3', kind: 'end', tick: 149_356, x: 800, y: 300, bearing: 132, label: '相机终点' },
  ],
};

describe('CameraPathLayer', () => {
  it('draws the dashed camera trajectory of 「08 录制计划与镜头预览」', () => {
    const html = renderMarkup(
      <svg>
        <CameraPathLayer projection={projection} paths={[tracking]} />
      </svg>,
    );
    expect(html).toContain('data-role="camera-track"');
    expect(html).toContain('stroke-dasharray="7 5"');
    expect(html).toContain('stroke-accent-800');
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it('marks the two ends the way the artboard labels them: a dot and a hollow square', () => {
    const html = renderMarkup(
      <svg>
        <CameraPathLayer projection={projection} paths={[tracking]} />
      </svg>,
    );
    expect(html).toContain('data-role="camera-start"');
    expect(html).toContain('data-role="camera-end"');
  });

  it('draws the end captions only when asked, because several shots would collide', () => {
    const without = renderMarkup(
      <svg>
        <CameraPathLayer projection={projection} paths={[tracking]} />
      </svg>,
    );
    const withLabels = renderMarkup(
      <svg>
        <CameraPathLayer projection={projection} paths={[tracking]} showEndLabels />
      </svg>,
    );
    expect(without).not.toContain('data-role="camera-start-label"');
    expect(withLabels).toContain('data-role="camera-start-label"');
    expect(withLabels).toContain('data-role="camera-end-label"');
  });

  it('makes every keyframe its own addressable object', () => {
    const html = renderMarkup(
      <svg>
        <CameraPathLayer projection={projection} paths={[tracking]} />
      </svg>,
    );
    expect(html.match(/data-role="keyframe"/gu)).toHaveLength(3);
    expect(html).toContain('data-keyframe="kf-2"');
    expect(html).toContain('data-kind="track"');
    expect(html).toContain('data-tick="149356"');
  });

  it('names a keyframe with its shot, its label, its tick and its bearing', () => {
    const html = renderMarkup(
      <svg>
        <CameraPathLayer projection={projection} paths={[tracking]} />
      </svg>,
    );
    expect(html).toContain('02 跟随突破 · Tracking 关键点 相机终点');
    expect(html).toContain('朝向 132°');
  });

  it('marks the selected keyframe with a ring', () => {
    const html = renderMarkup(
      <svg>
        <CameraPathLayer projection={projection} paths={[tracking]} selectedKeyframeId="kf-2" />
      </svg>,
    );
    expect(html).toContain('data-role="selection-ring"');
    expect(html).toContain('data-selected="true"');
  });

  it('is inert without an onSelectKeyframe', () => {
    const html = renderMarkup(
      <svg>
        <CameraPathLayer projection={projection} paths={[tracking]} />
      </svg>,
    );
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain('tabindex');
  });

  it('gives one tab stop across every keyframe of every shot', () => {
    const second: CameraPath = {
      ...tracking,
      shotId: 'shot-03',
      keyframes: tracking.keyframes.slice(0, 2).map((keyframe) => ({ ...keyframe, id: `${keyframe.id}-b` })),
    };
    const html = renderMarkup(
      <svg>
        <CameraPathLayer projection={projection} paths={[tracking, second]} onSelectKeyframe={() => {}} />
      </svg>,
    );
    expect(html.match(/tabindex="0"/gu)).toHaveLength(1);
    expect(html.match(/role="option"/gu)).toHaveLength(5);
  });

  it('does not draw an end square for a single-keyframe shot', () => {
    const single: CameraPath = { shotId: 'shot-04', shotLabel: '静止', keyframes: [tracking.keyframes[0]!] };
    const html = renderMarkup(
      <svg>
        <CameraPathLayer projection={projection} paths={[single]} />
      </svg>,
    );
    expect(html).toContain('data-role="camera-start"');
    expect(html).not.toContain('data-role="camera-end"');
    expect(html).not.toContain('data-role="camera-track"');
  });

  it('renders the empty path as a labelled note', () => {
    const html = renderMarkup(
      <svg>
        <CameraPathLayer projection={projection} paths={[{ shotId: 's', shotLabel: 's', keyframes: [] }]} />
      </svg>,
    );
    expect(html).toContain('data-layer-state="empty"');
    expect(html).toContain('没有关键点');
  });

  it('renders nothing when the page has the layer switched off', () => {
    const html = renderMarkup(
      <svg>
        <CameraPathLayer projection={projection} paths={[tracking]} visible={false} />
      </svg>,
    );
    expect(html).toBe('<svg></svg>');
  });
});
