import { t } from '@lingui/core/macro';
import type { DependencyKind } from '../../shared/desktop/dto';

export function dependencyLabel(kind: DependencyKind): string {
  switch (kind) {
    case 'game': return 'CS2';
    case 'hlae': return t`录制组件`;
    case 'encoder': return t`视频编码器`;
  }
}
