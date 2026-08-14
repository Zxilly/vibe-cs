import { describe, expect, it } from 'vitest';

import {
  parsePlayerReviewMetadata,
  parseReviewTagCatalog,
  parseRoundReviewMetadata,
} from './reviewMetadataContract';

const tag = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Retake',
  color: '#2563eb',
  created_at: '2026-08-14T12:00:00Z',
  updated_at: '2026-08-14T12:00:00Z',
};

describe('review metadata contract', () => {
  it('parses one shared tag catalog and exact Player metadata', () => {
    expect(parseReviewTagCatalog([tag])).toEqual([tag]);
    expect(parsePlayerReviewMetadata({
      steam_id: '76561197960690195',
      comment: 'Review utility timing',
      tags: [tag],
      updated_at: '2026-08-14T12:01:00Z',
    }, '76561197960690195')).toMatchObject({
      steam_id: '76561197960690195',
      tags: [tag],
    });
  });

  it('binds Round metadata to the requested Demo, round, and lowercase source hash', () => {
    expect(parseRoundReviewMetadata({
      demo_id: '22222222-2222-4222-8222-222222222222',
      source_sha256: 'a'.repeat(64),
      round: 13,
      comment: 'Late utility',
      tags: [tag],
      updated_at: '2026-08-14T12:01:00Z',
    }, '22222222-2222-4222-8222-222222222222', 13)).toMatchObject({
      source_sha256: 'a'.repeat(64),
      round: 13,
    });
  });

  it('fails closed on identity, duplicate-tag, and extra-field poison', () => {
    const player = {
      steam_id: '76561197960690195',
      comment: '',
      tags: [tag],
      updated_at: '2026-08-14T12:01:00Z',
    };
    expect(() => parsePlayerReviewMetadata({ ...player, steam_id: '76561197960690196' }, player.steam_id)).toThrow();
    expect(() => parsePlayerReviewMetadata({ ...player, tags: [tag, tag] }, player.steam_id)).toThrow();
    expect(() => parsePlayerReviewMetadata({ ...player, extra: true }, player.steam_id)).toThrow();

    const round = {
      demo_id: '22222222-2222-4222-8222-222222222222',
      source_sha256: 'a'.repeat(64),
      round: 13,
      comment: '',
      tags: [],
      updated_at: '2026-08-14T12:01:00Z',
    };
    expect(() => parseRoundReviewMetadata({ ...round, source_sha256: 'A'.repeat(64) }, round.demo_id, 13)).toThrow();
    expect(() => parseRoundReviewMetadata({ ...round, round: 14 }, round.demo_id, 13)).toThrow();
    expect(() => parseRoundReviewMetadata({ ...round, updated_at: '2026-02-30T00:00:00Z' }, round.demo_id, 13)).toThrow();
  });
});
