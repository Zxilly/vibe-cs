import { describe, expect, it } from 'vitest';

import { activityHref, parseActivityLocator, withActivitySelection } from './activitySelection';

describe('activity durable selection', () => {
  it('round-trips one exact current activity locator through the URL', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(parseActivityLocator(`analysis:${id}`)).toEqual({
      id: `analysis:${id}`,
      kind: 'analysis',
      jobId: id,
    });
    expect(activityHref(`analysis:${id}`)).toBe(
      `/activity?activity=analysis%3A${id}`,
    );
  });

  it('rejects old demo-based and non-canonical activity locators', () => {
    expect(parseActivityLocator('analysis:demo-1')).toBeNull();
    expect(parseActivityLocator('analyses:11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(parseActivityLocator('analysis:11111111-1111-4111-8111-111111111111:extra')).toBeNull();
    expect(parseActivityLocator(null)).toBeNull();
  });

  it('replaces only the exact selection while preserving unrelated route state', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(withActivitySelection(new URLSearchParams('tab=events&activity=recording%3Aold'), `export:${id}`).toString())
      .toBe(`tab=events&activity=export%3A${id}`);
  });
});
