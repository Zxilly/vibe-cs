import { currentLocale, msg, msgf } from '../../shared/i18n';
import {
  Check,
  CircleAlert,
  Clapperboard,
  FileOutput,
  Files,
  FolderOpen,
  HardDrive,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import type {
  BatchDeleteOutputResult,
  CleanupMissingOutputsResult,
  CleanupStagedOutputsResult,
  DeleteOutputResult,
  JobStatus,
  OutputAvailability,
  OutputItem,
  OutputKind,
} from '../../shared/desktop/dto';
import { isDesktopShell, revealLocalPath } from '../../shared/desktop/dialog';
import { useI18n } from '../../shared/i18n';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Notice,
  PageHeader,
  Spinner,
  useDialogFocus,
} from '../../shared/ui';
import {
  canRevealOutput,
  formatOutputBytes,
  outputAvailabilityLabel,
  outputAvailabilityTone,
  outputItemKey,
  outputKindLabel,
  outputReferenceFromKey,
  outputStatusLabel,
  outputStatusTone,
  terminalOutputStatuses,
} from './outputPresentation';

const PAGE_SIZE = 30;
const dateFormatter = new Intl.DateTimeFormat(currentLocale(), {
  dateStyle: 'medium',
  timeStyle: 'short',
});

type Confirmation =
  | { type: 'single'; item: OutputItem }
  | { type: 'batch' }
  | { type: 'cleanup' }
  | { type: 'cleanup-staged' }
  | null;

type ConfirmationDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  working: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
};

type OutputActionKey = 'rename' | 'delete' | 'batch' | 'cleanup' | 'cleanup-staged' | 'reveal';

type OutputActionNotice = {
  tone: 'success' | 'warning' | 'danger';
  message: string;
};

export function canDismissOutputConfirmation(working: boolean): boolean {
  return !working;
}

export function canCommitOutputLoad(
  requestGeneration: number,
  currentGeneration: number,
  aborted: boolean,
): boolean {
  return requestGeneration === currentGeneration && !aborted;
}

export function boundedOutputPage(page: number, total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  const pageCount = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  return Math.min(Math.max(1, page), pageCount);
}

type OutputWorkspaceMode = 'loading' | 'zero' | 'filtered-empty' | 'results' | 'error';

export function outputWorkspacePresentation({
  loading,
  itemCount,
  total,
  hasFilters,
  loadFailed,
}: {
  loading: boolean;
  itemCount: number;
  total: number;
  hasFilters: boolean;
  loadFailed: boolean;
}): {
  mode: OutputWorkspaceMode;
  showFilters: boolean;
  showCollectionControls: boolean;
  showStagedCleanup: boolean;
} {
  if (loadFailed && itemCount === 0) {
    return { mode: 'error', showFilters: false, showCollectionControls: false, showStagedCleanup: false };
  }
  if (loading && itemCount === 0) {
    return { mode: 'loading', showFilters: hasFilters, showCollectionControls: false, showStagedCleanup: false };
  }
  if (itemCount > 0) {
    return { mode: 'results', showFilters: true, showCollectionControls: true, showStagedCleanup: false };
  }
  if (hasFilters || total > 0) {
    return { mode: 'filtered-empty', showFilters: true, showCollectionControls: false, showStagedCleanup: false };
  }
  return { mode: 'zero', showFilters: false, showCollectionControls: false, showStagedCleanup: true };
}

export function OutputZeroActions({
  working,
  onCleanupStaged,
}: {
  working: boolean;
  onCleanupStaged: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="outputs-zero-actions">
      <Link className="button button--primary button--md" to="/production">{t('production.title')}</Link>
      <Button
        data-action="cleanup-staged"
        disabled={working}
        onClick={onCleanupStaged}
      >
        <Trash2 size={13} />{msg("m1270")}
      </Button>
    </div>
  );
}

