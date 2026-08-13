import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(
  new URL('./TeamEconomyAnalysisWorkspace.css', import.meta.url),
  'utf8',
);

describe('TeamEconomyAnalysisWorkspace compact layout', () => {
  it('scrolls the complete vertical story without overlapping its matrix, evidence, or inspector', () => {
    const compact = styles.match(
      /@media \(max-width: 1180px\) and \(max-height: 760px\)\s*{([\s\S]*)}\s*$/,
    )?.[1] ?? '';

    expect(compact).toMatch(
      /\.team-economy-workspace\s*{[^}]*grid-template-rows:\s*auto max-content;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s,
    );
    expect(compact).toMatch(
      /\.team-economy-canvas\s*{[^}]*min-height:\s*680px;[^}]*grid-template-rows:\s*200px 286px 194px;[^}]*overflow:\s*hidden;/s,
    );
  });
});
