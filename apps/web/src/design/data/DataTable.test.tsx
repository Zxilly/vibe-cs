import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { DataTable, type DataTableColumn } from './DataTable';

interface Match {
  readonly id: string;
  readonly name: string;
  readonly map: string;
  readonly duration: string;
}

const ROWS: readonly Match[] = [
  { id: 'm1', name: 'Aurora vs Meridian', map: 'Mirage', duration: '41:02' },
  { id: 'm2', name: 'Aurora vs Halcyon', map: 'Ancient', duration: '38:47' },
  { id: 'm3', name: 'Aurora vs Solace', map: 'Nuke', duration: '44:15' },
];

const COLUMNS: readonly DataTableColumn<Match>[] = [
  { id: 'name', header: '比赛', headerLabel: '比赛', cell: (row) => row.name, hideable: false },
  { id: 'map', header: '地图', headerLabel: '地图', cell: (row) => row.map, sortable: true },
  { id: 'duration', header: '时长', headerLabel: '时长', cell: (row) => row.duration, variant: 'numeric' },
  { id: 'actions', headerLabel: '操作', cell: () => <a href="#work">工作区</a>, hideable: false },
];

function table(props: Partial<ComponentProps<typeof DataTable<Match>>> = {}): string {
  return renderMarkup(
    <DataTable<Match> caption="Demo 资料库" columns={COLUMNS} rows={ROWS} rowId={(row) => row.id} {...props} />,
  );
}

describe('DataTable density', () => {
  it('holds the 42px row contract of §3.4', () => {
    const html = table();
    expect(html.match(/h-\[var\(--h-row\)\]/gu)).toHaveLength(ROWS.length);
  });

  it('names the table for assistive tech without printing a title', () => {
    const html = table();
    expect(html).toContain('<caption class="sr-only">Demo 资料库</caption>');
  });

  it('renders one td per visible column per row', () => {
    const html = table();
    expect(html.match(/<td/gu)).toHaveLength(COLUMNS.length * ROWS.length);
  });

  it('sets a numeric column in mono', () => {
    expect(table()).toContain('font-mono');
  });

  it('washes a hovered row with the surface token rather than a bare ink mix', () => {
    expect(table()).toContain('hover:bg-surface');
  });
});

describe('DataTable active row', () => {
  it('paints the Inspector row accent-100 with the inset left edge', () => {
    const html = table({ activeRowId: 'm2' });
    // Verbatim from 「02 Demo 资料库」/「05 证据检索」/「06 玩家目录」.
    expect(html).toContain('bg-accent-100');
    expect(html).toContain('shadow-[inset_2px_0_0_var(--color-accent)]');
    expect(html.match(/bg-accent-100/gu)).toHaveLength(1);
  });

  it('marks it with aria-current so it is not only a colour', () => {
    const html = table({ activeRowId: 'm2' });
    expect(html).toContain('data-row-id="m2"');
    expect(html.match(/aria-current="true"/gu)).toHaveLength(1);
  });

  it('keeps the checked set and the active row apart', () => {
    // 资料库 shows three checked boxes and exactly one accent row.
    const html = table({
      selectable: true,
      selected: new Set(['m1', 'm2', 'm3']),
      selectionLimit: 12,
      activeRowId: 'm1',
      onSelectedChange: () => {},
    });
    expect(html.match(/checked=""/gu)).toHaveLength(3);
    expect(html.match(/bg-accent-100/gu)).toHaveLength(1);
  });
});

describe('DataTable selection', () => {
  it('adds a labelled checkbox column', () => {
    const html = table({ selectable: true, rowLabel: (row) => row.name, onSelectedChange: () => {} });
    expect(html).toContain(String.raw`role="checkbox"`);
    expect(html).toContain('aria-label="Aurora vs Meridian"');
  });

  it('disables a blocked checkbox instead of hiding it', () => {
    const html = table({
      selectable: true,
      selected: new Set(['m1', 'm2']),
      selectionLimit: 2,
      onSelectedChange: () => {},
    });
    /* Spec §8: a blocked action stays visible and states why. Counted on
       `data-disabled`, which Radix puts on the control alone — the plain
       `disabled` attribute also lands on the hidden form input beside it. */
    expect(html.match(/data-disabled=""/gu)).toHaveLength(1);
    expect(html.match(/role="checkbox"/gu)).toHaveLength(3);
  });

  it('omits the select-all box whenever the selection is capped', () => {
    const capped = table({ selectable: true, selectionLimit: 12, onSelectedChange: () => {} });
    expect(capped).not.toContain('全选本页');

    const uncapped = table({ selectable: true, onSelectedChange: () => {} });
    expect(uncapped).toContain('aria-label="全选本页"');
  });

  it('renders no checkbox column at all when the table is not selectable', () => {
    expect(table()).not.toContain(String.raw`role="checkbox"`);
  });
});

describe('DataTable sorting', () => {
  it('reports the sorted column through aria-sort', () => {
    const html = table({ sort: { columnId: 'map', direction: 'desc' }, onSortChange: () => {} });
    expect(html).toContain('aria-sort="descending"');
    expect(html.match(/aria-sort/gu)).toHaveLength(1);
  });

  it('marks an unsorted sortable header as none, with a visible glyph', () => {
    const html = table({ onSortChange: () => {} });
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain('<button');
    expect(html).toContain('<svg');
  });

  it('leaves the header inert when the page passes no sort handler', () => {
    const html = table();
    expect(html).not.toContain('<button');
  });
});

describe('DataTable column configuration', () => {
  it('drops a hidden column from header and body alike', () => {
    const html = table({ hiddenColumns: new Set(['map']) });
    expect(html).not.toContain('Mirage');
    expect(html.match(/<td/gu)).toHaveLength((COLUMNS.length - 1) * ROWS.length);
  });

  it('keeps a non-hideable column even when it is hidden', () => {
    const html = table({ hiddenColumns: new Set(['name', 'actions']) });
    expect(html).toContain('Aurora vs Meridian');
    expect(html).toContain('工作区');
  });

  it('gives an unlabelled action column an accessible header name', () => {
    expect(table()).toContain('<span class="sr-only">操作</span>');
  });
});

describe('DataTable placeholders', () => {
  it('shows the empty slot under the header when there are no rows', () => {
    const html = table({ rows: [], empty: <p>还没有比赛</p> });
    expect(html).toContain('还没有比赛');
    expect(html).toContain('<thead');
    expect(html.match(/<td/gu)).toBeNull();
  });

  it('prefers the skeleton while loading, even with rows in hand', () => {
    const html = table({ loading: true, skeleton: <p>加载中</p>, empty: <p>还没有比赛</p> });
    expect(html).toContain('加载中');
    expect(html).not.toContain('还没有比赛');
  });

  it('renders the footer slot below the scroll area', () => {
    expect(table({ footer: <p>分页</p> })).toContain('分页');
  });
});
