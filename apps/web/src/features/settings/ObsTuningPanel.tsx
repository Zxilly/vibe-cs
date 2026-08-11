import { msg, msgf } from '../../shared/i18n';
import { AlertTriangle, Archive, RefreshCw, RotateCcw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { readableError } from '../../shared/desktop/client';
import { Badge, Button, Notice, Spinner } from '../../shared/ui';

export type ObsTuningChangeView = {
  id: 'output_resolution' | 'frame_rate';
  label: string;
  current: string;
  target: string;
};

export type ObsTuningPlanView = {
  expectedFingerprint: string;
  recordingActive: boolean;
  currentResolution: string;
  currentFrameRate: string;
  targetResolution: string;
  targetFrameRate: string;
  changes: ObsTuningChangeView[];
  warnings: string[];
  excludedFields: string[];
};

export type ObsTuningBackupView = {
  id: string;
  createdAt: string;
  reason: string;
  resolution: string;
  frameRate: string;
};

export type ObsTuningPanelState =
  | { status: 'unavailable'; message: string }
  | { status: 'loading'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; plan: ObsTuningPlanView; backups: ObsTuningBackupView[] };

export type ObsTuningActionResult = {
  message: string;
  tone?: 'success' | 'warning';
};

export type ObsTuningPanelProps = {
  state: ObsTuningPanelState;
  onRefresh: () => Promise<void>;
  onApply: (expectedFingerprint: string) => Promise<ObsTuningActionResult>;
  onRestore: (backupId: string) => Promise<ObsTuningActionResult>;
  onDelete: (backupId: string) => Promise<ObsTuningActionResult>;
};

type PendingAction = 'refresh' | 'apply' | `restore:${string}` | `delete:${string}`;

export function canApplyObsTuning(
  plan: ObsTuningPlanView,
  confirmed: boolean,
  pendingAction: PendingAction | null,
): boolean {
  return confirmed
    && !plan.recordingActive
    && plan.changes.length > 0
    && pendingAction === null;
}

export function ObsTuningPanel({
  state,
  onRefresh,
  onApply,
  onRestore,
  onDelete,
}: ObsTuningPanelProps) {
  const fingerprint = state.status === 'ready' ? state.plan.expectedFingerprint : '';
  const [applyConfirmed, setApplyConfirmed] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const actionGate = useRef<PendingAction | null>(null);
  const [actionNotice, setActionNotice] = useState<{
    tone: 'success' | 'warning' | 'danger';
    message: string;
  } | null>(null);

  useEffect(() => {
    setApplyConfirmed(false);
    setPendingRestore(null);
    setRestoreConfirmed(false);
    setPendingDelete(null);
  }, [fingerprint]);

  const run = async (
    key: PendingAction,
    action: () => Promise<ObsTuningActionResult | void>,
  ) => {
    if (actionGate.current !== null) return;
    actionGate.current = key;
    setPendingAction(key);
    setActionNotice(null);
    try {
      const result = await action();
      setActionNotice({
        tone: result?.tone ?? 'success',
        message: result?.message ?? msg("m0058"),
      });
    } catch (error) {
      setActionNotice({ tone: 'danger', message: readableError(error) });
    } finally {
      actionGate.current = null;
      setPendingAction(null);
    }
  };

  const selectRestore = (id: string) => {
    setPendingRestore(id);
    setRestoreConfirmed(false);
    setPendingDelete(null);
  };

  const selectDelete = (id: string) => {
    setPendingDelete(id);
    setPendingRestore(null);
    setRestoreConfirmed(false);
  };

  return (
    <section className="obs-tuning-panel" aria-labelledby="obs-tuning-title">
      <header className="obs-diagnosis-heading">
        <div>
          <strong id="obs-tuning-title">{msg("m0061")}</strong>
          <small>{msg("m0725")}</small>
        </div>
        <Button
          size="sm"
          disabled={pendingAction !== null || state.status === 'unavailable' || state.status === 'loading'}
          onClick={() => void run('refresh', onRefresh)}
        >
          {pendingAction === 'refresh' ? <Spinner /> : <RefreshCw size={13} />}{msg("m0294")}
        </Button>
      </header>

      <Notice tone="info" title={msg("m1284")}>

       {msg("m1204")}
      </Notice>

      {state.status === 'unavailable' ? <Notice tone="warning">{state.message}</Notice> : null}
      {state.status === 'loading' ? <Notice tone="info">{state.message}</Notice> : null}
      {state.status === 'error' ? <Notice tone="danger">{state.message}</Notice> : null}

      {state.status === 'ready' ? (
        <>
          <div className="obs-tuning-summary" aria-label={msg("m0059")}>
            <div><span>{msg("m0590")}</span><strong>{state.plan.currentResolution}</strong><small>{state.plan.currentFrameRate}</small></div>
            <div><span>{msg("m1019")}</span><strong>{state.plan.targetResolution}</strong><small>{state.plan.targetFrameRate}</small></div>
            <Badge tone={state.plan.changes.length === 0 ? 'success' : 'warning'}>{state.plan.changes.length === 0 ? msg("m0714") : msgf("m0114", [state.plan.changes.length])}</Badge>
          </div>

          {state.plan.recordingActive ? <Notice tone="danger" title={msg("m0848")}>{msg("m0603")}</Notice> : null}
          {state.plan.warnings.length > 0 ? <Notice tone="warning" title={msg("m1109")}>{state.plan.warnings.join('；')}</Notice> : null}

          <div className="obs-tuning-diff" aria-label={msg("m0057")}>
            {state.plan.changes.length === 0 ? <div className="feature-status"><span className="feature-status__icon"><SlidersHorizontal size={15} /></span><div><strong>{msg("m0588")}</strong><small>{msg("m0713")}</small></div><Badge tone="success">{msg("m0132")}</Badge></div> : state.plan.changes.map((change) => <div key={change.id}><span>{change.label}</span><code>{change.current}</code><span aria-hidden="true">→</span><code>{change.target}</code></div>)}
          </div>

          <label className="checkbox-row obs-tuning-confirmation">
            <input type="checkbox" checked={applyConfirmed} disabled={state.plan.recordingActive || state.plan.changes.length === 0 || pendingAction !== null} onChange={(event) => setApplyConfirmed(event.target.checked)} />
            <span>{msg("m0628")}</span>
          </label>
          <Button variant="primary" disabled={!canApplyObsTuning(state.plan, applyConfirmed, pendingAction)} onClick={() => void run('apply', () => onApply(state.plan.expectedFingerprint))}>{pendingAction === 'apply' ? <Spinner /> : <SlidersHorizontal size={14} />}{msg("m1034")}</Button>

          <div className="obs-tuning-scope-note"><AlertTriangle size={14} /><span>{msg("m0663")}{state.plan.excludedFields.join('、')}{msg("m0130")}</span></div>

          <div className="obs-tuning-backups">
            <header><div><Archive size={15} /><span><strong>{msg("m0971")}</strong><small>{msg("m0736")}</small></span></div><Badge tone="neutral">{state.backups.length} / 32</Badge></header>
            {state.backups.length === 0 ? <Notice tone="info">{msg("m0465")}</Notice> : state.backups.map((backup) => {
              const restoring = pendingRestore === backup.id;
              const deleting = pendingDelete === backup.id;
              return (
                <article key={backup.id} className="obs-tuning-backup-row">
                  <div><strong>{backup.resolution} · {backup.frameRate}</strong><small>{backup.reason} · {backup.createdAt} · {backup.id.slice(0, 8)}</small></div>
                  <div><Button size="sm" disabled={pendingAction !== null || state.plan.recordingActive} onClick={() => selectRestore(backup.id)}><RotateCcw size={12} />{msg("m0619")}</Button><Button size="sm" variant="danger" disabled={pendingAction !== null} onClick={() => selectDelete(backup.id)}><Trash2 size={12} />{msg("m0284")}</Button></div>
                  {restoring ? <div className="obs-tuning-inline-confirm"><label className="checkbox-row"><input type="checkbox" checked={restoreConfirmed} onChange={(event) => setRestoreConfirmed(event.target.checked)} /><span>{msg("m0629")}</span></label><div><Button size="sm" onClick={() => { setPendingRestore(null); setRestoreConfirmed(false); }}>{msg("m0325")}</Button><Button size="sm" variant="primary" disabled={!restoreConfirmed || pendingAction !== null} onClick={() => void run(`restore:${backup.id}`, async () => { const result = await onRestore(backup.id); setPendingRestore(null); setRestoreConfirmed(false); return result; })}>{msg("m1035")}</Button></div></div> : null}
                  {deleting ? <div className="obs-tuning-inline-confirm"><span>{msg("m1032")}</span><div><Button size="sm" onClick={() => setPendingDelete(null)}>{msg("m0325")}</Button><Button size="sm" variant="danger" disabled={pendingAction !== null} onClick={() => void run(`delete:${backup.id}`, async () => { const result = await onDelete(backup.id); setPendingDelete(null); return result; })}>{msg("m1031")}</Button></div></div> : null}
                </article>
              );
            })}
          </div>
        </>
      ) : null}

      {actionNotice ? <Notice tone={actionNotice.tone}>{actionNotice.message}</Notice> : null}
    </section>
  );
}
