import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AnalysisPage.tsx', import.meta.url), 'utf8');

describe('Round Comment / Tags wiring', () => {
  it('binds the shared editor to the exact current Demo and selected round', () => {
    expect(source).toMatch(/commands\.getRoundReviewMetadata\(demoId, round\.number, signal\)/);
    expect(source).toMatch(/commands\.updateRoundReviewMetadata\(demoId, round\.number, update, signal\)/);
    expect(source).toContain('identity={`round:${demoId}:${round.number}`}');
    expect(source).toContain("title={t('reviewMetadata.roundTitle')}");
    expect(source).not.toContain('RoundEvidenceAnnotation');
  });
});
