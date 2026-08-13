type EditorProjectIdentity = { id: string };

export type EditorProjectUrlSelection<Project extends EditorProjectIdentity> =
  | { status: 'selected'; project: Project }
  | { status: 'empty' }
  | { status: 'missing'; requestedProjectId: string };

export function selectEditorProjectFromUrl<Project extends EditorProjectIdentity>(
  projects: readonly Project[],
  requestedProjectId: string | null,
): EditorProjectUrlSelection<Project> {
  if (requestedProjectId !== null) {
    const project = projects.find((candidate) => candidate.id === requestedProjectId);
    return project
      ? { status: 'selected', project }
      : { status: 'missing', requestedProjectId };
  }
  const first = projects[0];
  return first ? { status: 'selected', project: first } : { status: 'empty' };
}
