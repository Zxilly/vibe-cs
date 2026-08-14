import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIBRARY_QUERY,
  libraryPageCount,
  libraryQueryFromParams,
  libraryQueryToDemoQuery,
  libraryQueryToParams,
  patchLibraryQuery,
  setLibraryColumnVisibility,
  tableSortFromServerSort,
  toggleLibraryTableSort,
} from './libraryQuery';

describe('library server query', () => {
  it('restores visible factual columns from the canonical URL state', () => {
    const query = libraryQueryFromParams(new URLSearchParams(
      'columns=map,played,duration',
    ));

    expect(query.columns).toEqual(['map', 'played', 'duration']);
    expect(libraryQueryToParams(query).toString()).toBe('columns=map%2Cplayed%2Cduration');
    expect(libraryQueryToDemoQuery(query)).toEqual({
      sort: 'updated_desc',
      page: 1,
      page_size: 50,
    });
  });

  it('updates optional columns in canonical order without touching locked columns', () => {
    expect(setLibraryColumnVisibility(['score', 'map'], 'played', true)).toEqual([
      'map',
      'score',
      'played',
    ]);
    expect(setLibraryColumnVisibility(['map', 'score', 'played'], 'score', false)).toEqual([
      'map',
      'played',
    ]);
  });

  it('restores bounded filters, lifecycle status, sort, and page from the URL', () => {
    const query = libraryQueryFromParams(new URLSearchParams(
      'q=m0NESY&map=de_mirage&status=indexing&match_source=faceit&tag=11111111-1111-4111-8111-111111111111&sort=duration_desc&page=3&page_size=20',
    ));

    expect(query).toEqual({
      search: 'm0NESY',
      map: 'de_mirage',
      status: 'indexing',
      matchSource: 'faceit',
      tagId: '11111111-1111-4111-8111-111111111111',
      sort: 'duration_desc',
      page: 3,
      pageSize: 20,
      columns: ['map', 'score', 'played', 'duration', 'rounds', 'updated'],
    });
    expect(libraryQueryToDemoQuery(query)).toEqual({
      search: 'm0NESY',
      map_name: 'de_mirage',
      status: 'indexing',
      match_source: 'faceit',
      tag_id: '11111111-1111-4111-8111-111111111111',
      sort: 'duration_desc',
      page: 3,
      page_size: 20,
    });
    expect(libraryQueryToParams(query).toString()).toBe(
      'q=m0NESY&map=de_mirage&status=indexing&match_source=faceit&tag=11111111-1111-4111-8111-111111111111&sort=duration_desc&page=3&page_size=20',
    );
  });

  it.each([
    'status=parsing',
    'match_source=local',
    'tag=not-a-uuid',
    'search=m0NESY',
    'map_name=de_mirage',
    'sort=newest',
    'sort=drop_table',
    'page=0',
    'page=100001',
    'page_size=25',
    'page_size=201',
    'columns=map,map',
    'columns=map,size',
    'columns=status',
    'columns=map,,score',
  ])('rejects non-canonical or out-of-bounds URL state: %s', (query) => {
    expect(() => libraryQueryFromParams(new URLSearchParams(query))).toThrow('Invalid Library query');
  });

  it('resets to page one when the result set changes and keeps explicit paging separate', () => {
    const onThirdPage = { ...DEFAULT_LIBRARY_QUERY, page: 3 };
    expect(patchLibraryQuery(onThirdPage, { search: 'major' }).page).toBe(1);
    expect(patchLibraryQuery(onThirdPage, { map: 'de_nuke' }).page).toBe(1);
    expect(patchLibraryQuery(onThirdPage, { status: 'ready' }).page).toBe(1);
    expect(patchLibraryQuery(onThirdPage, { pageSize: 100 }).page).toBe(1);
    expect(patchLibraryQuery(onThirdPage, { page: 2 }).page).toBe(2);
  });

  it('maps table headers to the server whitelist and computes honest page counts', () => {
    expect(tableSortFromServerSort('map_desc')).toEqual({ key: 'map', direction: 'desc' });
    expect(toggleLibraryTableSort('map_desc', 'map')).toBe('map_asc');
    expect(toggleLibraryTableSort('map_asc', 'file')).toBe('file_asc');
    expect(libraryPageCount(137, 50)).toBe(3);
    expect(libraryPageCount(0, 50)).toBe(1);
  });
});