export function OutputSourceProjectAction({
  item,
  label,
}: {
  item: Pick<OutputItem, 'output_kind' | 'project_id'>;
  label: string;
}) {
  if (item.output_kind !== 'export' || item.project_id === null) return null;
  return (
    <Link
      className="icon-button"
      data-action="open-source-project"
      to={`/studio/editor?project=${encodeURIComponent(item.project_id)}`}
      aria-label={label}
      title={label}
    >
      <Clapperboard size={14} />
    </Link>
  );
}

export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  working,
  onCancel,
  onConfirm,
  children,
}: ConfirmationDialogProps) {
  const cancel = () => {
    if (canDismissOutputConfirmation(working)) onCancel();
  };
  const dialogRef = useDialogFocus<HTMLElement>(open, cancel);
  if (!open) return null;
  return (
    <div className="output-confirm-layer" role="presentation" onMouseDown={cancel}>
      <section
        ref={dialogRef}
        className="output-confirm"
        role="dialog"
        aria-modal="true"
        aria-busy={working}
        aria-labelledby="output-confirm-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span><CircleAlert size={19} /></span>
          <div>
            <h2 id="output-confirm-title">{title}</h2>
            <p>{description}</p>
          </div>
          <IconButton label={msg("m0247")} disabled={working} onClick={cancel}><X size={15} /></IconButton>
        </header>
        {children ? <div className="output-confirm__options">{children}</div> : null}
        <footer>
          <Button disabled={working} onClick={cancel}>{msg("m0325")}</Button>
          <Button variant="danger" disabled={working} onClick={onConfirm}>
            {working ? <Spinner /> : <Trash2 size={14} />}{confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  );
}

export function OutputsPage() {
  const { t } = useI18n();
  const desktop = isDesktopShell();
  const [items, setItems] = useState<OutputItem[]>([]);
  const [total, setTotal] = useState(0);
  const [scanLimited, setScanLimited] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [kind, setKind] = useState<OutputKind | ''>('');
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [availability, setAvailability] = useState<OutputAvailability | ''>('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [pendingAction, setPendingAction] = useState<OutputActionKey | null>(null);
  const [actionNotice, setActionNotice] = useState<OutputActionNotice | null>(null);
  const actionGate = useRef<OutputActionKey | null>(null);
  const actionGeneration = useRef(0);
  const loadGeneration = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const loadTimer = useRef<number | null>(null);
  const mounted = useRef(true);

  const invalidateOutputLoads = useCallback(() => {
    loadGeneration.current += 1;
    loadController.current?.abort();
    loadController.current = null;
    if (loadTimer.current !== null) {
      window.clearTimeout(loadTimer.current);
      loadTimer.current = null;
    }
    return loadGeneration.current;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      actionGeneration.current += 1;
      invalidateOutputLoads();
    };
  }, [invalidateOutputLoads]);

  const loadOutputs = useCallback(async (
    generation: number,
    signal: AbortSignal,
    quiet: boolean,
  ): Promise<boolean | null> => {
    if (!quiet && canCommitOutputLoad(generation, loadGeneration.current, signal.aborted)) {
      setLoading(true);
    }
    try {
      const response = await commands.listOutputs({
        page,
        page_size: PAGE_SIZE,
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
        ...(availability ? { availability } : {}),
        ...(deferredSearch.trim() ? { search: deferredSearch.trim() } : {}),
      }, signal);
      if (!canCommitOutputLoad(generation, loadGeneration.current, signal.aborted)) return null;
      setItems(response.items);
      setTotal(response.total);
      setScanLimited(response.scan_limited);
      setLoadError(null);
      return response.items.some(
        (item) => item.output_kind === 'export' && !terminalOutputStatuses.has(item.status),
      );
    } catch (error) {
      if (canCommitOutputLoad(generation, loadGeneration.current, signal.aborted)) {
        setLoadError(readableError(error));
      }
      return null;
    } finally {
      if (!quiet && canCommitOutputLoad(generation, loadGeneration.current, signal.aborted)) {
        setLoading(false);
      }
    }
  }, [availability, deferredSearch, kind, page, status]);

  useEffect(() => {
    if (actionGate.current !== null) return undefined;
    const generation = invalidateOutputLoads();
    let disposed = false;

    const poll = async (quiet: boolean) => {
      if (disposed || generation !== loadGeneration.current) return;
      loadTimer.current = null;
      const controller = new AbortController();
      loadController.current = controller;
      const active = await loadOutputs(generation, controller.signal, quiet);
      if (loadController.current === controller) loadController.current = null;
      if (
        !disposed
        && generation === loadGeneration.current
        && (active === true || (quiet && active === null))
      ) {
        loadTimer.current = window.setTimeout(() => void poll(true), active === null ? 2_000 : 1_000);
      }
    };

    void poll(false);
    return () => {
      disposed = true;
      if (generation === loadGeneration.current) invalidateOutputLoads();
    };
  }, [invalidateOutputLoads, loadOutputs, refreshRevision]);

  const selectableItems = useMemo(
    () => items.filter((item) => terminalOutputStatuses.has(item.status)),
    [items],
  );
  const allPageSelected = selectableItems.length > 0
    && selectableItems.every((item) => selected.has(outputItemKey(item)));
  const selectedReferences = useMemo(
    () => Array.from(selected, outputReferenceFromKey).filter((item) => item !== null),
    [selected],
  );
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = Boolean(search.trim() || kind || status || availability);
  const workspace = outputWorkspacePresentation({
    loading,
    itemCount: items.length,
    total,
    hasFilters,
    loadFailed: loadError !== null,
  });

  useEffect(() => {
    const boundedPage = boundedOutputPage(page, total, PAGE_SIZE);
    if (boundedPage !== page) setPage(boundedPage);
  }, [page, total]);

  const resetPage = () => setPage(1);
  const refresh = () => {
    if (actionGate.current === null) setRefreshRevision((revision) => revision + 1);
  };

  const runOutputAction = useCallback(async <T,>(
    key: OutputActionKey,
    action: () => Promise<T>,
    success: OutputActionNotice | ((result: T) => OutputActionNotice),
    invalidatesOutputs: boolean,
  ): Promise<T | null> => {
    if (actionGate.current !== null) return null;
    actionGate.current = key;
    const generation = actionGeneration.current + 1;
    actionGeneration.current = generation;
    if (invalidatesOutputs) invalidateOutputLoads();
    setPendingAction(key);
    setActionNotice(null);
    try {
      const result = await action();
      if (!mounted.current || generation !== actionGeneration.current) return null;
      setActionNotice(typeof success === 'function' ? success(result) : success);
      return result;
    } catch (error) {
      if (mounted.current && generation === actionGeneration.current) {
        setActionNotice({ tone: 'danger', message: readableError(error) });
      }
      return null;
    } finally {
      if (actionGate.current === key) actionGate.current = null;
      if (mounted.current && generation === actionGeneration.current) {
        setPendingAction(null);
        if (invalidatesOutputs) setRefreshRevision((revision) => revision + 1);
      }
    }
  }, [invalidateOutputLoads]);

  const toggleSelection = (item: OutputItem) => {
    const key = outputItemKey(item);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const togglePageSelection = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const item of selectableItems) {
        const key = outputItemKey(item);
        if (allPageSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  };

  const beginRename = (item: OutputItem) => {
    if (actionGate.current !== null) return;
    setRenamingKey(outputItemKey(item));
    setRenameValue(item.file_name);
  };

  const submitRename = async (item: OutputItem) => {
    const renamed = await runOutputAction<OutputItem>(
      'rename',
      () => commands.renameOutput(item.output_kind, item.id, renameValue.trim()),
      { tone: 'success', message: msg("m0686") },
      true,
    );
    if (!renamed) return;
    setRenamingKey(null);
  };

  const askDelete = (item: OutputItem) => {
    if (actionGate.current !== null) return;
    setDeleteFiles(item.mutable);
    setConfirmation({ type: 'single', item });
  };

  const confirmDelete = async (item: OutputItem) => {
    const result = await runOutputAction<DeleteOutputResult>(
      'delete',
      () => commands.deleteOutput(item.output_kind, item.id, deleteFiles),
      (value) => ({
        tone: value.warning ? 'warning' : 'success',
        message: value.warning ?? (
          value.file_deleted ? msg("m1190") : msg("m1193")
        ),
      }),
      true,
    );
    if (!result) return;
    setConfirmation(null);
    setSelected((current) => {
      const next = new Set(current);
      next.delete(outputItemKey(item));
      return next;
    });
  };

  const confirmBatchDelete = async () => {
    const result = await runOutputAction<BatchDeleteOutputResult>(
      'batch',
      () => commands.batchDeleteOutputs(selectedReferences, deleteFiles),
      (value) => value.failed > 0
        ? { tone: 'warning', message: msgf("m0500", [value.deleted, value.failed]) }
        : { tone: 'success', message: msg("m0649") },
      true,
    );
    if (!result) return;
    setConfirmation(null);
    if (result.failed === 0) setSelected(new Set());
    else {
      const failed = new Set(
        result.items
          .filter((item) => item.error)
          .map((item) => `${item.kind}:${item.id}`),
      );
      setSelected(failed);
    }
  };

  const confirmCleanup = async () => {
    const result = await runOutputAction<CleanupMissingOutputsResult>(
      'cleanup',
      () => commands.cleanupMissingOutputs(kind || undefined),
      (value) => ({
        tone: value.scan_limited ? 'warning' : 'success',
        message: value.scan_limited
          ? msgf("m0528", [value.deleted])
          : msgf("m0527", [value.deleted]),
      }),
      true,
    );
    if (!result) return;
    setConfirmation(null);
    setSelected(new Set());
  };

  const confirmStagedCleanup = async () => {
    const result = await runOutputAction<CleanupStagedOutputsResult>(
      'cleanup-staged',
      () => commands.cleanupStagedOutputs(),
      (value) => ({
        tone: value.failed > 0 || value.scan_limited ? 'warning' : 'success',
        message: value.failed > 0
          ? msgf("m0526", [value.deleted, value.failed])
          : msgf("m0525", [value.deleted, value.scan_limited ? msg("m1349") : '']),
      }),
      true,
    );
    if (!result) return;
    setConfirmation(null);
  };

  const reveal = async (item: OutputItem) => {
    await runOutputAction<boolean>(
      'reveal',
      () => revealLocalPath(item.path),
      { tone: 'success', message: msg("m0507") },
      false,
    );
  };

  const confirmationWorking = pendingAction !== null;

  return (
    <div className="page page--outputs">
      <PageHeader
        eyebrow="OUTPUT LIBRARY"
        title={t('outputs.title')}
        description={t('outputs.description')}
        actions={<Button disabled={loading || pendingAction !== null} onClick={refresh}>{loading ? <Spinner /> : <RefreshCw size={14} />}{t('common.refresh')}</Button>}
      />

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}
      {scanLimited ? <Notice tone="warning">{msg("m1113")}</Notice> : null}
      {actionNotice ? <Notice tone={actionNotice.tone}>{actionNotice.message}</Notice> : null}

      {workspace.showFilters ? <Card className="outputs-toolbar">
        <label className="outputs-search">
          <Search size={15} />
          <span className="sr-only">{msg("m0672")}</span>
          <input
            value={search}
            placeholder={msg("m0667")}
            onChange={(event) => { setSearch(event.target.value); resetPage(); }}
          />
        </label>
        <label><span>{msg("m0813")}</span><select value={kind} onChange={(event) => { setKind(event.target.value as OutputKind | ''); resetPage(); }}><option value="">{msg("m0229")}</option><option value="recording">{msg("m0604")}</option><option value="export">{msg("m0933")}</option></select></label>
        <label><span>{msg("m0974")}</span><select value={status} onChange={(event) => { setStatus(event.target.value as JobStatus | ''); resetPage(); }}><option value="">{msg("m0229")}</option><option value="queued">{msg("m0662")}</option><option value="preparing">{msg("m0250")}</option><option value="running">{msg("m0408")}</option><option value="cancelling">{msg("m0845")}</option><option value="completed">{msg("m0510")}</option><option value="failed">{msg("m0425")}</option><option value="cancelled">{msg("m0504")}</option></select></label>
        <label><span>{msg("m0685")}</span><select value={availability} onChange={(event) => { setAvailability(event.target.value as OutputAvailability | ''); resetPage(); }}><option value="">{msg("m0229")}</option><option value="present">{msg("m0350")}</option><option value="missing">{msg("m1088")}</option><option value="unsafe">{msg("m0149")}</option></select></label>
      </Card> : null}

      {workspace.showCollectionControls ? <Card className="outputs-batchbar">
        <label>
          <input
            type="checkbox"
            checked={allPageSelected}
            disabled={selectableItems.length === 0 || pendingAction !== null}
            onChange={togglePageSelection}
          />

         {msg("m1233")}
        </label>
        <span>{selected.size > 0 ? msgf("m0543", [selected.size]) : msg("m1194")}</span>
        <div>
          <Button size="sm" disabled={selectedReferences.length === 0 || pendingAction !== null} onClick={() => { setDeleteFiles(false); setConfirmation({ type: 'batch' }); }}><Trash2 size={13} />{msg("m0648")}</Button>
          <Button size="sm" disabled={total === 0 || pendingAction !== null} onClick={() => setConfirmation({ type: 'cleanup' })}><HardDrive size={13} />{msg("m0927")}</Button>
          <Button size="sm" disabled={pendingAction !== null} onClick={() => setConfirmation({ type: 'cleanup-staged' })}><Trash2 size={13} />{msg("m1270")}</Button>
        </div>
      </Card> : null}

      {workspace.mode === 'loading' ? (
        <Card className="outputs-loading"><Spinner label={msg("m0305")} /><strong>{msg("m0869")}</strong></Card>
      ) : workspace.mode === 'zero' ? (
        <Card className="outputs-zero-workspace"><EmptyState icon={<FileOutput size={28} />} title={t('outputs.empty')} description={t('outputs.emptyDescription')} action={workspace.showStagedCleanup ? <OutputZeroActions working={pendingAction !== null} onCleanupStaged={() => setConfirmation({ type: 'cleanup-staged' })} /> : undefined} /></Card>
      ) : workspace.mode === 'filtered-empty' ? (
        <Card className="outputs-filtered-empty"><EmptyState icon={<Search size={24} />} title={t('outputs.empty')} description={t('outputs.emptyDescription')} /></Card>
      ) : workspace.mode === 'error' ? null : (
        <div className="outputs-list" role="list" aria-label={msg("m1187")}>
          {items.map((item) => {
            const key = outputItemKey(item);
            const terminal = terminalOutputStatuses.has(item.status);
            const renaming = renamingKey === key;
            return (
              <Card className={`output-row output-row--${item.availability}`} key={key} role="listitem">
                <label className="output-row__select">
                  <input type="checkbox" checked={selected.has(key)} disabled={!terminal || pendingAction !== null} onChange={() => toggleSelection(item)} />
                  <span className="sr-only">{msg("m1216")} {item.title}</span>
                </label>
                <div className={`output-row__icon output-row__icon--${item.output_kind}`}>
                  {item.output_kind === 'recording' ? <Files size={19} /> : <FileOutput size={19} />}
                </div>
                <div className="output-row__main">
                  {renaming ? (
                    <form onSubmit={(event) => { event.preventDefault(); void submitRename(item); }}>
                      <input value={renameValue} maxLength={180} autoFocus disabled={pendingAction === 'rename'} aria-label={msg("m0699")} onChange={(event) => setRenameValue(event.target.value)} />
                      <IconButton label={msg("m0214")} disabled={!renameValue.trim() || pendingAction !== null} type="submit"><Check size={14} /></IconButton>
                      <IconButton label={msg("m0329")} disabled={pendingAction !== null} onClick={() => setRenamingKey(null)}><X size={14} /></IconButton>
                    </form>
                  ) : <strong title={item.path}>{item.title}</strong>}
                  <div>
                    <Badge tone={outputStatusTone(item.status)}>{outputStatusLabel(item.status)}</Badge>
                    <Badge tone={outputAvailabilityTone(item.availability)}>{outputAvailabilityLabel(item.availability)}</Badge>
                    <span>{outputKindLabel(item.output_kind)} · {item.media_kind}</span>
                  </div>
                  <small title={item.path}>{item.file_name || item.path || msg("m0467")}</small>
                  {item.error ? <span className="output-row__error">{item.error}</span> : null}
                  {!terminal ? <progress value={Math.max(0, Math.min(1, item.progress))} max={1} aria-label={`${outputStatusLabel(item.status)} ${Math.round(item.progress * 100)}%`} /> : null}
                </div>
                <div className="output-row__meta">
                  <span>{formatOutputBytes(item.size_bytes)}</span>
                  <span>{dateFormatter.format(new Date(item.updated_at))}</span>
                  <small>{item.managed ? msg("m0334") : msg("m0421")}</small>
                </div>
                <div className="output-row__actions">
                  <OutputSourceProjectAction item={item} label={t('studio.continueProject')} />
                  <IconButton label={msg("m1263")} disabled={!item.mutable || pendingAction !== null} onClick={() => beginRename(item)}><Pencil size={14} /></IconButton>
                  <IconButton
                    label={desktop ? msg("m0392") : msg("m0913")}
                    disabled={!desktop || !canRevealOutput(item) || pendingAction !== null}
                    onClick={() => void reveal(item)}
                  ><FolderOpen size={14} /></IconButton>
                  <IconButton label={msg("m0288")} disabled={!terminal || pendingAction !== null} onClick={() => askDelete(item)}><Trash2 size={14} /></IconButton>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {workspace.showCollectionControls ? <footer className="outputs-footer">
        <span>{total} {msg("m1307")} {page}/{pageCount} {msg("m1302")}</span>
        <div><Button size="sm" disabled={page <= 1 || loading || pendingAction !== null} onClick={() => setPage((current) => Math.max(1, current - 1))}>{msg("m0135")}</Button><Button size="sm" disabled={page >= pageCount || loading || pendingAction !== null} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>{msg("m0140")}</Button></div>
      </footer> : null}

      <ConfirmationDialog
        open={confirmation?.type === 'single'}
        title={msg("m0409")}
        description={confirmation?.type === 'single' ? msgf("m0464", [confirmation.item.title]) : ''}
        confirmLabel={msg("m1033")}
        working={confirmationWorking}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => { if (confirmation?.type === 'single') void confirmDelete(confirmation.item); }}
      >
        {confirmation?.type === 'single' ? (
          <label><input type="checkbox" checked={deleteFiles} disabled={!confirmation.item.mutable || confirmationWorking} onChange={(event) => setDeleteFiles(event.target.checked)} /><span><strong>{msg("m0354")}</strong><small>{confirmation.item.mutable ? msg("m0687") : msg("m0419")}</small></span></label>
        ) : null}
      </ConfirmationDialog>

      <ConfirmationDialog
        open={confirmation?.type === 'batch'}
        title={msgf("m0647", [selectedReferences.length])}
        description={msg("m1195")}
        confirmLabel={msg("m0646")}
        working={confirmationWorking}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void confirmBatchDelete()}
      >
        <label><input type="checkbox" checked={deleteFiles} disabled={confirmationWorking} onChange={(event) => setDeleteFiles(event.target.checked)} /><span><strong>{msg("m0355")}</strong><small>{msg("m0420")}</small></span></label>
      </ConfirmationDialog>

      <ConfirmationDialog
        open={confirmation?.type === 'cleanup'}
        title={msg("m0928")}
        description={msg("m0186")}
        confirmLabel={msg("m0929")}
        working={confirmationWorking}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void confirmCleanup()}
      />
      <ConfirmationDialog
        open={confirmation?.type === 'cleanup-staged'}
        title={msg("m0924")}
        description={msg("m1269")}
        confirmLabel={msg("m1271")}
        working={confirmationWorking}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void confirmStagedCleanup()}
      />
    </div>
  );
}
