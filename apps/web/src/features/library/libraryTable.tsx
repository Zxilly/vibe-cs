import { Columns3, FolderOpen, Info, MoreHorizontal, MoveHorizontal, Play, Sparkles } from 'lucide-react';

import type { DemoSummary } from '../../shared/desktop/dto';
import { currentLocale, useI18n } from '../../shared/i18n';
import { Badge, Button, Card, IconButton, Spinner } from '../../shared/ui';
import { demoLifecyclePresentation, hasVerifiedMatchScore } from './libraryPresentation';
import {
  DEFAULT_LIBRARY_COLUMNS,
  LIBRARY_PAGE_SIZES,
  libraryPageCount,
  type LibraryOptionalColumn,
} from './libraryQuery';
import { isDemoAnalyzable } from './librarySelection';
import './LibraryPowerTable.css';

const UNKNOWN_VALUE = '—';

export type LibrarySortKey = 'status' | 'file' | 'map' | 'score' | 'duration' | 'rounds' | 'updated';
export type LibrarySortDirection = 'asc' | 'desc';
export type LibrarySort = { key: LibrarySortKey; direction: LibrarySortDirection };

export function LibraryColumnVisibility({
  visibleColumns,
  onChange,
}: {
  visibleColumns: ReadonlySet<LibraryOptionalColumn>;
  onChange: (column: LibraryOptionalColumn, visible: boolean) => void;
}) {
  const { t } = useI18n();
  const optionalLabels: Record<LibraryOptionalColumn, string> = {
    map: t('library.table.map'),
    score: t('library.table.result'),
    played: t('library.table.played'),
    duration: t('library.table.duration'),
    rounds: t('library.table.rounds'),
    updated: t('library.table.updated'),
  };
  return (
    <details className="library-column-visibility" data-testid="library-column-visibility">
      <summary><Columns3 size={14} /><span>{t('library.columns.title')}</span><Badge tone="neutral">{visibleColumns.size + 3}</Badge></summary>
      <div className="library-column-visibility__panel">
        <fieldset>
          <legend>{t('library.columns.locked')}</legend>
          {([
            ['status', t('library.table.status')],
            ['file', t('library.table.file')],
            ['actions', t('library.table.actions')],
          ] as const).map(([column, label]) => (
            <label key={column}>
              <input data-column-option={column} type="checkbox" checked disabled readOnly />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>{t('library.columns.optional')}</legend>
          {DEFAULT_LIBRARY_COLUMNS.map((column) => (
            <label key={column}>
              <input
                data-column-option={column}
                type="checkbox"
                checked={visibleColumns.has(column)}
                onChange={(event) => onChange(column, event.target.checked)}
              />
              <span>{optionalLabels[column]}</span>
            </label>
          ))}
        </fieldset>
        <p><Info size={12} />{t('library.columns.sizeUnavailable')}</p>
      </div>
    </details>
  );
}

function hasKnownText(value: string | undefined): value is string {
  return Boolean(value?.trim()) && value?.trim().toLocaleLowerCase() !== 'unknown';
}

function durationValue(demo: DemoSummary): number | null {
  return demo.duration_seconds > 0 ? demo.duration_seconds : null;
}

function roundsValue(demo: DemoSummary): number | null {
  return demo.total_rounds > 0 ? demo.total_rounds : null;
}

function scoreValue(demo: DemoSummary): number | null {
  return hasVerifiedMatchScore(demo) ? (demo.score_team_a ?? 0) + (demo.score_team_b ?? 0) : null;
}

function updatedValue(demo: DemoSummary): number | null {
  if (!demo.updated_at) return null;
  const value = Date.parse(demo.updated_at);
  return Number.isFinite(value) ? value : null;
}

function sortValue(demo: DemoSummary, key: LibrarySortKey): string | number | null {
  switch (key) {
    case 'status': return demo.lifecycle_status;
    case 'file': return demo.filename.trim() || null;
    case 'map': return hasKnownText(demo.map_name) ? demo.map_name : null;
    case 'score': return scoreValue(demo);
    case 'duration': return durationValue(demo);
    case 'rounds': return roundsValue(demo);
    case 'updated': return updatedValue(demo);
  }
}

export function sortLibraryDemos(demos: readonly DemoSummary[], sort: LibrarySort): DemoSummary[] {
  return [...demos].sort((left, right) => {
    const leftValue = sortValue(left, sort.key);
    const rightValue = sortValue(right, sort.key);
    if (leftValue === null && rightValue === null) return left.filename.localeCompare(right.filename);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), currentLocale(), { numeric: true, sensitivity: 'base' });
    return sort.direction === 'asc' ? comparison : -comparison;
  });
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return UNKNOWN_VALUE;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

function formatUpdated(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return UNKNOWN_VALUE;
  return new Intl.DateTimeFormat(currentLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function interpolate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export function LibraryResultScope({
  page,
  pageSize,
  total,
  visible,
}: {
  page: number;
  pageSize: number;
  total: number;
  visible: number;
}) {
  const { t } = useI18n();
  const pages = libraryPageCount(total, pageSize);
  return (
    <div className="library-result-scope" role="status">
      <strong>{interpolate(t('library.table.scope'), { page, pages, total, visible })}</strong>
      <span>{t('library.table.scopeComplete')}</span>
    </div>
  );
}

export function LibraryPagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: (typeof LIBRARY_PAGE_SIZES)[number];
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: (typeof LIBRARY_PAGE_SIZES)[number]) => void;
}) {
  const { t } = useI18n();
  const pages = libraryPageCount(total, pageSize);
  return (
    <nav className="library-pagination" aria-label={t('library.pagination.label')}>
      <Button size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        {t('common.previous')}
      </Button>
      <strong>{interpolate(t('library.pagination.page'), { page, pages })}</strong>
      <Button size="sm" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
        {t('common.next')}
      </Button>
      <label>
        <span>{t('library.pagination.pageSize')}</span>
        <select
          value={pageSize}
          aria-label={t('library.pagination.pageSize')}
          onChange={(event) => onPageSizeChange(Number(event.target.value) as (typeof LIBRARY_PAGE_SIZES)[number])}
        >
          {LIBRARY_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
    </nav>
  );
}

function LibrarySortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: LibrarySortKey;
  sort: LibrarySort;
  onSort: (key: LibrarySortKey) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th data-column={sortKey} scope="col" aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(sortKey)}>
        {label}<span aria-hidden="true">{active ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
      </button>
    </th>
  );
}

