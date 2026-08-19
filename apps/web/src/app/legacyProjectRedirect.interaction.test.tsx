import { screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderInteractive } from '../test/render';
import { LegacyAgentRedirect, LegacyEditorRedirect, LegacyMontageRedirect, LegacyRecordingRedirect } from './router';

function LocationView() {
  const location = useLocation();
  return <span data-location>{location.pathname}{location.search}</span>;
}

async function redirected(from: string): Promise<string> {
  const rendered = renderInteractive(
    <MemoryRouter initialEntries={[from]}>
      <Routes>
        <Route path="/agent" element={<LegacyAgentRedirect />} />
        <Route path="/recording/:taskId?" element={<LegacyRecordingRedirect />} />
        <Route path="/montage/:projectId?" element={<LegacyMontageRedirect />} />
        <Route path="/editor/:projectId?" element={<LegacyEditorRedirect />} />
        <Route path="/projects" element={<LocationView />} />
        <Route path="/projects/:projectId" element={<LocationView />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(document.querySelector('[data-location]')).not.toBeNull());
  const result = screen.getByText(/\/projects/u).textContent ?? '';
  rendered.unmount();
  return result;
}

describe('legacy creation routes', () => {
  it('sends entity-scoped links to the matching project and step', async () => {
    expect(await redirected('/agent?plan=p-1')).toBe('/projects/plan%3Ap-1?step=shotlist');
    expect(await redirected('/recording/p-1')).toBe('/projects/plan%3Ap-1?step=record');
    expect(await redirected('/montage/m-1')).toBe('/projects/montage%3Am-1?step=shotlist');
    expect(await redirected('/editor/e-1')).toBe('/projects/editor%3Ae-1?step=shotlist');
  });

  it('sends unscoped legacy indexes to the project directory', async () => {
    expect(await redirected('/agent')).toBe('/projects/new?step=shotlist');
    expect(await redirected('/montage')).toBe('/projects');
    expect(await redirected('/editor')).toBe('/projects');
    expect(await redirected('/recording')).toBe('/projects?step=record');
  });
});
