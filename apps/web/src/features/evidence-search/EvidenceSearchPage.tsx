import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Database,
  Filter,
  Map as MapIcon,
  MessageSquareText,
  Play,
  RotateCcw,
  Search,
  Target,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import type {
  EvidenceSearchEventFamily,
  EvidenceSearchItem,
  EvidenceSearchQuery,
  EvidenceSearchResponse,
} from '../../shared/desktop/dto';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { useI18n } from '../../shared/i18n';
import { runManagedPlaybackLaunch, useRuntimeStore } from '../../shared/stores/runtimeStore';
import { Badge, Button, EmptyState, Notice, Spinner } from '../../shared/ui';
import {
  evidenceSearchParameters,
  evidenceSearchQueryFromParameters,
  evidenceSearchResultHref,
  visibleEvidenceAttributes,
} from './evidenceSearchPresentation';
import { EvidenceAnnotationPanel } from './EvidenceAnnotationPanel';
import { EvidenceAnnotationIndexPage } from './EvidenceAnnotationIndexPage';
import { EvidenceSearchSectionNav } from './EvidenceSearchSectionNav';
import './EvidenceSearchPage.css';

type SearchState =
  | { status: 'loading'; response: null; error: null }
  | { status: 'ready'; response: EvidenceSearchResponse; error: null }
  | { status: 'error'; response: null; error: string };

type SearchDraft = {
  q: string;
  eventFamily: '' | EvidenceSearchEventFamily;
  actor: string;
  victim: string;
  player: string;
  weapon: string;
  map: string;
  source: string;
  sourceKind: '' | 'event' | 'highlight';
  headshot: '' | 'true' | 'false';
  round: string;
  dateFrom: string;
  dateTo: string;
};

function draftFromQuery(query: EvidenceSearchQuery): SearchDraft {
  return {
    q: query.q ?? '',
    eventFamily: query.event_family ?? '',
    actor: query.actor ?? '',
    victim: query.victim ?? '',
    player: query.player ?? '',
    weapon: query.weapon ?? '',
    map: query.map ?? '',
    source: query.source ?? '',
    sourceKind: query.source_kind ?? '',
    headshot: query.headshot === undefined ? '' : String(query.headshot) as 'true' | 'false',
    round: query.round === undefined ? '' : String(query.round),
    dateFrom: query.match_date_from?.slice(0, 10) ?? '',
    dateTo: query.match_date_to?.slice(0, 10) ?? '',
  };
}

export function queryFromDraft(draft: SearchDraft): EvidenceSearchQuery {
  const round = Number(draft.round);
  if (draft.round && (!Number.isSafeInteger(round) || round < 1 || round > 256)) {
    throw new Error('Round must be between 1 and 256');
  }
  return {
    ...(draft.q.trim() ? { q: draft.q.trim() } : {}),
    ...(draft.eventFamily ? { event_family: draft.eventFamily } : {}),
    ...(draft.actor.trim() ? { actor: draft.actor.trim() } : {}),
    ...(draft.victim.trim() ? { victim: draft.victim.trim() } : {}),
    ...(draft.player.trim() ? { player: draft.player.trim() } : {}),
    ...(draft.weapon.trim() ? { weapon: draft.weapon.trim() } : {}),
    ...(draft.map.trim() ? { map: draft.map.trim() } : {}),
    ...(draft.source.trim() ? { source: draft.source.trim() } : {}),
    ...(draft.sourceKind ? { source_kind: draft.sourceKind } : {}),
    ...(draft.headshot ? { headshot: draft.headshot === 'true' } : {}),
    ...(draft.round ? { round } : {}),
    ...(draft.dateFrom ? { match_date_from: `${draft.dateFrom}T00:00:00Z` } : {}),
    ...(draft.dateTo ? { match_date_to: `${draft.dateTo}T23:59:59Z` } : {}),
    page: 1,
    page_size: 50,
  };
}

function eventTone(item: EvidenceSearchItem) {
  if (item.event_type === 'kill') return 'danger' as const;
  if (item.source_kind === 'highlight') return 'accent' as const;
  if (item.event_type.startsWith('bomb_')) return 'warning' as const;
  return 'neutral' as const;
}

