/*
 * pages/home — the three steps, in one place because two pages draw them.
 *
 * 「02 补齐 · 暗色与其余页面」 asked for the guide to become 「首次使用时的三步
 * 提示条」; `/guide` also lists them, as the standing version of the same
 * thing. One definition, so the strip and the page cannot come to describe
 * different products.
 *
 * ## Why the labels are functions
 *
 * `t` bakes the active locale in at call time. A module-scope array of strings
 * would freeze whichever locale happened to be active when this module was
 * first imported — which, for a module imported by the shell, is before the
 * user's stored locale has been applied.
 */

import { t } from '@lingui/core/macro';

export interface FirstRunStep {
  readonly id: 'import' | 'analyse' | 'create';
  readonly to: string;
  readonly title: () => string;
  readonly description: () => string;
}

/**
 * The three, in order. They are the product's actual pipeline rather than a
 * tour of the navigation: import a Demo, analyse it, ask the Agent for a cut.
 * Recording and editing are downstream of the third and are not separate steps
 * — a first-time user does not choose between 快速合辑 and 多轨编辑器, they ask
 * for a video.
 */
export const FIRST_RUN_STEPS: readonly FirstRunStep[] = [
  {
    id: 'import',
    to: '/library',
    title: () => t`导入 Demo`,
    description: () => t`把 .dem 文件加进资料库，或者设一个监听目录让它们自己进来。`,
  },
  {
    id: 'analyse',
    to: '/library',
    title: () => t`分析一场比赛`,
    description: () => t`解析出回合、击杀与移动轨迹，之后的所有选材都基于它。`,
  },
  {
    id: 'create',
    to: '/projects/new?step=shotlist',
    title: () => t`让 Agent 做一条视频`,
    description: () => t`说清你想要什么，Agent 会准备剪辑单和片段；开始录制前还会等你确认。`,
  },
];
