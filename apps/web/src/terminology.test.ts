import { i18n } from '@lingui/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { LEGACY_UI_TERMS, UI_TERMINOLOGY } from './terminology';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'zh-CN', messages: {} });
});

describe('IA product terminology', () => {
  it('keeps the PRD mapping in one exhaustive table', () => {
    expect(
      Object.fromEntries(
        Object.entries(UI_TERMINOLOGY).map(([id, entry]) => [
          id,
          { legacy: entry.legacy, current: i18n._(entry.current) },
        ]),
      ),
    ).toEqual({
      shotList: { legacy: ['方案'], current: '剪辑单' },
      modification: { legacy: ['变更'], current: '修改' },
      conversation: { legacy: ['会话'], current: '对话' },
      clip: { legacy: ['镜头'], current: '片段' },
      project: { legacy: ['合辑', '工程'], current: '作品' },
      outputFile: { legacy: ['输出'], current: '成品文件' },
      backgroundTask: { legacy: ['任务记录'], current: '后台任务' },
    });
  });

  it('assigns every legacy noun exactly once', () => {
    expect(new Set(LEGACY_UI_TERMS).size).toBe(LEGACY_UI_TERMS.length);
  });
});
