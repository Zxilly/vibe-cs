import { Clapperboard, LayoutDashboard, ListVideo } from 'lucide-react';
import { NavLink } from 'react-router-dom';

import { useI18n } from '../../shared/i18n';

export function ProductionSectionNav() {
  const { t } = useI18n();
  return (
    <nav className="section-switcher production-section-nav" aria-label={t('nav.production')}>
      <NavLink to="/production" end><LayoutDashboard size={15} />{t('production.overview')}</NavLink>
      <NavLink to="/queue"><ListVideo size={15} />{t('production.recording')}</NavLink>
      <NavLink to="/studio"><Clapperboard size={15} />{t('production.editing')}</NavLink>
    </nav>
  );
}
