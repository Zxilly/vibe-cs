import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./ReviewMetadataPanel.tsx', import.meta.url), 'utf8');

describe('ReviewMetadataPanel request ownership', () => {
  it('loads catalog and exact metadata in parallel and suppresses stale completion', () => {
    expect(source).toMatch(/Promise\.all\(\[\s*commands\.listReviewTags\(controller\.signal\),\s*loadMetadata\(controller\.signal\)/);
    expect(source).toMatch(/controller\.signal\.aborted \|\| revision\.current !== currentRevision/);
    expect(source).toMatch(/controller\.abort\(\);[\s\S]*?saveController\.current\?\.abort\(\);[\s\S]*?revision\.current \+= 1/);
  });

  it('binds mutations to the same generation and never applies an aborted result', () => {
    expect(source).toMatch(/updateMetadata\(\{ comment, tag_ids: \[\.\.\.selectedTagIds\] \}, controller\.signal\)/);
    expect(source).toMatch(/if \(controller\.signal\.aborted \|\| revision\.current !== currentRevision\) return/);
  });
});
