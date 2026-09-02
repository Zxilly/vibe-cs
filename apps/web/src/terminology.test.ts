import { i18n } from '@lingui/core';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

import { LEGACY_UI_TERMS, UI_TERMINOLOGY } from './terminology';

const SOURCE_CATALOG = readFileSync(
  new URL('./locales/zh-CN/messages.po', import.meta.url),
  'utf8',
);

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

  it('keeps legacy product nouns and implementation jargon out of UI copy', () => {
    const forbidden = [
      '方案',
      '变更',
      '会话',
      '合辑',
      '工程',
      '任务记录',
      '人类',
      'Project Head',
      'Project revision',
      'Delivery Gate',
      'Provider 默认',
      'JSON object',
      'Change Group',
      '原子替换',
      '结构化工具',
    ];

    for (const phrase of forbidden) {
      expect(SOURCE_CATALOG, `UI catalog contains forbidden copy: ${phrase}`).not.toContain(phrase);
    }
  });

  it('avoids the formulaic writing patterns covered by the UI copy guide', () => {
    expect(SOURCE_CATALOG).not.toMatch(
      /此外|至关重要|彰显|不断演变的格局|深入探讨|奠定基础|值得注意的是|希望这对|您说得完全正确/u,
    );
    expect(SOURCE_CATALOG).not.toMatch(/不仅.{0,30}(?:而且|还|更)|不只是|不仅仅是/u);
  });
});
