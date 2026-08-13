import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const analysisSource = readFileSync(new URL('./AnalysisPage.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
const coordinatePlaneContract = styles.split('/* A missing radar is a relative-coordinate plane, never inferred map geometry. */')[1]
  ?.split('/* Recording queue */')[0] ?? '';

describe('truthful heatmap fallback', () => {
  it('labels the fallback coordinate space and keys markers by canonical evidence id', () => {
    expect(analysisSource).toContain("data-coordinate-space={radarTransform ? 'map-overview' : 'whole-artifact-relative'}");
    expect(analysisSource).toContain('key={point.id}');
    expect(analysisSource).toContain('data-evidence-id={point.id}');
    expect(analysisSource).toContain('tabIndex={selectedPointId === point.id');
    expect(analysisSource).toContain("event.key === 'ArrowRight'");
  });

  it('uses only a neutral coordinate grid when radar geometry is unavailable', () => {
    expect(coordinatePlaneContract).toMatch(/\.heatmap-map\.is-coordinate-plane\s*{[^}]*background-image:/s);
    expect(coordinatePlaneContract).toMatch(/\.heatmap-map\.is-coordinate-plane::before\s*{[^}]*display:\s*none;/s);
    expect(coordinatePlaneContract).not.toMatch(/clip-path|replay-map__site|replay-map__paths/);
  });

  it('bounds the compact heatmap workspace and keeps its inspector scrollable', () => {
    expect(styles).toMatch(/@media \(max-width: 1180px\) and \(max-height: 760px\)[\s\S]*\.page--analysis \.heatmap-layout[^{]*\{[^}]*height:\s*100%;/);
    expect(styles).toMatch(/\.page--analysis \.heatmap-insights\s*\{[^}]*overflow:\s*hidden auto;/);
  });
});
