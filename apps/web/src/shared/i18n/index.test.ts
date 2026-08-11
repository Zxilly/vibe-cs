import { describe, expect, it } from 'vitest';

import { translate } from './index';

describe('typed translations', () => {
  it('resolves both supported locales from the same typed key set', () => {
    expect(translate('zh-CN', 'settings.save')).toBe('保存设置');
    expect(translate('en-US', 'settings.save')).toBe('Save settings');
  });
});
