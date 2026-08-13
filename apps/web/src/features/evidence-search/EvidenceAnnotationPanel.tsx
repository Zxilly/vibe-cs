import { CheckCircle2, MessageSquareText, Pencil, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { commands, readableError } from '../../shared/desktop/client';
import type {
  EvidenceAnnotation,
  EvidenceSearchItem,
  UpdateEvidenceAnnotation,
} from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, Drawer, EmptyState, Notice, Spinner } from '../../shared/ui';

type AnnotationState =
  | { status: 'loading'; items: EvidenceAnnotation[]; error: null }
  | { status: 'ready'; items: EvidenceAnnotation[]; error: null }
  | { status: 'error'; items: EvidenceAnnotation[]; error: string };

export type EvidenceAnnotationDraft = { body: string; tags: string };

type PendingAnnotationAction =
  | { kind: 'create'; annotationId: null }
  | { kind: 'edit' | 'state' | 'delete'; annotationId: string };

export function arbitrateEvidenceAnnotationRequests() {
  let generation = 0;
  return {
    async acceptCurrentList<T>(request: Promise<T>): Promise<T | null> {
      const requestGeneration = ++generation;
      try {
        const value = await request;
        return requestGeneration === generation ? value : null;
      } catch (cause) {
        if (requestGeneration !== generation) return null;
        throw cause;
      }
    },
    mutationSucceeded() {
      generation += 1;
    },
  };
}

export function evidenceAnnotationUpdate(
  annotation: EvidenceAnnotation,
  draft: EvidenceAnnotationDraft,
): UpdateEvidenceAnnotation {
  return {
    body: draft.body,
    tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    review_state: annotation.review_state,
  };
}

export async function completeEvidenceAnnotationMutation<T>(
  mutation: Promise<T>,
  acceptPersisted: (value: T) => void,
  onChanged: () => void,
): Promise<T> {
  const persisted = await mutation;
  try {
    acceptPersisted(persisted);
  } finally {
    onChanged();
  }
  return persisted;
}

export function EvidenceAnnotationRecord({
  annotation,
  draft,
  pendingAction,
  interactionLocked = false,
  onBeginEdit,
  onChangeDraft,
  onSubmitEdit,
  onCancelEdit,
  onToggleState,
  onRemove,
}: {
  annotation: EvidenceAnnotation;
  draft: EvidenceAnnotationDraft | null;
  pendingAction: PendingAnnotationAction | null;
  interactionLocked?: boolean;
  onBeginEdit: (annotation: EvidenceAnnotation) => void;
  onChangeDraft: (draft: EvidenceAnnotationDraft) => void;
  onSubmitEdit: (annotation: EvidenceAnnotation) => void;
  onCancelEdit: () => void;
  onToggleState: (annotation: EvidenceAnnotation) => void;
  onRemove: (annotation: EvidenceAnnotation) => void;
}) {
  const { locale, t } = useI18n();
  const editing = draft !== null;
  const thisAction = pendingAction?.annotationId === annotation.id ? pendingAction.kind : null;
  const saving = thisAction === 'edit';
  const controlsDisabled = pendingAction !== null || interactionLocked;

  return (
    <article
      data-review-state={annotation.review_state}
      data-edit-state={editing ? 'editing' : 'view'}
      data-action-state={saving ? 'saving' : thisAction ?? 'idle'}
    >
      <header>
        <Badge tone={annotation.review_state === 'open' ? 'warning' : 'success'}>
          {t(annotation.review_state === 'open' ? 'evidenceSearch.reviewOpen' : 'evidenceSearch.reviewResolved')}
        </Badge>
        <time dateTime={annotation.updated_at}>
          {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(annotation.updated_at))}
        </time>
      </header>

      {draft ? (
        <form
          className="evidence-annotations__editor"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitEdit(annotation);
          }}
        >
          <label>
            <span>{t('evidenceSearch.annotationBody')}</span>
            <textarea
              name="annotation-edit-body"
              required
              maxLength={4_000}
              disabled={saving}
              value={draft.body}
              onChange={(event) => onChangeDraft({ ...draft, body: event.target.value })}
            />
          </label>
          <label>
            <span>{t('evidenceSearch.annotationTags')}</span>
            <input
              name="annotation-edit-tags"
              disabled={saving}
              value={draft.tags}
              placeholder={t('evidenceSearch.annotationTagsPlaceholder')}
              onChange={(event) => onChangeDraft({ ...draft, tags: event.target.value })}
            />
          </label>
          <div className="evidence-annotations__edit-actions">
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onCancelEdit}>
              <X size={13} />{t('evidenceSearch.cancelAnnotationEdit')}
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={saving || draft.body.trim().length === 0}>
              {saving ? <Spinner /> : <Save size={13} />}
              {t(saving ? 'evidenceSearch.savingAnnotation' : 'evidenceSearch.saveAnnotationEdit')}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p>{annotation.body}</p>
          {annotation.tags.length > 0 ? <div>{annotation.tags.map((tag) => <Badge key={tag} tone="neutral">{tag}</Badge>)}</div> : null}
          <footer>
            <Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={() => onBeginEdit(annotation)}>
              <Pencil size={13} />{t('evidenceSearch.editAnnotation')}
            </Button>
            <Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={() => onToggleState(annotation)}>
              {annotation.review_state === 'open' ? <CheckCircle2 size={13} /> : <RotateCcw size={13} />}
              {t(annotation.review_state === 'open' ? 'evidenceSearch.resolveAnnotation' : 'evidenceSearch.reopenAnnotation')}
            </Button>
            <Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={() => onRemove(annotation)}>
              <Trash2 size={13} />{t('evidenceSearch.deleteAnnotation')}
            </Button>
          </footer>
        </>
      )}
    </article>
  );
}

