import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import type { AgentChatStream } from '../../data/sessions';
import type { AgentSessionProposal, AgentSessionToolCall } from '../../shared/desktop/dto';
import { AgentConfirmationCard } from './AgentConfirmationCard';

const CALL: AgentSessionToolCall = {
  name: 'confirm_edit_plan',
  input: { proposalId: '00000000-0000-4000-8000-0000000000a1', title: '执行高光剪辑', summary: '把 ace-1 写入编辑工程' },
  output: {
    confirmation: 'edit_plan',
    status: 'pending',
    approved: false,
    automatic: false,
    proposalId: '00000000-0000-4000-8000-0000000000a1',
    proposalKind: 'highlight_edit',
    title: '执行高光剪辑',
    summary: '把 ace-1 写入编辑工程',
    risks: ['会创建或修改编辑工程'],
    executionResult: null,
  },
};

const PROPOSAL: AgentSessionProposal = {
  proposal_id: '00000000-0000-4000-8000-0000000000a1',
  kind: 'highlight_edit',
  title: '高光剪辑',
  plan_id: null,
  based_on_revision: null,
  payload: {
    demo_id: 'demo-1',
    highlight_ids: ['ace-1'],
    intent: { pacing: 'impact', include_context_seconds: 2, transition: 'cut' },
    target_project_id: null,
    expected_revision: null,
    new_project_name: 'Agent edit',
  },
};

describe('AgentConfirmationCard', () => {
  it('previews and executes an edit, then returns the structured result to the Agent', async () => {
    const previewHighlightEditProposal = vi.fn().mockResolvedValue({
      ready: true,
      prerequisites: [],
      mappings: [],
      insertions: [],
      target_project_id: 'project-1',
      creates_new_project: true,
      expected_revision: 0,
      base_fingerprint: 'base',
      proposal_fingerprint: 'proposal',
      confirmation_token: 'token',
      plan: { project_id: 'project-1' },
    });
    const result = {
      project_id: 'project-1',
      previous_revision: 0,
      revision: 1,
      inserted_clip_ids: ['clip-1'],
      project_created: true,
      snapshot_created: true,
      already_applied: false,
    };
    const applyHighlightEditProposal = vi.fn().mockResolvedValue(result);
    const send = vi.fn().mockResolvedValue(undefined);
    const chat: AgentChatStream = {
      streaming: false,
      draft: '',
      error: null,
      send,
      cancel: vi.fn(),
    };
    const client = {
      previewHighlightEditProposal,
      applyHighlightEditProposal,
    } as unknown as DesktopClient;

    render(
      <I18nProvider i18n={i18n}>
        <DesktopClientProvider client={client}>
          <AgentConfirmationCard
            call={CALL}
            proposal={PROPOSAL}
            sessionId="session-1"
            chat={chat}
            onContinueVideo={vi.fn()}
          />
        </DesktopClientProvider>
      </I18nProvider>,
    );

    expect(screen.getByText('执行高光剪辑')).toBeTruthy();
    expect(screen.getByText('会创建或修改编辑工程')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '预览并执行编辑' }));

    await waitFor(() => expect(applyHighlightEditProposal).toHaveBeenCalledTimes(1));
    expect(previewHighlightEditProposal).toHaveBeenCalledWith(PROPOSAL.payload);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      mode: 'edit',
      message: expect.stringContaining('"type":"edit_execution_result"'),
    }));
    expect(screen.getByRole('button', { name: '已执行并回传' }).hasAttribute('disabled')).toBe(true);
  });
});
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
