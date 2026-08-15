import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { TableCell, TableHeaderCell } from './TableCell';

function inTable(cell: ReactElement): string {
  return renderMarkup(
    <table>
      <tbody>
        <tr>{cell}</tr>
      </tbody>
    </table>,
  );
}

describe('TableCell', () => {
  it('renders a td with the body treatment', () => {
    const html = inTable(<TableCell>Mirage</TableCell>);
    expect(html).toContain('<td');
    expect(html).toContain('Mirage');
    expect(html).toContain('border-b');
  });

  it('sets numeric columns in mono with tabular figures', () => {
    // 「02 Demo 资料库」 puts 日期 / 时长 / 回合 in ui-monospace; tabular-nums keeps
    // the digits aligned when the CJK fallback face takes over.
    const html = inTable(<TableCell variant="numeric">41:02</TableCell>);
    expect(html).toContain('font-mono');
    expect(html).toContain('tabular-nums');
    expect(html).toContain('text-sm');
  });

  it('has a meta step for the 12px muted suffix', () => {
    const html = inTable(<TableCell variant="meta">· Aurora</TableCell>);
    expect(html).toContain('text-xs');
    expect(html).toContain('text-neutral-600');
  });

  it('combines mono and meta for the 片段 index column', () => {
    const html = inTable(<TableCell variant="numeric-meta">01</TableCell>);
    expect(html).toContain('font-mono');
    expect(html).toContain('text-xs');
    expect(html).toContain('text-neutral-600');
  });

  it('indents the gutter edges and leaves the middle on the Industry step', () => {
    expect(inTable(<TableCell edge="leading">a</TableCell>)).toContain('pl-6');
    expect(inTable(<TableCell edge="trailing">a</TableCell>)).toContain('pr-6');
    expect(inTable(<TableCell edge="both">a</TableCell>)).toContain('px-6');
    expect(inTable(<TableCell>a</TableCell>)).toContain('px-2');
  });

  it('can be right aligned and truncated', () => {
    const html = inTable(
      <TableCell align="end" truncate title="aurora-meridian-mirage.dem">
        aurora-meridian-mirage.dem
      </TableCell>,
    );
    expect(html).toContain('text-right');
    expect(html).toContain('truncate');
    expect(html).toContain('title="aurora-meridian-mirage.dem"');
  });
});

describe('TableHeaderCell', () => {
  it('renders a column-scoped th at the 34px header height', () => {
    const html = renderMarkup(
      <table>
        <thead>
          <tr>
            <TableHeaderCell>地图</TableHeaderCell>
          </tr>
        </thead>
      </table>,
    );
    expect(html).toContain('<th');
    expect(html).toContain('scope="col"');
    expect(html).toContain('h-[var(--h-thead)]');
    // Industry's own .table th: smallest step, wide tracking, upper case.
    expect(html).toContain('text-2xs');
    expect(html).toContain('tracking-wide');
    expect(html).toContain('uppercase');
  });

  it('does not drag a body font size into the header', () => {
    const html = renderMarkup(
      <table>
        <thead>
          <tr>
            <TableHeaderCell variant="numeric">tick</TableHeaderCell>
          </tr>
        </thead>
      </table>,
    );
    expect(html).toContain('font-mono');
    expect(html).not.toContain('text-sm');
  });
});
