/*
 * `markup` project — the /evidence frame.
 *
 * A static render sees the first paint: the queries are still pending, so what
 * is asserted here is the frame and the loading state. The loaded, empty and
 * failed states are asserted on the pieces (`EvidenceResults`,
 * `EvidenceEmpty`, `EvidenceDetail`), which take everything as props, and the
 * wiring between them is `EvidencePage.interaction.test.tsx`.
 */

import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { renderMarkup } from '../../test/render';
import { EvidencePage } from '../EvidencePage';

/** No test in this layer talks to the real IPC bridge — there is no Tauri host
 *  under vitest. A never-settling stub keeps the page in its pending state,
 *  which is exactly the paint being asserted. */
const pending: Partial<DesktopClient> = {
  searchEvidence: () => new Promise(() => undefined),
  listEvidenceAnnotations: () => new Promise(() => undefined),
};

function at(url: string): string {
  return renderMarkup(
    <DesktopClientProvider client={pending as DesktopClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/evidence" element={<EvidencePage />} />
        </Routes>
      </MemoryRouter>
    </DesktopClientProvider>,
  );
}

describe('the page frame', () => {
  const html = at('/evidence');

  it('is a Page with a Toolbar carrying the §7 title', () => {
    expect(html).toContain('data-page=');
    expect(html).toContain('data-page-toolbar');
    expect(html).toContain('data-page-body');
    expect(html).toContain('证据检索');
  });

  it('takes the scroll boundary over — the results list owns its own', () => {
    expect(html).not.toMatch(/data-page-body="true" class="[^"]*overflow-auto/u);
  });

  it('shows the condition strip and the Inspector column', () => {
    expect(html).toContain('data-evidence-conditions');
    expect(html).toContain('data-inspector="docked"');
  });

  it('starts on the results, loading, with no invented progress', () => {
    expect(html).toContain('data-evidence-results="loading"');
    expect(html).not.toContain('role="progressbar"');
  });
});

describe('the §7 query', () => {
  it('/evidence?view=annotations switches face', () => {
    const html = at('/evidence?view=annotations');
    expect(html).toContain('注释');
    expect(html).toContain('data-evidence-annotations="loading"');
    // The condition strip belongs to the search face only.
    expect(html).not.toContain('data-evidence-conditions');
  });

  it('/evidence opens on the results, the §7 default', () => {
    expect(at('/evidence')).toContain('data-evidence-results');
  });

  it('renders the conditions it was given as chips', () => {
    const html = at('/evidence?player=Kael&map=de_mirage&headshot=1');
    expect(html).toContain('data-condition="player"');
    expect(html).toContain('Kael');
    expect(html).toContain('data-condition="map"');
    expect(html).toContain('data-condition="headshot"');
  });

  it('offers the conditions that are not set as ＋ chips', () => {
    const html = at('/evidence');
    expect(html).toContain('data-condition-add="player"');
    expect(html).toContain('data-condition-add="map"');
    expect(html).toContain('data-condition-add="weapon"');
    expect(html).toContain('data-condition-add="from"');
  });
});

describe('actions whose write path does not exist', () => {
  it('are disabled with the reason attached, never hidden', () => {
    const html = at('/evidence');
    expect(html).toContain('保存为视图');
    expect(html).toContain('导出结果');
    expect(html).toContain('注释写入尚未接通');
  });
});
