import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EditorMissingProjectNotice } from './EditorPage';
import { selectEditorProjectFromUrl } from './editorProjectSelection';

const editorSource = readFileSync(new URL('./EditorPage.tsx', import.meta.url), 'utf8');

describe('Editor project URL selection', () => {
  it('fails closed when an explicit project no longer exists', () => {
    const result = selectEditorProjectFromUrl(
      [{ id: 'unrelated-project' }],
      'deleted-source-project',
    );

    expect(result).toEqual({
      status: 'missing',
      requestedProjectId: 'deleted-source-project',
    });
  });

  it('uses the first project only when the URL does not request one', () => {
    const projects = [{ id: 'first-project' }, { id: 'second-project' }];

    expect(selectEditorProjectFromUrl(projects, null)).toEqual({
      status: 'selected',
      project: projects[0],
    });
  });

  it('selects the exact requested project and represents a genuinely empty workspace', () => {
    const projects = [{ id: 'first-project' }, { id: 'requested-project' }];

    expect(selectEditorProjectFromUrl(projects, 'requested-project')).toEqual({
      status: 'selected',
      project: projects[1],
    });
    expect(selectEditorProjectFromUrl([], null)).toEqual({ status: 'empty' });
  });

  it('makes a missing requested project visible without presenting another project', () => {
    const markup = renderToStaticMarkup(createElement(EditorMissingProjectNotice, {
      projectId: 'deleted-source-project',
      projectLabel: 'Editing projects',
      unavailableLabel: 'Unavailable',
    }));

    expect(markup).toContain('notice--danger');
    expect(markup).toContain('Editing projects · deleted-source-project · Unavailable');
    expect(markup).not.toContain('unrelated-project');
  });

  it('wires service results through exact selection, including an explicit empty project id', () => {
    expect(editorSource).toContain(
      'const selection = selectEditorProjectFromUrl(response.items, requestedProjectId);',
    );
    expect(editorSource).not.toMatch(
      /find\(\(project\) => project\.id === requestedProjectId\) \?\? response\.items\[0\]/,
    );
    expect(editorSource).toContain('missingProjectId !== null ? <EditorMissingProjectNotice');
  });
});
