/*
 * Product terminology — the one UI-facing mapping for the IA restructure.
 *
 * These names are presentation copy only. Wire fields, query keys, route ids,
 * persistence keys, and test fixture identifiers deliberately keep their
 * existing English names. Contextual sentences may inflect the current terms,
 * but they must not introduce another noun for the same product object.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export type UiTermId =
  | 'shotList'
  | 'modification'
  | 'conversation'
  | 'clip'
  | 'project'
  | 'outputFile'
  | 'backgroundTask';

export interface UiTerminologyEntry {
  readonly legacy: readonly string[];
  readonly current: MessageDescriptor;
}

export const UI_TERMINOLOGY: Readonly<Record<UiTermId, UiTerminologyEntry>> = {
  shotList: { legacy: ['方案'], current: msg`剪辑单` },
  modification: { legacy: ['变更'], current: msg`修改` },
  conversation: { legacy: ['会话'], current: msg`对话` },
  clip: { legacy: ['镜头'], current: msg`片段` },
  project: { legacy: ['合辑', '工程'], current: msg`作品` },
  outputFile: { legacy: ['输出'], current: msg`成品文件` },
  backgroundTask: { legacy: ['任务记录'], current: msg`后台任务` },
};

/** The old nouns forbidden in shell and page chrome after IA-01. */
export const LEGACY_UI_TERMS: readonly string[] = Object.values(UI_TERMINOLOGY).flatMap(
  (entry) => entry.legacy,
);
