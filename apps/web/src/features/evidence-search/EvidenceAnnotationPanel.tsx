import { CheckCircle2, MessageSquareText, RotateCcw, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

import { commands, readableError } from '../../shared/desktop/client';
import type { EvidenceAnnotation, EvidenceSearchItem } from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, Drawer, EmptyState, Notice, Spinner } from '../../shared/ui';

type AnnotationState =
  | { status: 'loading'; items: EvidenceAnnotation[]; error: null }
  | { status: 'ready'; items: EvidenceAnnotation[]; error: null }
  | { status: 'error'; items: EvidenceAnnotation[]; error: string };

export function EvidenceAnnotationPanel({
  item,
  onClose,
}: {
  item: EvidenceSearchItem;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const [state, setState] = useState<AnnotationState>({
    status: 'loading', items: [], error: null,
  });
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const load = (signal?: AbortSignal) => {
    setState((current) => ({ status: 'loading', items: current.items, error: null }));
    void commands.listEvidenceAnnotations({
      evidence_id: item.evidence_id,
      page: 1,
      page_size: 100,
    }, signal).then((page) => {
      setState({ status: 'ready', items: page.items, error: null });
    }).catch((cause: unknown) => {
      if (!signal?.aborted) {
        setState((current) => ({
          status: 'error', items: current.items, error: readableError(cause),
        }));
      }
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [item.evidence_id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMutationError(null);
    try {
      const annotation = await commands.createEvidenceAnnotation({
        demo_id: item.demo_id,
        evidence_id: item.evidence_id,
        round: item.round,
        tick: item.tick,
        body,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      });
      setState((current) => ({
        status: 'ready', items: [annotation, ...current.items], error: null,
      }));
      setBody('');
      setTags('');
    } catch (cause) {
      setMutationError(readableError(cause));
    } finally {
      setPending(false);
    }
  };

  const setReviewState = async (annotation: EvidenceAnnotation) => {
    setPending(true);
    setMutationError(null);
    try {
      const updated = await commands.updateEvidenceAnnotation(annotation.id, {
        body: annotation.body,
        tags: annotation.tags,
        review_state: annotation.review_state === 'open' ? 'resolved' : 'open',
      });
      setState((current) => ({
        status: 'ready',
        items: current.items.map((candidate) => candidate.id === updated.id ? updated : candidate),
        error: null,
      }));
    } catch (cause) {
      setMutationError(readableError(cause));
    } finally {
      setPending(false);
    }
  };

  const remove = async (annotation: EvidenceAnnotation) => {
    setPending(true);
    setMutationError(null);
    try {
      await commands.deleteEvidenceAnnotation(annotation.id);
      setState((current) => ({
        status: 'ready',
        items: current.items.filter((candidate) => candidate.id !== annotation.id),
        error: null,
      }));
    } catch (cause) {
      setMutationError(readableError(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Drawer
      open
      title={t('evidenceSearch.annotationTitle')}
      description={`${item.demo_display_name} · R${item.round} · tick ${item.tick.toLocaleString(locale)}`}
      onClose={onClose}
    >
      <div
        className="evidence-annotations"
        data-testid="evidence-annotation-panel"
        data-evidence-id={item.evidence_id}
      >
        <form className="evidence-annotations__composer" onSubmit={(event) => void submit(event)}>
          <label>
            <span>{t('evidenceSearch.annotationBody')}</span>
            <textarea
              name="annotation-body"
              required
              maxLength={4_000}
              value={body}
              placeholder={t('evidenceSearch.annotationBodyPlaceholder')}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <label>
            <span>{t('evidenceSearch.annotationTags')}</span>
            <input
              name="annotation-tags"
              value={tags}
              placeholder={t('evidenceSearch.annotationTagsPlaceholder')}
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={pending || body.trim().length === 0}>
            <MessageSquareText size={14} />{t('evidenceSearch.saveAnnotation')}
          </Button>
        </form>

        {mutationError ? <Notice tone="danger">{mutationError}</Notice> : null}
        {state.status === 'loading' && state.items.length === 0
          ? <div className="evidence-annotations__loading" role="status"><Spinner />{t('evidenceSearch.annotationsLoading')}</div>
          : null}
        {state.status === 'error'
          ? <Notice tone="danger"><span>{state.error}</span><Button size="sm" variant="ghost" onClick={() => load()}>{t('evidenceSearch.retryAnnotations')}</Button></Notice>
          : null}
        {state.status === 'ready' && state.items.length === 0
          ? <EmptyState icon={<MessageSquareText size={20} />} title={t('evidenceSearch.noAnnotations')} description={t('evidenceSearch.noAnnotationsDescription')} />
          : null}

        <div className="evidence-annotations__list">
          {state.items.map((annotation) => (
            <article key={annotation.id} data-review-state={annotation.review_state}>
              <header>
                <Badge tone={annotation.review_state === 'open' ? 'warning' : 'success'}>
                  {t(annotation.review_state === 'open' ? 'evidenceSearch.reviewOpen' : 'evidenceSearch.reviewResolved')}
                </Badge>
                <time dateTime={annotation.updated_at}>
                  {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(annotation.updated_at))}
                </time>
              </header>
              <p>{annotation.body}</p>
              {annotation.tags.length > 0 ? <div>{annotation.tags.map((tag) => <Badge key={tag} tone="neutral">{tag}</Badge>)}</div> : null}
              <footer>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => void setReviewState(annotation)}>
                  {annotation.review_state === 'open' ? <CheckCircle2 size={13} /> : <RotateCcw size={13} />}
                  {t(annotation.review_state === 'open' ? 'evidenceSearch.resolveAnnotation' : 'evidenceSearch.reopenAnnotation')}
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => void remove(annotation)}>
                  <Trash2 size={13} />{t('evidenceSearch.deleteAnnotation')}
                </Button>
              </footer>
            </article>
          ))}
        </div>
      </div>
    </Drawer>
  );
}
