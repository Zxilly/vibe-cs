import { ChevronLeft, ChevronRight, Search, Shield } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import type { LineupDirectoryPage, LineupMapPage } from '../../shared/desktop/dto';
import { currentLocale, useI18n } from '../../shared/i18n';
import { Button, Card, EmptyState, Notice, PageHeader, Spinner } from '../../shared/ui';
import { LibrarySectionNav } from '../library/LibrarySectionNav';

const PAGE_SIZE = 20;
const hex64 = /^[0-9a-f]{64}$/;

function positive(value: string | null): number {
  const parsed = Number(value ?? '1');
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10_000 ? parsed : 1;
}

export function LineupsPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const search = (params.get('q') ?? '').slice(0, 128);
  const page = positive(params.get('page'));
  const selected = hex64.test(params.get('lineup') ?? '') ? params.get('lineup')! : null;
  const mapsPage = positive(params.get('maps_page'));
  const [directory, setDirectory] = useState<LineupDirectoryPage | null>(null);
  const [maps, setMaps] = useState<LineupMapPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    commands.listLineups({ search, page, page_size: PAGE_SIZE }, controller.signal)
      .then(setDirectory).catch((reason) => { if (!controller.signal.aborted) setError(readableError(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [search, page]);

  useEffect(() => {
    if (selected === null) { setMaps(null); return; }
    const controller = new AbortController();
    commands.listLineupMaps(selected, { page: mapsPage, page_size: PAGE_SIZE }, controller.signal)
      .then(setMaps).catch((reason) => { if (!controller.signal.aborted) setError(readableError(reason)); });
    return () => controller.abort();
  }, [selected, mapsPage]);

  const pages = useMemo(() => Math.max(1, Math.ceil((directory?.total ?? 0) / PAGE_SIZE)), [directory?.total]);
  const patch = (values: Record<string, string | null>) => setParams((current) => {
    const next = new URLSearchParams(current);
    Object.entries(values).forEach(([key, value]) => value === null ? next.delete(key) : next.set(key, value));
    return next;
  });

  return <div className="page page--dense">
    <LibrarySectionNav />
    <PageHeader eyebrow="Local identity" title={t('lineups.title')} description={t('lineups.description')} />
    <Card>
      <label className="field"><span>{t('lineups.search')}</span><span className="field__control"><Search size={15} /><input value={search} onChange={(event) => patch({ q: event.target.value || null, page: null })} /></span></label>
      {directory ? <Notice tone={directory.coverage.projection_complete ? 'info' : 'warning'}>{t('lineups.coverage').replace('{evaluated}', String(directory.coverage.evaluated_demos)).replace('{verified}', String(directory.coverage.verified_demos)).replace('{total}', String(directory.coverage.total_analyses))}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {loading ? <Spinner label={t('common.loading')} /> : null}
      {!loading && directory?.items.length === 0 ? <EmptyState icon={<Shield />} title={t('lineups.empty')} description={t('lineups.description')} /> : null}
      {directory?.items.map((item) => <button key={item.lineup_id} type="button" className="power-table__row" onClick={() => patch({ lineup: item.lineup_id, maps_page: null })}>
        <span><strong>{item.lineup_id.slice(0, 12)}</strong><small>{item.members.join(' · ')}</small></span>
        <span>{t('lineups.maps')} {item.maps}</span><span>{t('lineups.record')} {item.wins}/{item.losses}/{item.ties}</span><span>{t('lineups.rounds')} {item.rounds_for}/{item.rounds_against}</span>
      </button>)}
      <div className="pagination"><Button disabled={page <= 1} onClick={() => patch({ page: String(page - 1) })}><ChevronLeft size={14} />{t('lineups.previous')}</Button><span>{page}/{pages}</span><Button disabled={page >= pages} onClick={() => patch({ page: String(page + 1) })}>{t('lineups.next')}<ChevronRight size={14} /></Button></div>
    </Card>
    {maps ? <Card><h2>{t('lineups.history')}</h2><p className="mono">{maps.lineup_id}</p><h3>{t('lineups.members')}</h3><div className="chip-row">{maps.members.map((member) => <Link key={member} to={`/players?player=${member}`} className="chip">{member}</Link>)}</div>
      {maps.items.map((item) => <div key={item.demo_id} className="inspector-row"><span><strong>{item.map_name ?? '—'}</strong><small>{item.match_date ? new Date(item.match_date).toLocaleString(currentLocale()) : t('lineups.matchDateUnavailable')} · {t('lineups.catalogedAt')} {new Date(item.cataloged_at).toLocaleString(currentLocale())}</small></span><span>{item.team_slot} · {item.rounds_for}:{item.rounds_against}</span><Link to={`/analysis?demo=${item.demo_id}`}>{item.demo_id.slice(0, 8)}</Link></div>)}
    </Card> : null}
  </div>;
}
