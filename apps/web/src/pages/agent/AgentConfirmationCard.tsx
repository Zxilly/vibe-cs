import { Trans } from '@lingui/react/macro';
import { useCallback, useState } from 'react';

import { useDesktopClient } from '../../data/desktopClient';
import type { AgentChatStream } from '../../data/sessions';
import { Button } from '../../design/primitives';
import type {
  AgentSessionProposal,
  AgentSessionToolCall,
  BeatAlignmentProposalRequest,
  HighlightEditProposalRequest,
  ProposalConfirmation,
} from '../../shared/desktop/dto';

interface ConfirmationOutput {
  readonly confirmation: 'video_plan' | 'edit_plan' | 'beat_alignment';
  readonly status: 'pending' | 'approved';
  readonly approved: boolean;
  readonly automatic: boolean;
  readonly proposalId: string;
  readonly proposalKind: string;
  readonly title: string;
  readonly summary: string;
  readonly risks: readonly string[];
  readonly executionResult: unknown;
}

export interface AgentConfirmationCardProps {
  readonly call: AgentSessionToolCall;
  readonly proposal: AgentSessionProposal | undefined;
  readonly sessionId: string;
  readonly chat: AgentChatStream;
  readonly onContinueVideo: () => void;
}

export function AgentConfirmationCard({
  call,
  proposal,
  sessionId,
  chat,
  onContinueVideo,
}: AgentConfirmationCardProps) {
  const client = useDesktopClient();
  const confirmation = readConfirmationOutput(call.output);
  const [state, setState] = useState<'pending' | 'executing' | 'applied' | 'rejected' | 'failed'>(
    executionApplied(confirmation?.executionResult) ? 'applied' : 'pending',
  );
  const [failure, setFailure] = useState<string | null>(null);
  const delegatedPlanChanges = proposal?.kind === 'agent_plan_change';

  const report = useCallback(
    async (type: 'edit_execution_result' | 'beat_alignment_execution_result', result: unknown) => {
      await chat.send({
        sessionId,
        mode: 'edit',
        message: `STRUCTURED_AGENT_RESULT\n${JSON.stringify({ type, result })}`,
      });
    },
    [chat, sessionId],
  );

  const execute = useCallback(async () => {
    if (confirmation === null || proposal === undefined || state === 'executing') return;
    setState('executing');
    setFailure(null);
    try {
      if (proposal.kind === 'highlight_edit') {
        const request = proposal.payload as HighlightEditProposalRequest;
        const preview = await client.previewHighlightEditProposal(request);
        if (
          !preview.ready
          || preview.plan === null
          || preview.base_fingerprint === null
          || preview.proposal_fingerprint === null
          || preview.confirmation_token === null
        ) {
          throw new Error(preview.prerequisites.map((item) => item.message).join('; ') || '编辑预览尚未就绪');
        }
        const confirmationToken: ProposalConfirmation = {
          base_fingerprint: preview.base_fingerprint,
          proposal_fingerprint: preview.proposal_fingerprint,
          confirmation_token: preview.confirmation_token,
          expected_revision: preview.expected_revision,
          confirm: true,
        };
        const result = await client.applyHighlightEditProposal(request, preview.plan, confirmationToken);
        setState('applied');
        await report('edit_execution_result', result);
        return;
      }
      if (proposal.kind === 'beat_alignment') {
        const request = proposal.payload as BeatAlignmentProposalRequest;
        const preview = await client.previewBeatAlignmentProposal(request);
        if (
          !preview.ready
          || preview.base_fingerprint === null
          || preview.proposal_fingerprint === null
          || preview.confirmation_token === null
        ) {
          throw new Error(preview.prerequisites.map((item) => item.message).join('; ') || '卡点预览尚未就绪');
        }
        const result = await client.applyBeatAlignmentProposal(request, {
          base_fingerprint: preview.base_fingerprint,
          proposal_fingerprint: preview.proposal_fingerprint,
          confirmation_token: preview.confirmation_token,
          expected_revision: preview.expected_revision,
          confirm: true,
        });
        setState('applied');
        await report('beat_alignment_execution_result', result);
        return;
      }
      if (proposal.kind === 'video_render') {
        onContinueVideo();
        setState('applied');
        return;
      }
      throw new Error('这个确认需要在上方逐条执行方案变更');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setState('failed');
    }
  }, [client, confirmation, onContinueVideo, proposal, report, state]);

  if (confirmation === null) return null;
  return (
    <section
      data-agent-confirmation={confirmation.confirmation}
      data-confirmation-state={state}
      className="flex flex-col gap-2 border border-accent-300 bg-accent-50 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-neutral-950">{confirmation.title}</p>
          <p className="mt-1 whitespace-pre-wrap text-xs text-neutral-700">{confirmation.summary}</p>
        </div>
        <span className="border border-divider bg-bg px-2 py-1 text-2xs text-neutral-600">
          {confirmation.automatic ? <Trans>Auto 已批准</Trans> : <Trans>等待确认</Trans>}
        </span>
      </div>
      {confirmation.risks.length === 0 ? null : (
        <ul className="list-inside list-disc text-xs text-warn-text">
          {confirmation.risks.map((risk) => <li key={risk}>{risk}</li>)}
        </ul>
      )}
      {failure === null ? null : <p className="text-xs text-fail-text">{failure}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => void execute()}
          disabled={delegatedPlanChanges || state === 'executing' || state === 'applied' || chat.streaming}
        >
          {delegatedPlanChanges ? <Trans>请在上方逐条接受或拒绝</Trans>
            : state === 'executing' ? <Trans>正在执行</Trans>
            : state === 'applied' ? <Trans>已执行并回传</Trans>
            : proposal?.kind === 'video_render' ? <Trans>检查镜头并继续录制</Trans>
            : <Trans>预览并执行编辑</Trans>}
        </Button>
        {state === 'pending' || state === 'failed' ? (
          <Button
            size="sm"
            onClick={() => {
              setState('rejected');
              void chat.send({
                sessionId,
                mode: 'edit',
                message: `STRUCTURED_AGENT_RESULT\n${JSON.stringify({
                  type: 'confirmation_rejected',
                  confirmation: confirmation.confirmation,
                })}`,
              });
            }}
          >
            <Trans>拒绝并告诉 Agent</Trans>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export function confirmationProposalId(call: AgentSessionToolCall): string | null {
  return readConfirmationOutput(call.output)?.proposalId ?? null;
}

function readConfirmationOutput(value: unknown): ConfirmationOutput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    !['video_plan', 'edit_plan', 'beat_alignment'].includes(String(item.confirmation))
    || typeof item.proposalId !== 'string'
    || typeof item.title !== 'string'
    || typeof item.summary !== 'string'
    || !Array.isArray(item.risks)
  ) return null;
  return item as unknown as ConfirmationOutput;
}

function executionApplied(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).status === 'applied';
}
