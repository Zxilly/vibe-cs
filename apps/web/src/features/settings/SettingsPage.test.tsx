import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { defaultConfig, RecordingSettings, SettingsPage, VideoSettings } from './SettingsPage';

describe('current settings contract', () => {
  it('exposes only the current local data directory', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    expect(markup).not.toContain('VIBE_CS_PREVIOUS_DATA_DIR');
  });
});

describe('video generation settings', () => {
  it('presents the output without exposing implementation tools', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <VideoSettings />
      </MemoryRouter>,
    );

    expect(markup).toContain('视频生成');
    expect(markup).toContain('MP4');
    expect(markup).not.toContain('HLAE');
    expect(markup).not.toContain('Media Foundation');
    expect(markup).not.toContain('OBS');
    expect(markup).not.toContain('WebSocket');
    expect(markup).not.toMatch(/ffmpeg|ffprobe|libx264/i);
    expect(markup).not.toContain('选择 HLAE.exe');
    expect(markup).not.toContain('Choose HLAE.exe');
  });
});

describe('recording settings', () => {
  it('shows user-facing video controls without the capture pipeline', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <RecordingSettings config={defaultConfig} updateRecording={() => undefined} />
      </MemoryRouter>,
    );

    expect(markup).toContain('画面质量');
    expect(markup).toContain('FOV');
    expect(markup).not.toContain('HLAE');
    expect(markup).not.toContain('Media Foundation');
    expect(markup).not.toContain('恢复');
    expect(markup).not.toContain('按键可视化');
    expect(markup).not.toContain('投掷物轨迹');
    expect(markup).not.toContain('实时素材');
    expect(markup).not.toContain('画面延迟');
    expect(markup).not.toContain('转场');
  });
});
