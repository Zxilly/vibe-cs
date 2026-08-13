import { msg } from '../../shared/i18n';
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clapperboard,
  FolderSearch,
  Gauge,
  Film,
  RefreshCw,
  Settings2,
  WandSparkles,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import type { DependencyCheck } from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, Card, Notice, PageHeader, Spinner } from '../../shared/ui';

type CheckState = {
  loading: boolean;
  checks: DependencyCheck[];
  source: 'service' | 'unavailable';
  error: string | null;
};

const checkIcon = (state: DependencyCheck['state']) => {
  if (state === 'ready') return <Check size={15} />;
  if (state === 'checking') return <Spinner />;
  return <CircleAlert size={15} />;
};

export function GuidePreflight({
  loading,
  check,
  onRefresh,
}: {
  loading: boolean;
  check: DependencyCheck | undefined;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const mode = loading ? 'checking' : check?.state === 'ready' ? 'ready' : 'missing';
  const detail = mode === 'ready'
    ? check?.detail
    : mode === 'checking'
      ? t('guide.cs2CheckingDescription')
      : t('guide.cs2MissingDescription');

  return (
    <section
      className={`guide-preflight guide-preflight--${mode}`}
      role={mode === 'missing' ? 'alert' : 'status'}
      aria-labelledby="guide-preflight-title"
    >
      <span className="guide-preflight__icon" aria-hidden="true">
        {loading ? <Spinner /> : checkIcon(check?.state ?? 'missing')}
      </span>
      <div className="guide-preflight__copy">
        <div className="guide-preflight__title-row">
          <h2 id="guide-preflight-title">
            {mode === 'ready' ? t('guide.cs2Ready') : mode === 'checking' ? t('guide.checking') : t('guide.cs2Required')}
          </h2>
          <Badge tone={mode === 'ready' ? 'success' : mode === 'checking' ? 'neutral' : 'danger'}>
            {mode === 'ready' ? t('guide.ready') : mode === 'checking' ? t('guide.checking') : t('guide.notReady')}
          </Badge>
        </div>
        <p title={mode === 'ready' ? detail : undefined}>{detail}</p>
      </div>
      <div className="guide-preflight__actions">
        <Link
          className={mode === 'missing' ? 'button button--primary button--sm' : 'inline-link'}
          to={check?.action_path ?? '/settings'}
        >
          {mode === 'missing' ? t('guide.locateCs2') : t('guide.details')}<ArrowRight size={13} />
        </Link>
        <Button size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />{t('guide.recheck')}
        </Button>
      </div>
    </section>
  );
}

export function GuidePage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<CheckState>({
    loading: true,
    checks: [],
    source: 'unavailable',
    error: null,
  });

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setStatus((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await commands.quickCheck(signal);
      setStatus({
        loading: false,
        checks: response.checks,
        source: 'service',
        error: null,
      });
    } catch (error) {
      if (signal?.aborted) return;
      setStatus({
        loading: false,
        checks: [],
        source: 'unavailable',
        error: readableError(error),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const gameCheck = status.checks.find((check) => check.kind === 'game');

  return (
    <div className="page page--guide">
      <PageHeader
        eyebrow="CONTROL ROOM"
        title={t('guide.title')}
        description={t('guide.description')}
        actions={
          <Link className="button button--primary button--md" to="/library">
            {t('guide.openLibrary')}<ArrowRight size={15} />
          </Link>
        }
      />

      {status.source === 'unavailable' ? (
        <Notice tone="warning" title={t('guide.serviceUnavailable')}>
          {status.error ?? t('guide.serviceUnavailable')}
        </Notice>
      ) : null}

      <GuidePreflight loading={status.loading} check={gameCheck} onRefresh={() => void refresh()} />

      <section className="workflow-section">
        <div className="section-header">
          <div>
            <span className="eyebrow">YOUR WORKFLOW</span>
            <h2>{t('guide.workflowTitle')}</h2>
            <p>{t('guide.workflowDescription')}</p>
          </div>
        </div>
        <div className="workflow-grid">
          <Link to="/library" className="workflow-card">
            <span className="workflow-card__number">01</span>
            <div className="workflow-card__icon"><FolderSearch size={20} /></div>
            <h3>{t('guide.collectTitle')}</h3>
            <p>{t('guide.collectDescription')}</p>
            <span className="workflow-card__link">{t('guide.collectAction')}<ArrowRight size={13} /></span>
          </Link>
          <Link to="/library" className="workflow-card">
            <span className="workflow-card__number">02</span>
            <div className="workflow-card__icon"><Gauge size={20} /></div>
            <h3>{t('guide.analyzeTitle')}</h3>
            <p>{t('guide.analyzeDescription')}</p>
            <span className="workflow-card__link">{t('guide.analyzeAction')}<ArrowRight size={13} /></span>
          </Link>
          <Link to="/production" className="workflow-card">
            <span className="workflow-card__number">03</span>
            <div className="workflow-card__icon"><Clapperboard size={20} /></div>
            <h3>{t('guide.createTitle')}</h3>
            <p>{t('guide.createDescription')}</p>
            <span className="workflow-card__link">{t('guide.createAction')}<ArrowRight size={13} /></span>
          </Link>
        </div>
      </section>

      <section className="quick-grid">
        <Card className="quick-card">
          <Film size={18} />
          <div><strong>{t('guide.movieEngineTitle')}</strong><span>{t('guide.movieEngineDescription')}</span></div>
          <Link to="/settings" aria-label={msg("m0636")}><ArrowRight size={15} /></Link>
        </Card>
        <Card className="quick-card">
          <WandSparkles size={18} />
          <div><strong>{t('guide.editorTitle')}</strong><span>{t('guide.editorDescription')}</span></div>
          <Link to="/production" aria-label={msg("m0635")}><ArrowRight size={15} /></Link>
        </Card>
        <Card className="quick-card">
          <Settings2 size={18} />
          <div><strong>{t('guide.pathsTitle')}</strong><span>{t('guide.pathsDescription')}</span></div>
          <Link to="/settings" aria-label={msg("m0640")}><ArrowRight size={15} /></Link>
        </Card>
      </section>
    </div>
  );
}
