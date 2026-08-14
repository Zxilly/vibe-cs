import { Archive, History, Shield, UsersRound } from 'lucide-react';
import { NavLink } from 'react-router-dom';

import { useI18n } from '../../shared/i18n';

export function LibrarySectionNav() {
  const { t } = useI18n();
  return (
    <nav className="section-switcher" aria-label={t('nav.matches')}>
      <NavLink to="/library" end><Archive size={15} />{t('library.localMatches')}</NavLink>
      <NavLink to="/match-history"><History size={15} />{t('history.title')}</NavLink>
      <NavLink to="/players"><UsersRound size={15} />{t('players.title')}</NavLink>
      <NavLink to="/lineups"><Shield size={15} />{t('lineups.title')}</NavLink>
    </nav>
  );
}
