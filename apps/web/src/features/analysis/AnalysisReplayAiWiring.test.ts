import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Replay AI context wiring', () => {
  it('publishes only the explicitly focused exact frame tick into URL-owned context', () => {
    const source = readFileSync(new URL('./AnalysisPage.tsx', import.meta.url), 'utf8');

    expect(source).toContain('data-action="focus-replay-frame-for-ai"');
    expect(source).toContain('onFocusFrame={(tick) => navigateAnalysis({ tick })}');
    expect(source).toContain('onFocusFrame(currentFrame.tick)');
  });
});
