import { CheckCircle2, FolderOpen, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { commands, readableError } from '../../shared/desktop/client';
import { isDesktopShell } from '../../shared/desktop/dialog';
import type { HlaeBundleHandoff } from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, Notice, Spinner } from '../../shared/ui';

import './hlae-handoff.css';

export const HLAE_BUNDLE_EXPORTED_EVENT = 'vibe-cs:hlae-bundle-exported';

export function HlaeHandoffPanel() {
  const { t } = useI18n();
  const [bundles, setBundles] = useState<HlaeBundleHandoff[]>([]);
  const [loading, setLoading] = useState(false);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const desktop = isDesktopShell();

  const refresh = useCallback(async () => {
    if (!desktop) return;
    setLoading(true);
    setError(null);
    try {
      setBundles(await commands.listHlaeBundles());
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setLoading(false);
    }
  }, [desktop]);

  useEffect(() => {
    void refresh();
    const handleExport = () => void refresh();
    window.addEventListener(HLAE_BUNDLE_EXPORTED_EVENT, handleExport);
    return () => window.removeEventListener(HLAE_BUNDLE_EXPORTED_EVENT, handleExport);
  }, [refresh]);

  const reveal = useCallback(async (directory: string) => {
    if (revealing) return;
    setRevealing(directory);
    setError(null);
    try {
      await commands.revealHlaeBundle(directory);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setRevealing(null);
    }
  }, [revealing]);

  return (
    <section className="hlae-handoff" aria-labelledby="hlae-handoff-title">
      <div className="hlae-handoff__header">
        <div>
          <span className="hlae-handoff__eyebrow">HLAE</span>
          <h2 id="hlae-handoff-title">{t('copilot.hlaeBundles')}</h2>
          <p>{t('copilot.hlaeBundlesDescription')}</p>
        </div>
        <Button size="sm" variant="secondary" disabled={!desktop || loading} onClick={() => void refresh()}>
          {loading ? <Spinner /> : <RefreshCw size={14} />}{t('copilot.refreshBundles')}
        </Button>
      </div>
      {!desktop ? <Notice tone="info">{t('copilot.desktopBundleOnly')}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {desktop && !loading && bundles.length === 0 ? (
        <div className="hlae-handoff__empty">{t('copilot.noHlaeBundles')}</div>
      ) : null}
      {bundles.length > 0 ? (
        <ol className="hlae-handoff__list">
          {bundles.slice(0, 8).map((bundle, index) => (
            <li key={bundle.directory}>
              <div className="hlae-handoff__status">
                <CheckCircle2 size={17} aria-hidden="true" />
                <div>
                  <strong>{index === 0 ? t('copilot.latestBundle') : t('copilot.exportedBundle')}</strong>
                  <span title={bundle.directory}>{bundle.directory}</span>
                </div>
              </div>
              <div className="hlae-handoff__facts">
                <Badge tone="success">{t('copilot.completeMarker')}</Badge>
                <span>{bundle.files.length} {t('copilot.generatedFiles')}</span>
                <code title={bundle.completionMarker}>{bundle.completionMarker}</code>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={revealing !== null}
                onClick={() => void reveal(bundle.directory)}
              >
                {revealing === bundle.directory ? <Spinner /> : <FolderOpen size={14} />}
                {t('copilot.revealBundle')}
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
