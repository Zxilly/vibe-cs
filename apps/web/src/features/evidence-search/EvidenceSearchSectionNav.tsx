import { MessageSquareText, Search } from 'lucide-react';
import { Link } from 'react-router-dom';

import { useI18n } from '../../shared/i18n';

export function EvidenceSearchSectionNav({ active }: { active: 'evidence' | 'annotations' }) {
  const { t } = useI18n();
  return (
    <nav className="section-switcher evidence-search-section-nav" aria-label={t('nav.evidenceSearch')}>
      <Link className={active === 'evidence' ? 'active' : undefined} aria-current={active === 'evidence' ? 'page' : undefined} to="/evidence-search">
        <Search size={14} />{t('evidenceSearch.title')}
      </Link>
      <Link className={active === 'annotations' ? 'active' : undefined} aria-current={active === 'annotations' ? 'page' : undefined} to="/evidence-search?view=annotations">
        <MessageSquareText size={14} />{t('evidenceSearch.annotations')}
      </Link>
    </nav>
  );
}
