import {
  ChevronLeft,
  ChevronRight,
  Filter,
  Map as MapIcon,
  MessageSquareText,
  RotateCcw,
  Search,
  Target,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import type {
  EvidenceAnnotation,
  EvidenceAnnotationQuery,
  EvidenceAnnotationReviewState,
  Paginated,
} from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, EmptyState, Notice, Spinner } from '../../shared/ui';
import {
  evidenceAnnotationAnalysisHref,
  evidenceAnnotationIndexParameters,
  readEvidenceAnnotationIndexParameters,
} from './evidenceAnnotationIndexPresentation';
import { EvidenceSearchSectionNav } from './EvidenceSearchSectionNav';

type AnnotationIndexState =
  | { status: 'loading'; page: null; error: null }
  | { status: 'ready'; page: Paginated<EvidenceAnnotation>; error: null }
  | { status: 'error'; page: null; error: string };

type AnnotationFilterDraft = {
  q: string;
  tag: string;
  state: '' | EvidenceAnnotationReviewState;
};

function draftFromQuery(query: EvidenceAnnotationQuery): AnnotationFilterDraft {
  return {
    q: query.q ?? '',
    tag: query.tag ?? '',
    state: query.state ?? '',
  };
}

function queryFromDraft(draft: AnnotationFilterDraft): EvidenceAnnotationQuery {
  return {
    ...(draft.q.trim() ? { q: draft.q.trim() } : {}),
    ...(draft.tag.trim() ? { tag: draft.tag.trim() } : {}),
    ...(draft.state ? { state: draft.state } : {}),
    page: 1,
    page_size: 50,
  };
}

