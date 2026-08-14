import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');

describe('player heatmap responsive contract', () => {
  it('uses a bounded radar canvas and a separate exact-evidence inspector', () => {
    expect(css).toMatch(/\.page--players \.players-workspace:has\(\.player-heatmap-workspace\)\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.15fr\)\s+minmax\(520px,\s*\.95fr\)/s);
    expect(css).toMatch(/\.player-heatmap-workspace__body\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)\s+minmax\(150px,\.42fr\)[^}]*align-items:\s*start/s);
    expect(css).toMatch(/\.player-heatmap-map\s*\{[^}]*position:\s*relative[^}]*aspect-ratio:\s*1[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.player-heatmap-evidence\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*auto/s);
  });

  it('distinguishes kill and death points without relying on color alone', () => {
    expect(css).toMatch(/\.player-heatmap-map \[data-heat-kind="kills"\]\s*\{[^}]*border-radius:\s*50%/s);
    expect(css).toMatch(/\.player-heatmap-map \[data-heat-kind="deaths"\]\s*\{[^}]*transform:[^}]*rotate\(45deg\)/s);
  });

  it('stacks the canvas and evidence panel inside the narrow Drawer', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*650px\)[\s\S]*?\.player-heatmap-workspace__body\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*650px\)[\s\S]*?\.player-heatmap-map\s*\{[^}]*max-height:\s*430px/s);
  });
});
