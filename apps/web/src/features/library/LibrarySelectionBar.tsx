import { CheckSquare, Sparkles } from 'lucide-react';

import { msg, useI18n } from '../../shared/i18n';
import { Button, Spinner } from '../../shared/ui';
import { formatLibrarySelectionMessage } from './librarySelection';

export function LibrarySelectionBar({
  selectedCount,
  state,
  atLimit,
  onClear,
  onAnalyze,
}: {
  selectedCount: number;
  state: 'idle' | 'validating' | 'opening';
  atLimit: boolean;
  onClear: () => void;
  onAnalyze: () => void;
}) {
  const { t } = useI18n();
  const busy = state !== 'idle';
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
        <Button size="sm" disabled={busy} onClick={onClear}>{t('common.clear')}</Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={onAnalyze}>
          {busy ? <Spinner /> : <Sparkles size={14} />}{msg('m0644')}
        </Button>
      </div>
    </div>
  );
}