export function EvidenceAnnotationIndexPage() {
  const { t } = useI18n();
  const [parameters, setParameters] = useSearchParams();
  const parameterKey = parameters.toString();
  const parsed = useMemo(
    () => readEvidenceAnnotationIndexParameters(new URLSearchParams(parameterKey)),
    [parameterKey],
  );
  const parsedQuery = parsed.status === 'ready' ? parsed.query : {};
  const [draft, setDraft] = useState<AnnotationFilterDraft>(() => draftFromQuery(parsedQuery));
  const [state, setState] = useState<AnnotationIndexState>({ status: 'loading', page: null, error: null });

  useEffect(() => {
    if (parsed.status === 'invalid') return undefined;
    const query = {
      ...parsed.query,
      page: parsed.query.page ?? 1,
      page_size: parsed.query.page_size ?? 50,
    };
    setDraft(draftFromQuery(query));
    setState({ status: 'loading', page: null, error: null });
    const controller = new AbortController();
    let active = true;
    void commands.listEvidenceAnnotations(query, controller.signal)
      .then((page) => {
        if (active) setState({ status: 'ready', page, error: null });
      })
      .catch((cause: unknown) => {
        if (active && !controller.signal.aborted) {
          setState({ status: 'error', page: null, error: readableError(cause) });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [parameterKey]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setParameters(evidenceAnnotationIndexParameters(queryFromDraft(draft)));
  };
  const reset = () => setParameters(new URLSearchParams({ view: 'annotations' }));
  const goToPage = (page: number) => {
    if (parsed.status === 'invalid') return;
    setParameters(evidenceAnnotationIndexParameters({
      ...parsed.query,
      page,
      page_size: parsed.query.page_size ?? 50,
    }));
  };

  return (
    <div className="page page--evidence-search page--evidence-annotation-index" data-testid="evidence-annotation-index-page">
      <header className="evidence-search-header">
        <div>
          <EvidenceSearchSectionNav active="annotations" />
          <span className="eyebrow">{t('evidenceSearch.eyebrow')}</span>
          <h1>{t('evidenceSearch.annotations')}</h1>
          <p>{t('evidenceSearch.noAnnotationsDescription')}</p>
        </div>
        <div className="evidence-search-header__facts" aria-live="polite">
          <span><MessageSquareText size={15} />{t('evidenceSearch.annotations')}</span>
          <strong>{state.page?.total ?? '—'}</strong><small>{t('evidenceSearch.resultCount')}</small>
        </div>
      </header>

      <div className="evidence-search-workbench" data-testid="evidence-annotation-index-workspace">
        <form className="evidence-search-filters" onSubmit={submit} data-testid="evidence-annotation-index-filters">
          <header><Filter size={15} /><strong>{t('evidenceSearch.search')}</strong></header>
          <label className="evidence-search-filters__wide">
            <span>{t('evidenceSearch.query')}</span>
            <div className="evidence-search-input"><Search size={14} /><input name="annotation-q" value={draft.q} maxLength={256} placeholder={t('evidenceSearch.queryPlaceholder')} onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))} /></div>
          </label>
          <label className="evidence-search-filters__wide"><span>{t('evidenceSearch.annotationTags')}</span><input name="annotation-tag" value={draft.tag} maxLength={64} placeholder={t('evidenceSearch.annotationTagsPlaceholder')} onChange={(event) => setDraft((current) => ({ ...current, tag: event.target.value }))} /></label>
          <label className="evidence-search-filters__wide"><span>{t('evidenceSearch.annotations')}</span><select name="annotation-state" value={draft.state} onChange={(event) => setDraft((current) => ({ ...current, state: event.target.value as AnnotationFilterDraft['state'] }))}><option value="">{t('evidenceSearch.any')}</option><option value="open">{t('evidenceSearch.reviewOpen')}</option><option value="resolved">{t('evidenceSearch.reviewResolved')}</option></select></label>
          <footer><Button type="button" variant="ghost" onClick={reset}><RotateCcw size={14} />{t('evidenceSearch.reset')}</Button><Button type="submit"><Search size={14} />{t('evidenceSearch.search')}</Button></footer>
        </form>

        <section className="evidence-search-results" data-testid="evidence-annotation-index-results-workspace" aria-busy={parsed.status === 'ready' && state.status === 'loading'}>
          <header><div><span className="eyebrow">{t('evidenceSearch.indexResults')}</span><h2>{t('evidenceSearch.annotations')}</h2></div>{state.page ? <Badge tone="neutral">{state.page.total} {t('evidenceSearch.resultCount')}</Badge> : null}</header>
          {parsed.status === 'invalid' ? <Notice tone="danger">{parsed.error}</Notice> : null}
          {parsed.status === 'ready' && state.status === 'loading' ? <div className="evidence-search-loading" role="status"><Spinner /><span>{t('evidenceSearch.annotationsLoading')}</span></div> : null}
          {parsed.status === 'ready' && state.status === 'error' ? <Notice tone="danger">{state.error}</Notice> : null}
          {parsed.status === 'ready' && state.status === 'ready' ? <EvidenceAnnotationIndexResults page={state.page} onPage={goToPage} /> : null}
        </section>
      </div>
    </div>
  );
}

export function EvidenceAnnotationIndexResults({
  page,
  onPage,
}: {
  page: Paginated<EvidenceAnnotation>;
  onPage: (page: number) => void;
}) {
  const { locale, t } = useI18n();
  const pageCount = Math.max(1, Math.ceil(page.total / page.page_size));

  if (page.items.length === 0) {
    return (
      <EmptyState
        icon={<MessageSquareText size={22} />}
        title={t('evidenceSearch.noAnnotations')}
        description={t('evidenceSearch.noAnnotationsDescription')}
      />
    );
  }

  return (
    <div className="evidence-annotation-index-results" data-testid="evidence-annotation-index-results">
      <div className="evidence-annotation-index-list">
        {page.items.map((annotation) => (
          <article
            data-annotation-id={annotation.id}
            data-review-state={annotation.review_state}
            key={annotation.id}
          >
            <header>
              <Badge tone={annotation.review_state === 'open' ? 'warning' : 'success'}>
                {t(annotation.review_state === 'open' ? 'evidenceSearch.reviewOpen' : 'evidenceSearch.reviewResolved')}
              </Badge>
              <time dateTime={annotation.updated_at}>
                {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(annotation.updated_at))}
              </time>
            </header>
            <p>{annotation.body}</p>
            {annotation.tags.length > 0
              ? <div className="evidence-annotation-index-row__tags">{annotation.tags.map((tag) => <Badge key={tag} tone="neutral">{tag}</Badge>)}</div>
              : null}
            <div className="evidence-annotation-index-row__locator">
              <code>{annotation.demo_id}</code>
              <strong>R{annotation.round}</strong>
              <span>tick {annotation.tick.toLocaleString(locale)}</span>
              <code>{annotation.evidence_id}</code>
            </div>
            <footer>
              <Link className="button button--secondary button--sm" to={evidenceAnnotationAnalysisHref(annotation, 'rounds')}>
                <Target size={13} />{t('evidenceSearch.openRound')}
              </Link>
              <Link className="button button--secondary button--sm" to={evidenceAnnotationAnalysisHref(annotation, 'replay')}>
                <MapIcon size={13} />{t('evidenceSearch.openReplay')}
              </Link>
            </footer>
          </article>
        ))}
      </div>
      <footer className="evidence-search-pagination">
        <Button variant="ghost" size="sm" disabled={page.page <= 1} onClick={() => onPage(page.page - 1)}>
          <ChevronLeft size={14} />{t('evidenceSearch.previous')}
        </Button>
        <span>{t('evidenceSearch.page')} <strong>{page.page}</strong> / {pageCount}</span>
        <Button variant="ghost" size="sm" disabled={page.page >= pageCount} onClick={() => onPage(page.page + 1)}>
          {t('evidenceSearch.next')}<ChevronRight size={14} />
        </Button>
      </footer>
    </div>
  );
}