export function EvidenceSearchPage() {
  const [parameters] = useSearchParams();
  return parameters.has('view') ? <EvidenceAnnotationIndexPage /> : <EvidenceSearchWorkbench />;
}

function EvidenceSearchWorkbench() {
  const { locale, t } = useI18n();
  const [parameters, setParameters] = useSearchParams();
  const parameterKey = parameters.toString();
  const activeQuery = useMemo(() => {
    const parsed = evidenceSearchQueryFromParameters(new URLSearchParams(parameterKey));
    return { ...parsed, page: parsed.page ?? 1, page_size: parsed.page_size ?? 50 };
  }, [parameterKey]);
  const [draft, setDraft] = useState<SearchDraft>(() => draftFromQuery(activeQuery));
  const [state, setState] = useState<SearchState>({ status: 'loading', response: null, error: null });
  const [annotationItem, setAnnotationItem] = useState<EvidenceSearchItem | null>(null);
  const watchAction = useAsyncAction<unknown>();
  const runtimeBusy = useRuntimeStore((runtime) => runtime.session !== 'idle');

  useEffect(() => {
    setDraft(draftFromQuery(activeQuery));
    const controller = new AbortController();
    let active = true;
    setState({ status: 'loading', response: null, error: null });
    void commands.searchEvidence(activeQuery, controller.signal)
      .then((response) => {
        if (active) setState({ status: 'ready', response, error: null });
      })
      .catch((cause: unknown) => {
        if (active && !controller.signal.aborted) {
          setState({ status: 'error', response: null, error: readableError(cause) });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [parameterKey]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setParameters(evidenceSearchParameters(queryFromDraft(draft)));
  };
  const reset = () => setParameters(new URLSearchParams());
  const goToPage = (page: number) => setParameters(evidenceSearchParameters({
    ...activeQuery,
    page,
    page_size: activeQuery.page_size ?? 50,
  }));
  const watch = (item: EvidenceSearchItem) => {
    void watchAction.run(
      () => runManagedPlaybackLaunch(() => commands.playDemo(item.demo_id, { start_tick: item.tick })),
    );
  };
  const response = state.response;
  const page = response?.page ?? activeQuery.page ?? 1;
  const pageSize = response?.page_size ?? activeQuery.page_size ?? 50;
  const pageCount = response ? Math.max(1, Math.ceil(response.total / pageSize)) : 1;
  const formatDate = (value: string | null) => {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? '—'
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(parsed);
  };

  return (
    <div className="page page--evidence-search" data-testid="evidence-search-page">
      <header className="evidence-search-header">
        <div>
          <EvidenceSearchSectionNav active="evidence" />
          <span className="eyebrow">{t('evidenceSearch.eyebrow')}</span>
          <h1>{t('evidenceSearch.title')}</h1>
          <p>{t('evidenceSearch.description')}</p>
        </div>
        <div className="evidence-search-header__facts" aria-live="polite">
          <span><Database size={15} />{response ? `${response.availability.indexed_items} ${t('evidenceSearch.indexedCount')} · ${response.availability.indexed_demos} ${t('evidenceSearch.demosIndexed')}` : '—'}</span>
          <strong>{response?.total ?? '—'}</strong><small>{t('evidenceSearch.resultCount')}</small>
        </div>
      </header>

      <div className="evidence-search-workbench">
        <form className="evidence-search-filters" onSubmit={submit} data-testid="evidence-search-filters">
          <header><Filter size={15} /><strong>{t('evidenceSearch.search')}</strong></header>
          <label className="evidence-search-filters__wide">
            <span>{t('evidenceSearch.query')}</span>
            <div className="evidence-search-input"><Search size={14} /><input value={draft.q} maxLength={128} placeholder={t('evidenceSearch.queryPlaceholder')} onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))} /></div>
          </label>
          <label><span>{t('evidenceSearch.event')}</span><select value={draft.eventFamily} onChange={(event) => setDraft((current) => ({ ...current, eventFamily: event.target.value as SearchDraft['eventFamily'] }))}><option value="">{t('evidenceSearch.allEvents')}</option><option value="kill">{t('evidenceSearch.kills')}</option><option value="multi_kill">{t('evidenceSearch.multiKills')}</option><option value="objective">{t('evidenceSearch.objectives')}</option><option value="round_start">{t('evidenceSearch.roundStarts')}</option></select></label>
          <label><span>{t('evidenceSearch.actor')}</span><input value={draft.actor} maxLength={128} onChange={(event) => setDraft((current) => ({ ...current, actor: event.target.value }))} /></label>
          <label><span>{t('evidenceSearch.victim')}</span><input value={draft.victim} maxLength={128} onChange={(event) => setDraft((current) => ({ ...current, victim: event.target.value }))} /></label>
          <label><span>{t('evidenceSearch.player')}</span><input value={draft.player} maxLength={128} onChange={(event) => setDraft((current) => ({ ...current, player: event.target.value }))} /></label>
          <label><span>{t('evidenceSearch.weapon')}</span><input value={draft.weapon} maxLength={128} onChange={(event) => setDraft((current) => ({ ...current, weapon: event.target.value }))} /></label>
          <label><span>{t('evidenceSearch.map')}</span><input value={draft.map} maxLength={128} placeholder="de_mirage" onChange={(event) => setDraft((current) => ({ ...current, map: event.target.value }))} /></label>
          <label><span>{t('evidenceSearch.source')}</span><input value={draft.source} maxLength={128} onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value }))} /></label>
          <label><span>{t('evidenceSearch.evidence')}</span><select value={draft.sourceKind} onChange={(event) => setDraft((current) => ({ ...current, sourceKind: event.target.value as SearchDraft['sourceKind'] }))}><option value="">{t('evidenceSearch.any')}</option><option value="event">{t('evidenceSearch.sourceKindEvent')}</option><option value="highlight">{t('evidenceSearch.sourceKindHighlight')}</option></select></label>
          <label><span>{t('evidenceSearch.headshot')}</span><select value={draft.headshot} onChange={(event) => setDraft((current) => ({ ...current, headshot: event.target.value as SearchDraft['headshot'] }))}><option value="">{t('evidenceSearch.any')}</option><option value="true">{t('evidenceSearch.yes')}</option><option value="false">{t('evidenceSearch.no')}</option></select></label>
          <label><span>{t('evidenceSearch.round')}</span><input type="number" min={1} max={256} value={draft.round} onChange={(event) => setDraft((current) => ({ ...current, round: event.target.value }))} /></label>
          <label><span>{t('evidenceSearch.from')}</span><input type="date" value={draft.dateFrom} onChange={(event) => setDraft((current) => ({ ...current, dateFrom: event.target.value }))} /></label>
          <label><span>{t('evidenceSearch.to')}</span><input type="date" value={draft.dateTo} onChange={(event) => setDraft((current) => ({ ...current, dateTo: event.target.value }))} /></label>
          <footer><Button type="button" variant="ghost" onClick={reset}><RotateCcw size={14} />{t('evidenceSearch.reset')}</Button><Button type="submit"><Search size={14} />{t('evidenceSearch.search')}</Button></footer>
        </form>

        <section className="evidence-search-results" data-testid="evidence-search-results" aria-busy={state.status === 'loading'}>
          <header>
            <div><span className="eyebrow">{t('evidenceSearch.indexResults')}</span><h2>{t('evidenceSearch.results')}</h2></div>
            {response ? <Badge tone="neutral">{response.total} {t('evidenceSearch.resultCount')}</Badge> : null}
          </header>
          {watchAction.state.status === 'error' ? <Notice tone="danger">{watchAction.state.message}</Notice> : null}
          {response && !response.availability.scan_complete ? <Notice tone="info">{t('evidenceSearch.scanIncomplete')}</Notice> : null}
          {response?.availability.match_date.reason ? <Notice tone="info">{t('evidenceSearch.dateUnavailable')}</Notice> : null}
          {response?.availability.source.reason ? <Notice tone="info">{t('evidenceSearch.sourceUnavailable')}</Notice> : null}
          {state.status === 'loading' ? <div className="evidence-search-loading" role="status"><Spinner /><span>{t('evidenceSearch.searching')}</span></div> : null}
          {state.status === 'error' ? <Notice tone="danger">{state.error}</Notice> : null}
          {state.status === 'ready' && response?.items.length === 0 ? <EmptyState icon={<Search size={22} />} title={response.availability.indexed_items === 0 ? t('evidenceSearch.unindexedTitle') : t('evidenceSearch.emptyTitle')} description={response.availability.indexed_items === 0 ? t('evidenceSearch.unindexedDescription') : t('evidenceSearch.emptyDescription')} /> : null}
          {state.status === 'ready' && response && response.items.length > 0 ? (
            <div className="evidence-search-table" role="table" aria-rowcount={response.total}>
              <div className="evidence-search-table__head" role="row"><span role="columnheader">{t('evidenceSearch.evidence')}</span><span role="columnheader">{t('evidenceSearch.match')}</span><span role="columnheader">{t('evidenceSearch.round')}</span><span role="columnheader">{t('evidenceSearch.attributes')}</span><span role="columnheader" /></div>
              {response.items.map((item, index) => {
                const attributes = visibleEvidenceAttributes(item);
                return (
                  <article className="evidence-search-row" role="row" aria-rowindex={((page - 1) * pageSize) + index + 1} data-evidence-id={item.evidence_id} key={item.evidence_id}>
                    <div className="evidence-search-row__event" role="cell"><span className="evidence-search-row__icon"><Crosshair size={14} /></span><span><Badge tone={eventTone(item)}>{item.event_type.replaceAll('_', ' ')}</Badge><strong>{item.actor_name ?? '—'}{item.target_name ? ` → ${item.target_name}` : ''}</strong><small>{item.weapon?.toLocaleUpperCase() ?? item.source_kind.toLocaleUpperCase()}</small></span></div>
                    <div className="evidence-search-row__match" role="cell"><strong>{item.demo_display_name}</strong><span><MapIcon size={11} />{item.map_name.replace('de_', '').toLocaleUpperCase()}</span><small><CalendarDays size={11} />{formatDate(item.match_date)}</small></div>
                    <div className="evidence-search-row__tick" role="cell"><strong>R{item.round}</strong><span>tick {item.tick.toLocaleString(locale)}</span>{item.end_tick > item.tick ? <small>→ {item.end_tick.toLocaleString(locale)}</small> : null}</div>
                    <div className="evidence-search-row__attributes" role="cell">{attributes.length > 0 ? attributes.map((attribute) => <Badge key={attribute} tone="neutral">{t(attribute === 'headshot' ? 'evidenceSearch.headshotAttribute' : 'evidenceSearch.penetratedAttribute')}</Badge>) : <span>—</span>}</div>
                    <div className="evidence-search-row__actions" role="cell"><Button size="sm" variant="ghost" onClick={() => setAnnotationItem(item)}><MessageSquareText size={13} /><span>{t('evidenceSearch.annotations')}</span></Button><Button size="sm" variant="ghost" disabled={runtimeBusy || watchAction.state.status === 'loading'} onClick={() => watch(item)}><Play size={13} /><span>{t('evidenceSearch.watch')}</span></Button><Link className="button button--secondary button--sm" to={evidenceSearchResultHref(item, 'rounds')}><Target size={13} /><span>{t('evidenceSearch.openRound')}</span></Link><Link className="button button--secondary button--sm" to={evidenceSearchResultHref(item, 'replay')}><MapIcon size={13} /><span>{t('evidenceSearch.openReplay')}</span></Link></div>
                  </article>
                );
              })}
            </div>
          ) : null}
          {state.status === 'ready' && response && response.total > 0 ? <footer className="evidence-search-pagination"><Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => goToPage(page - 1)}><ChevronLeft size={14} />{t('evidenceSearch.previous')}</Button><span>{t('evidenceSearch.page')} <strong>{page}</strong> / {pageCount}</span><Button variant="ghost" size="sm" disabled={page >= pageCount} onClick={() => goToPage(page + 1)}>{t('evidenceSearch.next')}<ChevronRight size={14} /></Button></footer> : null}
        </section>
      </div>
      {annotationItem ? <EvidenceAnnotationPanel item={annotationItem} onClose={() => setAnnotationItem(null)} /> : null}
    </div>
  );
}
