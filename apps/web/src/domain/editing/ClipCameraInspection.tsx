import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

import { dataErrorMessage } from '../../data/errors';
import { useProjectCameraPreview } from '../../data/projects';
import { Button } from '../../design/primitives';
import type { CameraIssueInterval, HlaeCameraStyle } from '../../shared/desktop/dto';
import { CameraPreviewViewport } from '../scene3d/CameraPreviewViewport';

export function ClipCameraInspection({ projectId, clipId, revision, sourceTimeSeconds, onSourceTimeChange, sourceRange }: {
  readonly projectId: string;
  readonly clipId: string;
  readonly revision: number;
  readonly sourceTimeSeconds: number;
  readonly onSourceTimeChange: (seconds: number) => void;
  readonly sourceRange?: { readonly start: number; readonly end: number };
}) {
  const query = useProjectCameraPreview(projectId, clipId, revision);
  const inspection = query.data?.inspection;
  return (
    <section className="mt-3 border-t border-divider pt-3 text-xs leading-5" aria-label={t`镜头检查`} aria-busy={query.isFetching}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold"><Trans>镜头检查</Trans></h3>
        <Button size="sm" variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>
          <Trans>重新检查</Trans>
        </Button>
      </div>
      {!query.isError && query.data !== undefined && (
        <CameraPreviewViewport preview={query.data.preview} sourceTimeSeconds={sourceTimeSeconds} sourceRange={sourceRange}
          onSourceTimeChange={onSourceTimeChange} className="mt-2 h-80 rounded border border-divider" />
      )}
      {query.isFetching && <p role="status" className="mt-1 text-neutral-600"><Trans>正在准备镜头预演…</Trans></p>}
      {query.isError ? (
        <p role="alert" className="mt-2 text-fail-text">{dataErrorMessage(query.error) ?? t`镜头检查失败，请重试。`}</p>
      ) : inspection == null ? null : inspection.geometryUnavailable !== null ? (
        <div className="mt-2 text-warn-text">
          <p><Trans>未能检查地图遮挡。可在设置中准备地图后重试。</Trans></p>
          <details className="mt-1">
            <summary className="cursor-pointer"><Trans>查看原因</Trans></summary>
            <p className="mt-1 break-words">{inspection.geometryUnavailable}</p>
          </details>
        </div>
      ) : (
        <>
          {inspection.adjusted && (
            <p className="mt-2 text-accent-700">
              {inspection.requestedStyle === inspection.effectiveStyle
                ? t`已自动调整机位，录制会使用调整后的路径。`
                : t`为改善画面，录制将改用${cameraStyleLabel(inspection.effectiveStyle)}机位。`}
            </p>
          )}
          {inspection.issues.length === 0 ? (
            <p className="mt-2 text-neutral-700"><Trans>当前采样未发现镜头问题。</Trans></p>
          ) : (
            <>
              <p className="mt-2 text-warn-text"><Trans>仍有镜头问题，可调整录制视角或范围后重新检查。</Trans></p>
              <IssueList issues={inspection.issues.slice(0, 4)} />
              {inspection.issues.length > 4 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-neutral-600"><Trans>其余 {inspection.issues.length - 4} 段问题</Trans></summary>
                  <IssueList issues={inspection.issues.slice(4)} />
                </details>
              )}
              <p className="mt-1 text-neutral-500"><Trans>时间相对录制开始。</Trans></p>
            </>
          )}
          <p className="mt-2 text-neutral-500"><Trans>静态地图检查不包含烟雾，仅作提示，不阻止录制。</Trans></p>
        </>
      )}
    </section>
  );
}

function IssueList({ issues }: { readonly issues: readonly CameraIssueInterval[] }) {
  return (
    <ul className="mt-2 space-y-2">
      {issues.map((issue) => (
        <li key={`${issue.kind}:${issue.startSeconds}`}>
          <span className="block tabular-nums text-neutral-600">{t`${issue.startSeconds.toFixed(2)}–${issue.endSeconds.toFixed(2)} 秒`}</span>
          <span className="text-warn-text">{issueLabel(issue)}</span>
        </li>
      ))}
    </ul>
  );
}

function issueLabel(issue: CameraIssueInterval): string {
  switch (issue.kind) {
    case 'near_wall': return t`机位距离墙面不足 16 单位`;
    case 'surface_crossing': return t`机位路径穿过地图表面`;
    case 'target_occluded': return t`${Math.round(issue.affectedFraction * 100)}% 的头胸视线被遮挡`;
    case 'target_out_of_view': return t`目标不在画面内`;
    case 'target_unobserved': return t`缺少目标位置，无法检查`;
  }
}

function cameraStyleLabel(style: HlaeCameraStyle): string {
  switch (style) {
    case 'pov': return t`第一人称`;
    case 'static': return t`固定`;
    case 'tracking': return t`跟随`;
    case 'dolly': return t`推轨`;
    case 'orbit': return t`环绕`;
    case 'crane': return t`升降`;
    case 'flyby': return t`掠过`;
  }
}
