import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { EvidenceSearchPage } from './EvidenceSearchPage';

describe('evidence search page', () => {
  it('renders a dense URL-backed evidence workbench without inventing loading counts', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/evidence-search?q=FalleN&event_family=kill&headshot=false&round=20']}>
        <EvidenceSearchPage />
      </MemoryRouter>,
    );

    expect(markup).toContain('data-testid="evidence-search-page"');
    expect(markup).toContain('data-testid="evidence-search-filters"');
    expect(markup).toContain('data-testid="evidence-search-results"');
    expect(markup).toContain('value="FalleN"');
    expect(markup).toContain('value="kill" selected=""');
    expect(markup).toContain('value="false" selected=""');
    expect(markup).toContain('value="20"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain('>0</strong>');
  });
});
