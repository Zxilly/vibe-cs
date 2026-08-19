import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../test/render';
import { ProjectsPage } from './ProjectsPage';

describe('/projects loading skeleton', () => {
  const html = renderMarkup(<MemoryRouter><ProjectsPage /></MemoryRouter>);

  it('uses Page and Toolbar chrome', () => {
    expect(html).toContain('data-page=');
    expect(html).toContain('data-toolbar-title="true"');
    expect(html).toContain('作品');
  });

  it('renders an honest loading state without fake project facts', () => {
    expect(html).toContain('data-projects-list');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="progressbar"');
  });
});
