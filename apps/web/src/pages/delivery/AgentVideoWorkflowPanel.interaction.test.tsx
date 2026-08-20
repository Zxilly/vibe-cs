import { fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNativeShell } from '../../data/nativeShell';
import { useExportAgentComposition } from '../../data/plans';
import { useAgentVideoWorkflow } from '../../data/tasks';
import type { AgentVideoWorkflow } from '../../shared/desktop/dto';
import { renderInteractive } from '../../test/render';
import { AgentVideoWorkflowPanel } from './AgentVideoWorkflowPanel';

vi.mock('../../data/tasks', () => ({ useAgentVideoWorkflow: vi.fn() }));
vi.mock('../../data/plans', () => ({ useExportAgentComposition: vi.fn() }));
vi.mock('../../data/nativeShell', () => ({ useNativeShell: vi.fn() }));

const mutate = vi.fn();
const reveal = vi.fn(() => Promise.resolve(true));

function workflow(stage: AgentVideoWorkflow['stage']): AgentVideoWorkflow {
  return {
    plan_id: 'plan-1',
    stage,
    recording_status: 'completed',
    recorded_takes: 4,
    total_shots: 4,
    composition: {
      id: 'composition-1',
      plan_id: 'plan-1',
      plan_revision: 3,
      title: 'Final',
      status: stage === 'completed' ? 'exported' : 'confirmed',
      items: [0, 1, 2, 3].map((order) => ({
        shot_id: `shot-${order + 1}`,
        take_id: `take-${order + 1}`,
        order,
      })),
      export_job_id: stage === 'completed' ? 'export-1' : null,
      export_status: stage === 'completed' ? 'completed' : null,
      output_path: stage === 'completed' ? 'C:/outputs/final.mp4' : null,
      error: null,
      created_at: '2026-08-20T00:00:00.000Z',
      updated_at: '2026-08-20T00:01:00.000Z',
    },
  };
}

beforeEach(() => {
  mutate.mockReset();
  reveal.mockClear();
  vi.mocked(useNativeShell).mockReturnValue({ available: true, reveal } as never);
  vi.mocked(useExportAgentComposition).mockReturnValue({
    mutate,
    isPending: false,
    error: null,
  } as never);
});

describe('AgentVideoWorkflowPanel', () => {
  it('announces the completed end-to-end workflow and locates the final file', () => {
    vi.mocked(useAgentVideoWorkflow).mockReturnValue({
      data: workflow('completed'),
      error: null,
    } as never);

    renderInteractive(<MemoryRouter><AgentVideoWorkflowPanel recordingJobId="job-1" /></MemoryRouter>);

    expect(screen.getByLabelText('Agent 成片流程').getAttribute('aria-live')).toBe('polite');
    expect(screen.getAllByText('成品可用')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '定位成品' }));
    expect(reveal).toHaveBeenCalledWith('C:/outputs/final.mp4');
  });

  it('continues export without asking the user to rebuild the composition', () => {
    vi.mocked(useAgentVideoWorkflow).mockReturnValue({
      data: workflow('ready_to_export'),
      error: null,
    } as never);

    renderInteractive(<MemoryRouter><AgentVideoWorkflowPanel recordingJobId="job-1" /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '继续导出' }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
