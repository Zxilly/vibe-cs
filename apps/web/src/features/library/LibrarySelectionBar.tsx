import { CheckSquare, Minus, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';

import type { DemoMatchSource, DemoTag } from '../../shared/desktop/dto';
import { msg, useI18n } from '../../shared/i18n';
import { Button, Spinner } from '../../shared/ui';
import { formatLibrarySelectionMessage } from './librarySelection';

export function LibrarySelectionBar({
  selectedCount,
  state,
  atLimit,
  onClear,
  onAnalyze,
  tags,
  matchSources,
  metadataBusy,
  onSetMatchSource,
  onAddTag,
  onRemoveTag,
}: {
  selectedCount: number;
  state: 'idle' | 'validating' | 'opening';
  atLimit: boolean;
  onClear: () => void;
  onAnalyze: () => void;
  tags: DemoTag[];
  matchSources: readonly DemoMatchSource[];
  metadataBusy: boolean;
  onSetMatchSource: (source: DemoMatchSource | null) => void;
  onAddTag: (tagId: string) => void;
  onRemoveTag: (tagId: string) => void;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState<DemoMatchSource | 'clear'>('clear');
  const [tagId, setTagId] = useState('');
  const busy = state !== 'idle' || metadataBusy;
  return (
    <div className="selection-bar library-selection-bar" data-testid="library-selection-bar" role="status">
      <CheckSquare size={16} />
      <div className="library-selection-bar__copy">
        <strong>{formatLibrarySelectionMessage(t('library.selection.count'), { count: selectedCount })}</strong>
        <span>{t('library.selection.scope')}</span>
        {atLimit ? <small>{t('library.selection.limit')}</small> : null}
        {state === 'validating' ? <small><Spinner />{t('library.selection.validating')}</small> : null}
      </div>
      <div className="library-selection-bar__actions">
        <label>
          <span>{t('library.metadata.matchSource')}</span>
          <select value={source} onChange={(event) => setSource(event.target.value as DemoMatchSource | 'clear')}>
            <option value="clear">{t('library.metadata.matchSourceUnknown')}</option>
            {matchSources.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <Button size="sm" disabled={busy} onClick={() => onSetMatchSource(source === 'clear' ? null : source)}>
          {t('library.selection.applySource')}
        </Button>
        <label>
          <span>{t('library.metadata.tags')}</span>
          <select value={tagId} onChange={(event) => setTagId(event.target.value)}>
            <option value="">{t('library.metadata.allTags')}</option>
            {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
        </label>
        <Button size="sm" disabled={busy || !tagId} onClick={() => onAddTag(tagId)}>
          <Plus size={13} />{t('library.selection.addTag')}
        </Button>
        <Button size="sm" disabled={busy || !tagId} onClick={() => onRemoveTag(tagId)}>
          <Minus size={13} />{t('library.selection.removeTag')}
        </Button>
        <Button size="sm" disabled={busy} onClick={onClear}>{t('common.clear')}</Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={onAnalyze}>
          {busy ? <Spinner /> : <Sparkles size={14} />}{msg('m0644')}
        </Button>
      </div>
    </div>
  );
}
