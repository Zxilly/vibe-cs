import { Trans } from '@lingui/react/macro';
import { useHref } from 'react-router-dom';

import { useOutputList } from '../../data/outputs';
import { cn, Link } from '../../design/primitives';

export function ProjectOutputLink({ projectId, inline = false }: {
  readonly projectId: string;
  readonly inline?: boolean;
}) {
  const outputs = useOutputList({ project_id: projectId, kind: 'export', status: 'completed', page: 1, page_size: 1 });
  const href = useHref(`/delivery?project=${encodeURIComponent(projectId)}`);
  const output = outputs.data?.items[0];
  if (output === undefined) return null;
  return <Link href={href} size="sm" className={cn('whitespace-nowrap', !inline && 'inline-flex h-[var(--h-ctl-sm)] items-center rounded-md border border-divider px-3 font-medium')}>
    <Trans>成片</Trans>{output.project_revision === null ? null : ` r${output.project_revision}`}
  </Link>;
}
