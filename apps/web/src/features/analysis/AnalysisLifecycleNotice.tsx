import { Link } from 'react-router-dom';

import type { DemoLifecycleStatus } from '../../shared/desktop/dto';
import { msg } from '../../shared/i18n';
import { useI18n } from '../../shared/i18n';
import { Notice, Spinner } from '../../shared/ui';
import { demoLifecyclePresentation } from '../library/libraryPresentation';
import type { AnalysisLifecycleViewState } from './analysisLifecycleMachine';

export function analysisCancelledActivityHref(runId: string): string {
  return `/activity?${new URLSearchParams({ activity: `analysis:${runId}` }).toString()}`;
}

export function AnalysisLifecycleNotice({
  state,
  lifecycle,
  message,
  runId,
}: {
  state: AnalysisLifecycleViewState;
  lifecycle: DemoLifecycleStatus | null;
  message: string | null;
  runId: string | null;
}) {
  const { t } = useI18n();
  if (state === 'ready') return null;
  if (state === 'cancelled') {
    return (
      <Notice tone="warning" title={t('analysis.lifecycle.cancelledTitle')}>
        <span data-analysis-outcome="cancelled">
          {t('analysis.lifecycle.cancelledDescription')}
        </span>
        {runId ? (
          <Link className="button button--secondary button--sm analysis-lifecycle__activity" to={analysisCancelledActivityHref(runId)}>
            {t('analysis.lifecycle.openActivity')}
          </Link>
        ) : null}
      </Notice>
    );
  }
  const loading = state === 'loading' || state === 'observing';
  const presentation = state === 'loading' && lifecycle
    ? demoLifecyclePresentation(lifecycle)
    : null;
  return (
    <Notice
      tone={loading ? 'info' : 'danger'}
      title={loading && presentation ? t(presentation.labelKey) : loading ? msg("m0865") : msg("m0262")}
    >
      {loading
        ? <><Spinner />{presentation ? t(presentation.descriptionKey) : msg("m0874")}</>
        : message ?? msg("m0795")}
    </Notice>
  );
}
