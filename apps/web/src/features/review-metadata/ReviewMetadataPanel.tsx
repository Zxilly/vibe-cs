import { Check, MessageSquareText, Tags } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { commands, readableError } from '../../shared/desktop/client';
import type { ReviewMetadataUpdate, ReviewTag } from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Button, Notice, Spinner } from '../../shared/ui';
import './ReviewMetadataPanel.css';

type MetadataValue = Readonly<{
  comment: string;
  tags: ReviewTag[];
  updated_at: string;
}>;

type LoadState = 'loading' | 'ready' | 'error';

export function ReviewMetadataForm({
  title,
  description,
  comment,
  selectedTagIds,
  tags,
  dirty,
  saving,
  onCommentChange,
  onToggleTag,
  onSave,
}: {
  title: string;
  description: string;
  comment: string;
  selectedTagIds: ReadonlySet<string>;
  tags: readonly ReviewTag[];
  dirty: boolean;
  saving: boolean;
  onCommentChange: (comment: string) => void;
  onToggleTag: (tagId: string) => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const atTagLimit = selectedTagIds.size >= 32;
  return (
    <section className="review-metadata-panel" aria-label={title}>
      <header>
        <div><MessageSquareText size={15} /><span><strong>{title}</strong><small>{description}</small></span></div>
        {dirty ? <span className="review-metadata-panel__dirty">{t('reviewMetadata.unsaved')}</span> : null}
      </header>
      <label className="review-metadata-panel__comment">
        <span>{t('reviewMetadata.comment')}</span>
        <textarea
          value={comment}
          disabled={saving}
          maxLength={4_000}
          rows={3}
          placeholder={t('reviewMetadata.commentPlaceholder')}
          onChange={(event) => onCommentChange(event.target.value)}
        />
        <small>{comment.length}/4000</small>
      </label>
      <fieldset className="review-metadata-panel__tags">
        <legend><Tags size={13} />{t('reviewMetadata.tags')}</legend>
        {tags.length ? <div>{tags.map((tag) => {
          const checked = selectedTagIds.has(tag.id);
          return <label key={tag.id} style={{ '--review-tag-color': tag.color } as CSSProperties}>
            <input
              type="checkbox"
              checked={checked}
              disabled={saving || (!checked && atTagLimit)}
              onChange={() => onToggleTag(tag.id)}
            />
            <i />
            <span>{tag.name}</span>
          </label>;
        })}</div> : <p>{t('reviewMetadata.noTags')}</p>}
      </fieldset>
      <footer>
        <span>{t('reviewMetadata.localTruth')}</span>
        <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
          {saving ? <Spinner /> : <Check size={13} />}{t('reviewMetadata.save')}
        </Button>
      </footer>
    </section>
  );
}

export function ReviewMetadataPanel({
  identity,
  title,
  description,
  loadMetadata,
  updateMetadata,
}: {
  identity: string;
  title: string;
  description: string;
  loadMetadata: (signal: AbortSignal) => Promise<MetadataValue>;
  updateMetadata: (update: ReviewMetadataUpdate, signal: AbortSignal) => Promise<MetadataValue>;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<MetadataValue | null>(null);
  const [tags, setTags] = useState<ReviewTag[]>([]);
  const [comment, setComment] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const revision = useRef(0);
  const saveController = useRef<AbortController | null>(null);

  const load = () => {
    const controller = new AbortController();
    const currentRevision = ++revision.current;
    saveController.current?.abort();
    setState('loading');
    setError(null);
    setNotice(null);
    setSaving(false);
    void Promise.all([
      commands.listReviewTags(controller.signal),
      loadMetadata(controller.signal),
    ]).then(([catalog, value]) => {
      if (controller.signal.aborted || revision.current !== currentRevision) return;
      setTags(catalog);
      setMetadata(value);
      setComment(value.comment);
      setSelectedTagIds(new Set(value.tags.map((tag) => tag.id)));
      setState('ready');
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || revision.current !== currentRevision) return;
      setError(readableError(cause));
      setState('error');
    });
    return controller;
  };

  useEffect(() => {
    const controller = load();
    return () => {
      controller.abort();
      saveController.current?.abort();
      revision.current += 1;
    };
  // The exact identity deliberately owns one request generation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, loadMetadata, loadRevision, updateMetadata]);

  const baselineTagIds = metadata?.tags.map((tag) => tag.id).sort().join('\0') ?? '';
  const currentTagIds = [...selectedTagIds].sort().join('\0');
  const dirty = metadata !== null
    && (comment !== metadata.comment || currentTagIds !== baselineTagIds);

  const toggleTag = (tagId: string) => setSelectedTagIds((current) => {
    const next = new Set(current);
    if (next.has(tagId)) next.delete(tagId);
    else if (next.size < 32) next.add(tagId);
    return next;
  });

  const save = async () => {
    if (!metadata || !dirty || saving) return;
    saveController.current?.abort();
    const controller = new AbortController();
    saveController.current = controller;
    const currentRevision = revision.current;
    setSaving(true);
    setNotice(null);
    try {
      const updated = await updateMetadata({ comment, tag_ids: [...selectedTagIds] }, controller.signal);
      if (controller.signal.aborted || revision.current !== currentRevision) return;
      setMetadata(updated);
      setComment(updated.comment);
      setSelectedTagIds(new Set(updated.tags.map((tag) => tag.id)));
      setNotice({ tone: 'success', text: t('reviewMetadata.saved') });
    } catch (cause: unknown) {
      if (controller.signal.aborted || revision.current !== currentRevision) return;
      setNotice({ tone: 'danger', text: readableError(cause) });
    } finally {
      if (!controller.signal.aborted && revision.current === currentRevision) setSaving(false);
    }
  };

  if (state === 'loading') return <div className="review-metadata-panel review-metadata-panel--loading"><Spinner label={t('reviewMetadata.loading')} /></div>;
  if (state === 'error') return <div className="review-metadata-panel">
    <Notice tone="danger">{error ?? t('reviewMetadata.unavailable')}</Notice>
    <Button size="sm" onClick={() => setLoadRevision((value) => value + 1)}>{t('common.retry')}</Button>
  </div>;
  return <>
    {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
    <ReviewMetadataForm
      title={title}
      description={description}
      comment={comment}
      selectedTagIds={selectedTagIds}
      tags={tags}
      dirty={dirty}
      saving={saving}
      onCommentChange={setComment}
      onToggleTag={toggleTag}
      onSave={() => void save()}
    />
  </>;
}
