/*
 * pages/editor — what the editor says when it refuses or restricts something.
 *
 * Two vocabularies, deliberately kept apart from the one in
 * `design/timeline/TimelinePrototype.tsx`:
 *
 *   `refusalMessage`     an `EditRefusal` the pure modules produced —
 *                        「这里已经有片段了」 and the rest.
 *   `restrictionMessage` a `ClipRestriction` the *adapter* produced — a
 *                        limitation of what this editor can express about a
 *                        wire clip, not a refusal of an edit.
 *
 * The prototype has its own copy of the first. That is not duplication to be
 * tidied away: `design/**` is a layer that must not import from `pages/**`,
 * and phase 5 pushes it into a separate design-system project where these
 * strings would have no page to belong to. The prototype's copy describes the
 * prototype; this one describes the product, and the two are free to diverge —
 * this file says 「不能再修剪了」 with the frame rate in it, which a prototype
 * with no project has nothing to fill in.
 */

import { t } from '@lingui/core/macro';

import type { EditRefusal } from '../../design/timeline';
import type { ClipRestriction } from './editorDocument';

export function refusalMessage(reason: EditRefusal): string {
  switch (reason) {
    case 'overlap':
      return t`这里已经有片段了，没有移动`;
    case 'track-kind-mismatch':
      return t`轨道类型不同，放不进去`;
    case 'track-locked':
      return t`轨道已锁定，先解锁再编辑`;
    case 'out-of-bounds':
      return t`这个位置没有可以操作的片段`;
    case 'no-headroom':
      return t`素材已经到头了，没有可用的余量`;
    case 'too-short':
      return t`再修剪就不足一帧了`;
    case 'speed-out-of-range':
      return t`速度只能在 5% 到 1600% 之间`;
    case 'unknown-clip':
    case 'unknown-track':
      return t`片段不在时间轴上`;
    case 'no-change':
      return t`没有变化`;
  }
}

/**
 * Why a control is disabled for this clip.
 *
 * Each of these is a *true* statement about the document, not a euphemism. A
 * ramped clip really cannot be trimmed by this editor without corrupting its
 * ramp, and saying 「暂不支持」 would leave the user looking for the setting
 * that turns it on.
 */
function restrictionMessage(restriction: ClipRestriction): string {
  switch (restriction.reason) {
    case 'speed-ramp':
      return t`这个片段用的是分段变速，改动会打乱速度曲线，先在属性里去掉分段`;
    case 'unmeasured-source':
      return t`还没读到这个素材的时长，不知道可以滑移多少`;
    case 'locked-track':
      return t`轨道已锁定`;
  }
}

/** The first reason, for a control that can only show one. */
export function firstRestrictionMessage(restrictions: readonly ClipRestriction[]): string | undefined {
  const first = restrictions[0];
  return first === undefined ? undefined : restrictionMessage(first);
}
