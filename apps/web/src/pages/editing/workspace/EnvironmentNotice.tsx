/** Show missing recording or export dependencies only when they block work. */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button } from '../../../design/primitives';
import { useQuickCheck } from '../../../data/config';
import { dependencyLabel } from '../../../domain/environment/dependencyLabel';
import type {
  DependencyCheck,
  DependencyKind,
  DependencyState,
} from '../../../shared/desktop/dto';
import { settingsPath } from '../../shared/settings/settingsRoutes';

/** The dependency state that blocks its associated capability. */
const BLOCKING_STATE: DependencyState = 'missing';

export function EnvironmentNotice() {
  const checks = useQuickCheck();
  const navigate = useNavigate();
  const blocking = (checks.data?.checks ?? []).filter(
    (check) => check.state === BLOCKING_STATE,
  );

  // Loading and ready states do not interrupt the workbench.
  if (blocking.length === 0) return null;

  return (
    <div
      data-home-block="environment"
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-warn-border bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text"
    >
      <AlertCircle className="size-4 flex-none" strokeWidth={1.75} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="font-medium"><Trans>部分功能需要配置</Trans></span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {blocking.map((check, index) => (
            <span
              key={`${check.kind}:${dependencyLabel(check.kind)}`}
              data-blocking-check={check.kind}
              className="inline-flex items-center gap-2"
            >
              {index === 0 ? null : <span aria-hidden="true">·</span>}
              {blockingSentence(check)}
            </span>
          ))}
        </span>
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="ml-auto flex-none"
        onClick={() => void navigate(settingsPath('game'))}
      >
        <Trans>去设置</Trans>
      </Button>
    </div>
  );
}

/** Name the affected capability; detailed diagnostics belong in settings. */
function blockingSentence(check: DependencyCheck): string {
  const consequence = consequenceOf(check.kind);
  return `${dependencyLabel(check.kind)}：${consequence}`;
}

/** Translate at render time so changing locale updates the dependency notice. */
function consequenceOf(kind: DependencyKind): string {
  switch (kind) {
    case 'game':
      return t`回放与录制不可用`;
    case 'hlae':
      return t`录制不可用，分析与编辑不受影响`;
    case 'encoder':
      return t`导出不可用`;
  }
}
