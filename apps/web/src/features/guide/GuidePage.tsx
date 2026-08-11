import { msg } from '../../shared/i18n';
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clapperboard,
  FolderSearch,
  Gauge,
  Radio,
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
  checkedAt: string | null;
};

const checkIcon = (state: DependencyCheck['state']) => {
  if (state === 'ready') return <Check size={15} />;
  if (state === 'checking') return <Spinner />;
  return <CircleAlert size={15} />;
};

export function GuidePage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<CheckState>({
    loading: true,
    checks: [],
    source: 'unavailable',
    error: null,
    checkedAt: null,
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
        checkedAt: response.checked_at,
      });
    } catch (error) {
      if (signal?.aborted) return;
      setStatus({
        loading: false,
        checks: [],
        source: 'unavailable',
        error: readableError(error),
        checkedAt: null,
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const readyCount = status.checks.filter((check) => check.state === 'ready').length;

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

      <section className="guide-hero">
        <Card className="setup-card">
          <div className="setup-card__header">
            <div>
              <span className="eyebrow">SYSTEM READINESS</span>
              <h2>{t('guide.readiness')}</h2>
            </div>
            <div className="setup-score">
              <strong>{readyCount}/{status.checks.length}</strong>
              <span>{t('guide.ready')}</span>
            </div>
          </div>
          <div className="readiness-overview grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <span>{t('guide.ready')}</span>
              <strong>{status.loading ? '—' : readyCount}</strong>
              <small>/ {status.checks.length}</small>
            </div>
            <div>
              <span>{t('guide.attention')}</span>
              <strong>{status.loading ? '—' : Math.max(0, status.checks.length - readyCount)}</strong>
              <small>/ {status.checks.length}</small>
            </div>
            <div>
              <span>{status.source === 'service' ? t('shell.serviceOnline') : t('guide.serviceUnavailable')}</span>
              <strong>{status.loading || status.checks.length === 0 ? '—' : `${Math.round((readyCount / status.checks.length) * 100)}%`}</strong>
              <small>{status.checkedAt ? new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(status.checkedAt)) : t('guide.recheck')}</small>
            </div>
          </div>
          <div className="setup-list">
            {status.checks.map((check) => (
              <div className="setup-row" key={check.kind}>
                <span className={`setup-row__icon setup-row__icon--${check.state}`}>
                  {checkIcon(check.state)}
                </span>
                <div>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
                <Badge tone={check.state === 'ready' ? 'success' : check.state === 'warning' ? 'warning' : 'danger'}>
                  {check.state === 'ready' ? t('guide.ready') : check.state === 'warning' ? t('guide.attention') : t('guide.notReady')}
                </Badge>
              </div>
            ))}
          </div>
          <div className="setup-card__footer">
            <Button onClick={() => void refresh()} disabled={status.loading}>
              <RefreshCw size={14} className={status.loading ? 'spin' : undefined} />{t('guide.recheck')}
            </Button>
            <Link className="inline-link" to="/settings">{t('guide.details')}<ArrowRight size={13} /></Link>
          </div>
        </Card>
      </section>

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
          <Radio size={18} />
          <div><strong>{t('guide.obsTitle')}</strong><span>{t('guide.obsDescription')}</span></div>
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
