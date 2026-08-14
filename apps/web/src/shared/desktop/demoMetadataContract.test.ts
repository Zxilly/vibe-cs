import { describe, expect, it } from 'vitest';

import { parseDemoMetadata, parseDemoMetadataBatch, parseDemoTagCatalog } from './demoMetadataContract';

const tag = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Major',
  color: '#dc2626',
  created_at: '2026-08-14T01:00:00Z',
  updated_at: '2026-08-14T01:00:00Z',
};

describe('demo metadata wire contract', () => {
  it('accepts only the exact provider, comment, and catalog-tag shape', () => {
    expect(parseDemoMetadata({
      demo_id: '22222222-2222-4222-8222-222222222222',
      match_source: 'faceit',
      comment: 'Review R12',
      tags: [tag],
      updated_at: '2026-08-14T01:01:00Z',
    }, '22222222-2222-4222-8222-222222222222').tags).toEqual([tag]);

    expect(() => parseDemoMetadata({
      demo_id: '22222222-2222-4222-8222-222222222222',
      match_source: 'local',
      comment: '',
      tags: [],
      updated_at: '2026-08-14T01:01:00Z',
    }, '22222222-2222-4222-8222-222222222222')).toThrow();
    expect(() => parseDemoMetadata({
      demo_id: '22222222-2222-4222-8222-222222222222',
      match_source: null,
      comment: '',
      tags: [],
      updated_at: '2026-08-14T01:01:00Z',
      unexpected: true,
    }, '22222222-2222-4222-8222-222222222222')).toThrow();
  });

  it('rejects duplicate IDs, invalid colors, and oversized catalog responses', () => {
    expect(parseDemoTagCatalog([tag])).toEqual([tag]);
    expect(() => parseDemoTagCatalog([tag, tag])).toThrow();
    expect(() => parseDemoTagCatalog([{ ...tag, color: 'red' }])).toThrow();
    expect(() => parseDemoTagCatalog(Array.from({ length: 257 }, (_, index) => ({
      ...tag,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    })))).toThrow();
  });

  it('binds a batch response to every requested Demo in exact order', () => {
    const first = '22222222-2222-4222-8222-222222222222';
    const second = '33333333-3333-4333-8333-333333333333';
    const item = (demo_id: string) => ({
      demo_id,
      match_source: null,
      comment: '',
      tags: [],
      updated_at: '2026-08-14T01:01:00Z',
    });
    expect(parseDemoMetadataBatch([item(first), item(second)], [first, second])).toHaveLength(2);
    expect(() => parseDemoMetadataBatch([item(second), item(first)], [first, second])).toThrow();
    expect(() => parseDemoMetadataBatch([item(first)], [first, second])).toThrow();
  });
});