export function EvidenceAnnotationPanel({
  item,
  onClose,
  onChanged,
}: {
  item: EvidenceSearchItem;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { locale, t } = useI18n();
  const [state, setState] = useState<AnnotationState>({
    status: 'loading', items: [], error: null,
  });
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [editing, setEditing] = useState<(EvidenceAnnotationDraft & { annotationId: string }) | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAnnotationAction | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const requests = useRef(arbitrateEvidenceAnnotationRequests()).current;

  const load = (signal?: AbortSignal) => {
    setState((current) => ({ status: 'loading', items: current.items, error: null }));
    void requests
      .acceptCurrentList(commands.listEvidenceAnnotations(
        {
          evidence_id: item.evidence_id,
          page: 1,
          page_size: 100,
        },
        signal,
      ))
      .then((page) => {
        if (page === null) return;
        setState({ status: 'ready', items: page.items, error: null });
      })
      .catch((cause: unknown) => {
        if (!signal?.aborted) {
          setState((current) => ({
            status: 'error', items: current.items, error: readableError(cause),
          }));
        }
      });
  };

  useEffect(() => {
    const controller = new AbortController();
    setBody('');
    setTags('');
    setEditing(null);
    setMutationError(null);
    load(controller.signal);
    return () => controller.abort();
  }, [item.evidence_id]);

  const replaceAnnotation = (updated: EvidenceAnnotation) => {
    setState((current) => ({
      status: 'ready',
      items: [updated, ...current.items.filter((candidate) => candidate.id !== updated.id)],
      error: null,
    }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPendingAction({ kind: 'create', annotationId: null });
    setMutationError(null);
    try {
      await completeEvidenceAnnotationMutation(
        commands.createEvidenceAnnotation({
          demo_id: item.demo_id,
          evidence_id: item.evidence_id,
          round: item.round,
          tick: item.tick,
          body,
          tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        }),
        (annotation) => {
          requests.mutationSucceeded();
          setState((current) => ({
            status: 'ready', items: [annotation, ...current.items], error: null,
          }));
          setBody('');
          setTags('');
        },
        onChanged,
      );
    } catch (cause) {
      setMutationError(readableError(cause));
    } finally {
      setPendingAction(null);
    }
  };

  const submitEdit = async (annotation: EvidenceAnnotation) => {
    if (!editing || editing.annotationId !== annotation.id) return;
    setPendingAction({ kind: 'edit', annotationId: annotation.id });
    setMutationError(null);
    try {
      await completeEvidenceAnnotationMutation(
        commands.updateEvidenceAnnotation(
          annotation.id,
          evidenceAnnotationUpdate(annotation, editing),
        ),
        (updated) => {
          requests.mutationSucceeded();
          replaceAnnotation(updated);
          setEditing(null);
        },
        onChanged,
      );
    } catch (cause) {
      setMutationError(readableError(cause));
    } finally {
      setPendingAction(null);
    }
  };

  const setReviewState = async (annotation: EvidenceAnnotation) => {
    setPendingAction({ kind: 'state', annotationId: annotation.id });
    setMutationError(null);
    try {
      await completeEvidenceAnnotationMutation(
        commands.updateEvidenceAnnotation(annotation.id, {
          body: annotation.body,
          tags: annotation.tags,
          review_state: annotation.review_state === 'open' ? 'resolved' : 'open',
        }),
        (updated) => {
          requests.mutationSucceeded();
          replaceAnnotation(updated);
        },
        onChanged,
      );
    } catch (cause) {
      setMutationError(readableError(cause));
    } finally {
      setPendingAction(null);
    }
  };

  const remove = async (annotation: EvidenceAnnotation) => {
    setPendingAction({ kind: 'delete', annotationId: annotation.id });
    setMutationError(null);
    try {
      await completeEvidenceAnnotationMutation(
        commands.deleteEvidenceAnnotation(annotation.id),
        () => {
          requests.mutationSucceeded();
          setState((current) => ({
            status: 'ready',
            items: current.items.filter((candidate) => candidate.id !== annotation.id),
            error: null,
          }));
        },
        onChanged,
      );
    } catch (cause) {
      setMutationError(readableError(cause));
    } finally {
      setPendingAction(null);
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
              disabled={pendingAction !== null || editing !== null}
              value={body}
              placeholder={t('evidenceSearch.annotationBodyPlaceholder')}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <label>
            <span>{t('evidenceSearch.annotationTags')}</span>
            <input
              name="annotation-tags"
              disabled={pendingAction !== null || editing !== null}
              value={tags}
              placeholder={t('evidenceSearch.annotationTagsPlaceholder')}
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={pendingAction !== null || editing !== null || body.trim().length === 0}>
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
            <EvidenceAnnotationRecord
              key={annotation.id}
              annotation={annotation}
              draft={editing?.annotationId === annotation.id ? editing : null}
              pendingAction={pendingAction}
              interactionLocked={editing !== null && editing.annotationId !== annotation.id}
              onBeginEdit={(candidate) => {
                setMutationError(null);
                setEditing({
                  annotationId: candidate.id,
                  body: candidate.body,
                  tags: candidate.tags.join(', '),
                });
              }}
              onChangeDraft={(draft) => setEditing({ annotationId: annotation.id, ...draft })}
              onSubmitEdit={(candidate) => void submitEdit(candidate)}
              onCancelEdit={() => {
                setEditing(null);
                setMutationError(null);
              }}
              onToggleState={(candidate) => void setReviewState(candidate)}
              onRemove={(candidate) => void remove(candidate)}
            />
          ))}
        </div>
      </div>
    </Drawer>
  );
}
