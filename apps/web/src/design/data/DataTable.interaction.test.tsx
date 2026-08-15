import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { DataTable, type DataTableColumn } from './DataTable';
import type { SortState } from './tableModel';

interface Match {
  readonly id: string;
  readonly name: string;
  readonly map: string;
}

const ROWS: readonly Match[] = [
  { id: 'm1', name: 'Aurora vs Meridian', map: 'Mirage' },
  { id: 'm2', name: 'Aurora vs Halcyon', map: 'Ancient' },
  { id: 'm3', name: 'Aurora vs Solace', map: 'Nuke' },
];

const COLUMNS: readonly DataTableColumn<Match>[] = [
  { id: 'name', header: '比赛', cell: (row) => row.name, hideable: false },
  { id: 'map', header: '地图', cell: (row) => row.map, sortable: true },
  { id: 'actions', headerLabel: '操作', cell: () => <a href="#work">工作区</a>, hideable: false },
];

function rowsOf(container: HTMLElement): HTMLTableRowElement[] {
  return [...container.querySelectorAll<HTMLTableRowElement>('tr[data-row-id]')];
}

describe('DataTable keyboard navigation', () => {
  it('is a single tab stop, and arrows walk the rows from there', () => {
    const { container } = renderInteractive(
      <DataTable<Match>
        caption="Demo 资料库"
        columns={COLUMNS}
        rows={ROWS}
        rowId={(row) => row.id}
        onRowActivate={() => {}}
      />,
    );

    const rows = rowsOf(container);
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);

    rows[0]?.focus();
    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);

    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(rows[2]);

    // The ends hold rather than wrap, so a held key cannot loop the table.
    fireEvent.keyDown(rows[2] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[2]);

    fireEvent.keyDown(rows[2] as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
  });

  it('puts the tab stop on the active row so focus returns to the Inspector subject', () => {
    const { container } = renderInteractive(
      <DataTable<Match>
        caption="Demo 资料库"
        columns={COLUMNS}
        rows={ROWS}
        rowId={(row) => row.id}
        activeRowId="m3"
        onRowActivate={() => {}}
      />,
    );
    expect(rowsOf(container).map((row) => row.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('activates on Enter and on Space, and Space does not scroll', () => {
    const onRowActivate = vi.fn();
    const { container } = renderInteractive(
      <DataTable<Match>
        caption="Demo 资料库"
        columns={COLUMNS}
        rows={ROWS}
        rowId={(row) => row.id}
        onRowActivate={onRowActivate}
      />,
    );

    const row = rowsOf(container)[1] as HTMLElement;
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onRowActivate).toHaveBeenCalledWith('m2', ROWS[1]);

    const space = fireEvent.keyDown(row, { key: ' ' });
    expect(space).toBe(false); // preventDefault ran
    expect(onRowActivate).toHaveBeenCalledTimes(2);
  });

  it('does not make rows focusable when there is nothing to activate', () => {
    const { container } = renderInteractive(
      <DataTable<Match> caption="Demo 资料库" columns={COLUMNS} rows={ROWS} rowId={(row) => row.id} />,
    );
    expect(rowsOf(container).map((row) => row.getAttribute('tabindex'))).toEqual([null, null, null]);
  });
});

describe('DataTable row activation', () => {
  it('activates on a plain row click', () => {
    const onRowActivate = vi.fn();
    const { container } = renderInteractive(
      <DataTable<Match>
        caption="Demo 资料库"
        columns={COLUMNS}
        rows={ROWS}
        rowId={(row) => row.id}
        onRowActivate={onRowActivate}
      />,
    );

    fireEvent.click(rowsOf(container)[0] as HTMLElement);
    expect(onRowActivate).toHaveBeenCalledWith('m1', ROWS[0]);
  });

  it('leaves a row action to itself', () => {
    const onRowActivate = vi.fn();
    const { getAllByRole } = renderInteractive(
      <DataTable<Match>
        caption="Demo 资料库"
        columns={COLUMNS}
        rows={ROWS}
        rowId={(row) => row.id}
        onRowActivate={onRowActivate}
      />,
    );

    fireEvent.click(getAllByRole('link')[0] as HTMLElement);
    expect(onRowActivate).not.toHaveBeenCalled();
  });

  it('leaves the checkbox to itself', () => {
    const onRowActivate = vi.fn();
    const onSelectedChange = vi.fn();
    const { getAllByRole } = renderInteractive(
      <DataTable<Match>
        caption="Demo 资料库"
        columns={COLUMNS}
        rows={ROWS}
        rowId={(row) => row.id}
        selectable
        selectionLimit={2}
        onSelectedChange={onSelectedChange}
        onRowActivate={onRowActivate}
      />,
    );

    fireEvent.click(getAllByRole('checkbox')[0] as HTMLElement);
    expect(onSelectedChange).toHaveBeenCalledTimes(1);
    expect([...(onSelectedChange.mock.calls[0]?.[0] as Set<string>)]).toEqual(['m1']);
    expect(onRowActivate).not.toHaveBeenCalled();
  });
});

describe('DataTable selection cap', () => {
  function Harness() {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(['m1']));
    return (
      <DataTable<Match>
        caption="玩家目录"
        columns={COLUMNS}
        rows={ROWS}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        selectable
        selected={selected}
        selectionLimit={2}
        onSelectedChange={setSelected}
      />
    );
  }

  it('disables the remaining boxes at the cap and lets a removal free one again', () => {
    const { getAllByRole } = renderInteractive(<Harness />);
    const boxes = () => getAllByRole('checkbox') as HTMLInputElement[];

    fireEvent.click(boxes()[1] as HTMLElement);
    // "比较上限 2 名" — the third box is disabled, never hidden.
    expect(boxes()[2]?.disabled).toBe(true);
    expect(boxes()).toHaveLength(3);

    fireEvent.click(boxes()[0] as HTMLElement);
    expect(boxes()[2]?.disabled).toBe(false);
  });
});

describe('DataTable select-all', () => {
  function Harness() {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    return (
      <DataTable<Match>
        caption="Demo 资料库"
        columns={COLUMNS}
        rows={ROWS}
        rowId={(row) => row.id}
        selectable
        selected={selected}
        onSelectedChange={setSelected}
      />
    );
  }

  it('goes none → all → none, and shows the indeterminate middle', () => {
    const { getByLabelText, getAllByRole } = renderInteractive(<Harness />);
    const all = getByLabelText('全选本页') as HTMLInputElement;

    fireEvent.click(getAllByRole('checkbox')[1] as HTMLElement);
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);

    fireEvent.click(all);
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);

    fireEvent.click(all);
    expect(all.checked).toBe(false);
  });
});

describe('DataTable sorting', () => {
  function Harness() {
    const [sort, setSort] = useState<SortState | null>(null);
    return (
      <DataTable<Match>
        caption="Demo 资料库"
        columns={COLUMNS}
        rows={ROWS}
        rowId={(row) => row.id}
        sort={sort}
        onSortChange={setSort}
      />
    );
  }

  it('cycles the header through ascending, descending and back to unsorted', () => {
    const { getByRole, container } = renderInteractive(<Harness />);
    const header = () => container.querySelector('th[aria-sort]') as HTMLElement;
    const button = getByRole('button', { name: /地图/u });

    expect(header().getAttribute('aria-sort')).toBe('none');

    fireEvent.click(button);
    expect(header().getAttribute('aria-sort')).toBe('ascending');

    fireEvent.click(button);
    expect(header().getAttribute('aria-sort')).toBe('descending');

    fireEvent.click(button);
    expect(header().getAttribute('aria-sort')).toBe('none');
  });
});
