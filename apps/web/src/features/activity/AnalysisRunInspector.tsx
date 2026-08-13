import { useMemo } from 'react';

import type { AnalysisRunDetail, AnalysisRunEventCode, AnalysisRunStage } from '../../shared/desktop/dto';
import { type MessageKey, useI18n } from '../../shared/i18n';
import { Notice, Spinner } from '../../shared/ui';

const stageKeys: Record<AnalysisRunStage, MessageKey> = {
  validating_input: 'activity.analysisStage.validatingInput',
  parser_queued: 'activity.analysisStage.parserQueued',
  parser_running: 'activity.analysisStage.parserRunning',
  verifying_input_after_parse: 'activity.analysisStage.verifyingInput',
  projecting: 'activity.analysisStage.projecting',
  completed: 'activity.analysisStage.completed',
  failed: 'activity.analysisStage.failed',
  interrupted: 'activity.analysisStage.interrupted',
};

const eventKeys: Record<AnalysisRunEventCode, MessageKey> = {
  input_validation_started: 'activity.analysisEvent.inputValidationStarted',
  input_verified: 'activity.analysisEvent.inputVerified',
  parser_started: 'activity.analysisEvent.parserStarted',
  input_revalidation_started: 'activity.analysisEvent.inputRevalidationStarted',
  projection_started: 'activity.analysisEvent.projectionStarted',
  completed: 'activity.analysisEvent.completed',
  failed: 'activity.analysisEvent.failed',
  interrupted: 'activity.analysisEvent.interrupted',
};

export function analysisStageKey(stage: string): MessageKey | null {
  return stageKeys[stage as AnalysisRunStage] ?? null;
}

export function AnalysisRunInspector({
  detail,
  loading,
  error,
}: {
  detail: AnalysisRunDetail | null;
  loading: boolean;
  error: string | null;
}) {
  const { locale, t } = useI18n();
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }), [locale]);
  if (loading && !detail) return <div className="analysis-run-detail"><Spinner label={t('activity.analysisRunLoading')} /></div>;
  if (error) return <Notice tone="warning" title={t('activity.analysisRunEvidence')}>{error}</Notice>;
  if (!detail) return <Notice tone="warning">{t('activity.analysisRunUnavailable')}</Notice>;
  const { run } = detail;
  return (
    <section className="analysis-run-detail" data-analysis-run-id={run.id} aria-label={t('activity.analysisRunEvidence')}>
      <dl className="activity-inspector__facts">
        <div><dt>{t('activity.analysisRunStage')}</dt><dd>{t(stageKeys[run.stage])}</dd></div>
        <div><dt>{t('activity.analysisRunResult')}</dt><dd>{detail.result_available ? t('activity.analysisRunResultReady') : t('activity.analysisRunResultPending')}</dd></div>
        <div><dt>SHA-256</dt><dd title={run.input_sha256 ?? undefined}>{run.input_sha256 ?? t('activity.analysisRunFingerprintPending')}</dd></div>
        <div><dt>{t('activity.analysisRunInputSize')}</dt><dd>{run.input_size === null ? '—' : `${run.input_size.toLocaleString()} B`}</dd></div>
      </dl>
      {run.error ? <Notice tone="danger" title={t('activity.error')}>{run.error}</Notice> : null}
      <div className="analysis-run-events">
        <h3>{t('activity.analysisRunEvents')}</h3>
        {detail.events.length === 0 ? <p>{t('activity.analysisRunNoEvents')}</p> : (
          <ol>
            {detail.events.map((event) => (
              <li key={event.sequence} data-event-sequence={event.sequence}>
                <span>{event.sequence + 1}</span>
                <div>
                  <strong>{t(eventKeys[event.message_code])}</strong>
                  <small>{t(stageKeys[event.stage])} · <time dateTime={event.created_at}>{dateFormatter.format(new Date(event.created_at))}</time></small>
                  {event.detail ? <p>{event.detail}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
