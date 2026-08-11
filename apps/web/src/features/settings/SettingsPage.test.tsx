import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ObsDiagnosis } from '../../shared/api/dto';
import { ObsDiagnosisDetails } from './SettingsPage';

const diagnosis: ObsDiagnosis = {
  recording: { active: true, paused: false, timecode: '00:00:12.000', output_path: 'D:\\Capture\\clip.mkv' },
  scenes: { current_program_scene: 'Desktop', scenes: ['Desktop', 'Capture'] },
  video: {
    base_width: 2560,
    base_height: 1440,
    output_width: 1920,
    output_height: 1080,
    fps_numerator: 60_000,
    fps_denominator: 1_001,
  },
  configured_scene: 'Capture',
  scene_ready: true,
  resolution_matches: true,
  fps_matches: false,
  ready: false,
  warnings: ['OBS frame rate does not match the saved recording default'],
  dependencies: { ready: true, dependencies: [] },
};

describe('OBS diagnosis UI', () => {
  it('renders live status, every scene, and explicit mismatches', () => {
    const onSelectScene = vi.fn();
    const markup = renderToStaticMarkup(
      <ObsDiagnosisDetails
        diagnosis={diagnosis}
        selectedScene="Capture"
        expectedResolution="1920x1080"
        expectedFps={60}
        onSelectScene={onSelectScene}
      />,
    );

    expect(markup).toContain('WebSocket 已连接');
    expect(markup).toContain('正在录制');
    expect(markup).toContain('59.94 FPS');
    expect(markup).toContain('期望 60 FPS');
    expect(markup).toContain('Desktop（当前）');
    expect(markup).toContain('Capture');
    expect(markup).toContain('OBS frame rate does not match');
    expect(onSelectScene).not.toHaveBeenCalled();
  });

  it('keeps an unsaved missing scene visible instead of silently replacing it', () => {
    const markup = renderToStaticMarkup(
      <ObsDiagnosisDetails
        diagnosis={diagnosis}
        selectedScene="Missing scene"
        expectedResolution="1920x1080"
        expectedFps={60}
        onSelectScene={() => undefined}
      />,
    );

    expect(markup).toContain('Missing scene（实时列表中不存在）');
  });
});
