import { CheckCircle2, FolderOpen } from 'lucide-react';
import { Link } from 'react-router-dom';

import type { ExportJobRecord } from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Badge, Button } from '../../shared/ui';

export function EditDeliveryResult({
  record,
  desktop,
  onReveal,
}: {
  record: ExportJobRecord;
  desktop: boolean;
  onReveal: (path: string) => void;
}) {
  const { t } = useI18n();
  const { job } = record;
  const delivered = job.status === 'completed'
    && job.progress === 1
    && job.error === null
    && job.output_path.trim().length > 0;

  if (!delivered) return null;

  return (
    <section className="edit-delivery-result" data-delivery-status="completed" aria-live="polite">
      <CheckCircle2 size={18} />
      <div>
        <span>{t('editor.delivery.complete')}</span>
        <strong title={job.output_path}>{job.output_path}</strong>
        <small>
          <code>{job.id}</code>
          <code>{job.project_id}</code>
        </small>
      </div>
      <Badge tone="success">{t('editor.delivery.ready')}</Badge>
      <nav aria-label={t('editor.delivery.actions')}>
        <Button
          size="sm"
          data-action="reveal-edit-delivery"
          disabled={!desktop}
          onClick={() => onReveal(job.output_path)}
        >
          <FolderOpen size={13} />{t('editor.delivery.reveal')}
        </Button>
        <Link className="button button--secondary button--sm" to="/outputs">
          {t('editor.delivery.outputs')}
        </Link>
      </nav>
    </section>
  );
}