function libraryResult(demo: DemoSummary, description: string): string {
  if (hasVerifiedMatchScore(demo)) return `${demo.score_team_a} : ${demo.score_team_b}`;
  return demo.lifecycle_status === 'ready' ? UNKNOWN_VALUE : description;
}

export function LibraryPowerTable({
  demos,
  visibleColumns = new Set(DEFAULT_LIBRARY_COLUMNS),
  selectedIds,
  activeDemoId,
  sort,
  playingDemoId,
  playbackDisabled,
  onSort,
  onToggleSelected,
  onOpenDetails,
  onPlay,
  onLifecycleAction,
}: {
  demos: readonly DemoSummary[];
  visibleColumns?: ReadonlySet<LibraryOptionalColumn>;
  selectedIds: ReadonlySet<string>;
  activeDemoId: string | null;
  sort: LibrarySort;
  playingDemoId: string | null;
  playbackDisabled: boolean;
  onSort: (key: LibrarySortKey) => void;
  onToggleSelected: (demo: DemoSummary) => void;
  onOpenDetails: (demo: DemoSummary) => void;
  onPlay: (demo: DemoSummary) => void;
  onLifecycleAction: (demo: DemoSummary) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="library-power-table__scroll">
      <div className="library-power-table__scroll-hint" data-testid="library-table-scroll-hint">
        <MoveHorizontal size={13} /><span>{t('library.table.horizontalHint')}</span>
      </div>
      <table
        className="library-power-table"
        data-optional-column-count={visibleColumns.size}
        aria-label={t('library.table.label')}
      >
        <thead>
          <tr>
            <th className="library-power-table__select" scope="col"><span className="sr-only">{t('library.table.status')}</span></th>
            <LibrarySortHeader label={t('library.table.status')} sortKey="status" sort={sort} onSort={onSort} />
            <LibrarySortHeader label={t('library.table.file')} sortKey="file" sort={sort} onSort={onSort} />
            {visibleColumns.has('map') ? <LibrarySortHeader label={t('library.table.map')} sortKey="map" sort={sort} onSort={onSort} /> : null}
            {visibleColumns.has('score') ? <LibrarySortHeader label={t('library.table.result')} sortKey="score" sort={sort} onSort={onSort} /> : null}
            {visibleColumns.has('played') ? <th data-column="played" scope="col">{t('library.table.played')}</th> : null}
            {visibleColumns.has('duration') ? <LibrarySortHeader label={t('library.table.duration')} sortKey="duration" sort={sort} onSort={onSort} /> : null}
            {visibleColumns.has('rounds') ? <LibrarySortHeader label={t('library.table.rounds')} sortKey="rounds" sort={sort} onSort={onSort} /> : null}
            {visibleColumns.has('updated') ? <LibrarySortHeader label={t('library.table.updated')} sortKey="updated" sort={sort} onSort={onSort} /> : null}
            <th className="library-power-table__actions" data-column="actions" scope="col">{t('library.table.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {demos.map((demo) => {
            const lifecycle = demoLifecyclePresentation(demo.lifecycle_status);
            const analyzable = isDemoAnalyzable(demo.lifecycle_status);
            return (
              <tr key={demo.id} className={activeDemoId === demo.id ? 'is-active' : undefined} aria-selected={activeDemoId === demo.id}>
                <td className="library-power-table__select">
                  {analyzable ? <input
                    type="checkbox"
                    checked={selectedIds.has(demo.id)}
                    aria-label={demo.display_name}
                    onChange={() => onToggleSelected(demo)}
                  /> : null}
                </td>
                <td data-column="status"><Badge tone={lifecycle.tone}>{t(lifecycle.labelKey)}</Badge></td>
                <td className="library-power-table__file" data-column="file"><strong>{demo.display_name}</strong><span title={demo.filename}>{demo.filename}</span></td>
                {visibleColumns.has('map') ? <td className="library-power-table__mono" data-column="map">{hasKnownText(demo.map_name) ? demo.map_name : UNKNOWN_VALUE}</td> : null}
                {visibleColumns.has('score') ? <td className={hasVerifiedMatchScore(demo) ? 'library-power-table__score' : 'library-power-table__reason'} data-column="score">
                  {libraryResult(demo, t(lifecycle.descriptionKey))}
                </td> : null}
                {visibleColumns.has('played') ? <td
                  className="library-power-table__updated"
                  data-column="played"
                  title={t('library.matchDate.catalogedAt').replace(
                    '{date}',
                    formatUpdated(demo.cataloged_at),
                  )}
                >{demo.match_date
                    ? formatUpdated(demo.match_date)
                    : t('library.matchDate.unavailable')}</td> : null}
                {visibleColumns.has('duration') ? <td className="library-power-table__mono" data-column="duration">{formatDuration(demo.duration_seconds)}</td> : null}
                {visibleColumns.has('rounds') ? <td className="library-power-table__mono" data-column="rounds">{demo.total_rounds > 0 ? demo.total_rounds : UNKNOWN_VALUE}</td> : null}
                {visibleColumns.has('updated') ? <td className="library-power-table__updated" data-column="updated">{formatUpdated(demo.updated_at)}</td> : null}
                <td className="library-power-table__actions" data-column="actions">
                  <Button
                    size="sm"
                    disabled={demo.status !== 'ready' || playingDemoId !== null || playbackDisabled}
                    onClick={() => onPlay(demo)}
                  >
                    {playingDemoId === demo.id ? <Spinner /> : <Play size={13} />}{t('library.inspector.watch')}
                  </Button>
                  {lifecycle.actionKey ? <Button size="sm" variant="primary" disabled={!lifecycle.enabled} onClick={() => onLifecycleAction(demo)}>
                    <Sparkles size={13} />{t(lifecycle.actionKey)}
                  </Button> : null}
                  <IconButton label={t('library.table.details')} onClick={() => onOpenDetails(demo)}><MoreHorizontal size={15} /></IconButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function LibraryDemoInspector({
  demo,
  playing,
  playbackDisabled,
  revealDisabled,
  onPlay,
  onLifecycleAction,
  onReveal,
}: {
  demo: DemoSummary;
  playing: boolean;
  playbackDisabled: boolean;
  revealDisabled: boolean;
  onPlay: (demo: DemoSummary) => void;
  onLifecycleAction: (demo: DemoSummary) => void;
  onReveal: (demo: DemoSummary) => void;
}) {
  const { t } = useI18n();
  const lifecycle = demoLifecyclePresentation(demo.lifecycle_status);
  return (
    <Card className="library-demo-inspector" role="complementary" aria-label={t('library.inspector.title')}>
      <header>
        <div><span className="eyebrow">DEMO INSPECTOR</span><h2>{demo.display_name}</h2><p>{demo.filename}</p></div>
        <Badge tone={lifecycle.tone}>{t(lifecycle.labelKey)}</Badge>
      </header>
      <dl className="library-demo-inspector__facts">
        <div><dt>{t('library.table.map')}</dt><dd>{hasKnownText(demo.map_name) ? demo.map_name : UNKNOWN_VALUE}</dd></div>
        <div><dt>{t('library.table.result')}</dt><dd>{libraryResult(demo, t(lifecycle.descriptionKey))}</dd></div>
        <div><dt>{t('library.table.duration')}</dt><dd>{formatDuration(demo.duration_seconds)}</dd></div>
        <div><dt>{t('library.table.rounds')}</dt><dd>{demo.total_rounds > 0 ? demo.total_rounds : UNKNOWN_VALUE}</dd></div>
        <div><dt>{t('library.inspector.updated')}</dt><dd>{formatUpdated(demo.updated_at)}</dd></div>
      </dl>
      <div className="library-demo-inspector__actions">
        <Button disabled={demo.status !== 'ready' || playbackDisabled} onClick={() => onPlay(demo)}>
          {playing ? <Spinner /> : <Play size={14} />}{t('library.inspector.watch')}
        </Button>
        {lifecycle.actionKey ? <Button variant="primary" disabled={!lifecycle.enabled} onClick={() => onLifecycleAction(demo)}>
          <Sparkles size={14} />{t(lifecycle.actionKey)}
        </Button> : null}
        <Button
          disabled={revealDisabled}
          title={revealDisabled ? t('library.inspector.revealUnavailable') : undefined}
          onClick={() => onReveal(demo)}
        >
          <FolderOpen size={14} />{t('library.inspector.reveal')}
        </Button>
      </div>
    </Card>
  );
}
