/** Show missing recording or export dependencies only when they block work. */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useNavigate } from 'react-router-dom';

import { Alert } from '../../../design/feedback';
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
    <div data-home-block="environment">
      <Alert
        variant="warning"
        action={{
          label: <Trans>去设置</Trans>,
          onAction: () => void navigate(settingsPath('game')),
        }}
        detail={
          <ul className="flex flex-col gap-1">
            {blocking.map((check) => (
              <li key={`${check.kind}:${dependencyLabel(check.kind)}`} data-blocking-check={check.kind}>
                {blockingSentence(check)}
              </li>
            ))}
          </ul>
        }
      >
        <Trans>部分功能需要配置</Trans>
      </Alert>
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
