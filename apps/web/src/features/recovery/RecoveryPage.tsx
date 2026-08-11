import { currentLocale, msg } from '../../shared/i18n';
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Clock3,
  FileCheck2,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import type { RecoveryStatus } from '../../shared/desktop/dto';
import { isDesktopShell, revealLocalPath } from '../../shared/desktop/dialog';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Spinner } from '../../shared/ui';

export function RecoveryPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recoveryDirectory, setRecoveryDirectory] = useState<string | null>(null);
  const restoreAction = useAsyncAction<RecoveryStatus>();
  const revealAction = useAsyncAction<boolean>();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [response, runtime] = await Promise.all([commands.recoveryStatus(), commands.runtimeState()]);
      setStatus(response);
      setRecoveryDirectory(`${runtime.data_dir.replace(/[\\/]+$/, '')}/recovery`);
      setError(null);
    } catch (cause) {
      setStatus(null);
      setError(readableError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const restore = async () => {
    const response = await restoreAction.run(() => commands.recoverConfiguration(), msg("m1256"));
    if (response) setStatus(response);
  };

  const revealRecoveryDirectory = async () => {
    if (!recoveryDirectory) return;
    await revealAction.run(
      () => revealLocalPath(recoveryDirectory),
      msg("m0506"),
    );
  };

  return (
    <div className="page page--recovery">
      <PageHeader eyebrow="SAFE RECOVERY" title={t('recovery.title')} description={t('recovery.description')} actions={<><Link className="button button--secondary button--md" to="/settings"><ArrowLeft size={14} />{t('nav.settings')}</Link><Button onClick={() => void refresh()} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : undefined} />{t('guide.recheck')}</Button></>} />
      {error ? <Notice tone="danger" title={msg("m0708")}>{error}</Notice> : null}
      {restoreAction.state.message ? <Notice tone={restoreAction.state.status === 'error' ? 'danger' : 'success'}>{restoreAction.state.message}</Notice> : null}
      {revealAction.state.message ? <Notice tone={revealAction.state.status === 'error' ? 'danger' : 'success'}>{revealAction.state.message}</Notice> : null}
      <div className="recovery-layout">
        <Card className={`recovery-status-card${status?.recovery_required ? ' is-required' : ''}`}>
          {loading ? <div className="recovery-loading"><Spinner label={msg("m0831")} /><strong>{msg("m0855")}</strong><span>{msg("m1145")}</span></div> : status?.recovery_required ? <><div className="recovery-status-card__icon"><CircleAlert size={28} /></div><Badge tone="danger">{msg("m1290")}</Badge><h2>{msg("m0832")}</h2><p>{status.reason ?? msg("m0134")}</p><div className="recovery-meta"><span><Clock3 size={14} />{msg("m0413")}<strong>{status.backup_created_at ? new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(status.backup_created_at)) : msg("m0763")}</strong></span><span><FileCheck2 size={14} />{msg("m0611")}<strong>{status.affected_files.length}</strong></span></div><Button variant="primary" disabled={restoreAction.state.status === 'loading'} onClick={() => void restore()}>{restoreAction.state.status === 'loading' ? <Spinner /> : <RotateCcw size={15} />}{msg("m0624")}</Button><Button disabled={!isDesktopShell() || !recoveryDirectory || revealAction.state.status === 'loading'} title={isDesktopShell() ? msg("m0393") : msg("m0185")} onClick={() => void revealRecoveryDirectory()}>{revealAction.state.status === 'loading' ? <Spinner /> : <FolderOpen size={14} />}{msg("m0638")}</Button></> : <EmptyState icon={<ShieldCheck size={30} />} title={msg("m1257")} description={msg("m0901")} action={<Link className="button button--primary button--md" to="/queue"><Check size={14} />{msg("m1196")}</Link>} />}
        </Card>
        <Card className="recovery-explainer"><span className="eyebrow">HOW IT WORKS</span><h2>{msg("m0335")}</h2><ol><li><span>1</span><div><strong>{msg("m0283")}</strong><p>{msg("m0442")}</p></div></li><li><span>2</span><div><strong>{msg("m0317")}</strong><p>{msg("m0700")}</p></div></li><li><span>3</span><div><strong>{msg("m0824")}</strong><p>{msg("m0622")}</p></div></li></ol><Notice tone="info">{msg("m0593")}</Notice></Card>
      </div>
    </div>
  );
}
