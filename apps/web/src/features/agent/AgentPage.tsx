import {
  AssistantRuntimeProvider,
  type AppendMessage,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import { Bot, CheckCircle2, Film, Music2, Send, Sparkles, Square, Wrench } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import type {
  AgentMessage,
  AgentMode,
  AgentProposal,
  AgentStatus,
  BeatAlignmentProposalPreview,
  BeatAlignmentProposalRequest,
  DemoSummary,
  EditorProject,
  HighlightEditProposalPreview,
  HighlightEditProposalRequest,
  HlaeProposalIntent,
  HlaeProposalPreview,
  MediaAsset,
  ProposalPrerequisite,
} from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, EmptyState, Notice, PageHeader, SegmentedControl, Spinner } from '../../shared/ui';
import { applyAgentEvent, proposalActivityKey, rollbackOptimisticRun } from './agentSession';

import './agent.css';

const THREAD_STORAGE_KEY = 'vibe-cs.agent-thread.v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function storedThreadId() {
  try {
    const stored = JSON.parse(localStorage.getItem(THREAD_STORAGE_KEY) ?? 'null') as unknown;
    if (!stored || typeof stored !== 'object') return null;
    const value = stored as { version?: unknown; threadId?: unknown };
    return value.version === 1 && typeof value.threadId === 'string' && UUID_PATTERN.test(value.threadId)
      ? value.threadId
      : null;
  } catch {
    return null;
  }
}

function persistThreadId(threadId: string) {
  localStorage.setItem(THREAD_STORAGE_KEY, JSON.stringify({ version: 1, threadId }));
}

function messageText(message: AppendMessage) {
  return message.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function convertMessage(message: AgentMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [{ type: 'text', text: message.content }],
    createdAt: new Date(message.createdAt),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function proposalSummary(proposal: AgentProposal): string {
  const payload = record(proposal.payload);
  if (!payload) return 'Validated local draft';
  if (proposal.kind === 'beat_alignment') {
    const draft = record(payload.draft);
    const count = Array.isArray(draft?.clips) ? draft.clips.length : 0;
    return `Native beat alignment · ${count} clips · advisory only`;
  }
  if (proposal.kind === 'hlae') {
    const highlights = Array.isArray(payload.highlight_ids) ? payload.highlight_ids.length : 0;
    return `HLAE intent · ${highlights} highlights · Rust preview required`;
  }
  const highlights = Array.isArray(payload.highlight_ids) ? payload.highlight_ids.length : 0;
  return `Recorded highlight edit · ${highlights} highlights · local assets required`;
}

type ProposalPreview =
  | { kind: 'hlae'; value: HlaeProposalPreview; request: HlaeProposalIntent }
  | { kind: 'beat_alignment'; value: BeatAlignmentProposalPreview; request: BeatAlignmentProposalRequest }
  | { kind: 'highlight_edit'; value: HighlightEditProposalPreview; request: HighlightEditProposalRequest };

function prerequisites(preview: ProposalPreview | null): ProposalPrerequisite[] {
  return preview?.value.prerequisites ?? [];
}

function numberField(value: Record<string, unknown> | null, key: string): number | null {
  const field = value?.[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function hlaeShotRecords(preview: HlaeProposalPreview): Record<string, unknown>[] {
  const shots = record(preview.typed_plan)?.shots;
  return Array.isArray(shots) ? shots.map(record).filter((shot): shot is Record<string, unknown> => shot !== null) : [];
}

function beatProjectMatchesPreview(preview: BeatAlignmentProposalPreview, project: EditorProject | undefined): boolean {
  if (!project || project.id !== preview.project_id || project.revision !== preview.expected_revision) return false;
  const clipIds = new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  return preview.changes.length > 0 && preview.changes.every((change) => clipIds.has(change.clip_id));
}

function hasReviewableChanges(preview: ProposalPreview | null, project?: EditorProject): boolean {
  if (!preview?.value.ready) return false;
  if (preview.kind === 'hlae') {
    const plan = record(preview.value.typed_plan);
    const compiled = record(preview.value.compiled_preview);
    return plan !== null && compiled !== null && hlaeShotRecords(preview.value).length > 0;
  }
  if (preview.kind === 'beat_alignment') return beatProjectMatchesPreview(preview.value, project);
  return preview.value.mappings.length > 0;
}

function ProposalPreviewDetails({ preview, project }: { preview: ProposalPreview; project?: EditorProject }) {
  const { t } = useI18n();
  if (!preview.value.ready) return null;

  if (preview.kind === 'beat_alignment') {
    const clips = new Map(project?.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)) ?? []);
    return (
      <section className="agent-proposal-details" aria-label={t('copilot.changeReview')}>
        <dl>
          <div><dt>{t('copilot.project')}</dt><dd>{preview.value.project_id}</dd></div>
          <div><dt>{t('copilot.revision')}</dt><dd>{preview.value.expected_revision}</dd></div>
          <div><dt>{t('copilot.clipChanges')}</dt><dd>{preview.value.changes.length}</dd></div>
        </dl>
        <ol className="agent-proposal-details__changes">
          {preview.value.changes.map((clip) => {
            const current = clips.get(clip.clip_id);
            return (
              <li key={clip.clip_id}>
                <strong>{clip.clip_id}</strong>
                <span>{t('copilot.timeline')}: {current ? `${current.start.toFixed(3)}s → ${(current.start + current.duration).toFixed(3)}s` : '—'}</span>
                <span>{t('copilot.target')}: {clip.timeline_start_seconds.toFixed(3)}s → {clip.timeline_end_seconds.toFixed(3)}s</span>
                <span>{t('copilot.duration')}: {current ? `${current.duration.toFixed(3)}s` : '—'} → {clip.planned_duration_seconds.toFixed(3)}s</span>
              </li>
            );
          })}
        </ol>
      </section>
    );
  }

  if (preview.kind === 'highlight_edit') {
    return (
      <section className="agent-proposal-details" aria-label={t('copilot.changeReview')}>
        <dl>
          <div><dt>Demo</dt><dd>{preview.request.demo_id}</dd></div>
          <div><dt>{t('copilot.project')}</dt><dd>{preview.value.target_project_id ?? '—'}</dd></div>
          <div><dt>{t('copilot.revision')}</dt><dd>{preview.value.creates_new_project ? t('copilot.newProject') : preview.value.expected_revision}</dd></div>
          <div><dt>{t('copilot.recordedClips')}</dt><dd>{preview.value.mappings.length}</dd></div>
        </dl>
        <ol className="agent-proposal-details__changes">
          {preview.value.mappings.map((mapping) => (
            <li key={mapping.highlight_id}>
              <strong>{mapping.highlight_id}</strong>
              <span>{mapping.recorded_clip_id}</span>
              <span>{mapping.duration_seconds.toFixed(3)}s · {(mapping.file_size / 1_048_576).toFixed(1)} MiB</span>
              {preview.value.insertions.find((item) => item.highlight_id === mapping.highlight_id) ? (
                <span>
                  {t('copilot.timeline')}: {preview.value.insertions.find((item) => item.highlight_id === mapping.highlight_id)!.timeline_start_seconds.toFixed(3)}s
                  {' → '}
                  {preview.value.insertions.find((item) => item.highlight_id === mapping.highlight_id)!.timeline_end_seconds.toFixed(3)}s
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    );
  }

  const plan = record(preview.value.typed_plan);
  const compiled = record(preview.value.compiled_preview);
  const capture = record(plan?.capture);
  const shots = hlaeShotRecords(preview.value);
  const firstTick = numberField(compiled, 'firstTick');
  const lastTick = numberField(compiled, 'lastTick');
  const cameraPaths = Array.isArray(compiled?.cameraPaths) ? compiled.cameraPaths : [];
  const artifacts = [compiled?.bootstrapConfig, compiled?.commandSystem, ...cameraPaths]
    .map(record)
    .map((artifact) => stringField(artifact, 'path'))
    .filter((path): path is string => path !== null);
  const outputDirectory = stringField(plan, 'outputDirectory');
  return (
    <section className="agent-proposal-details" aria-label={t('copilot.changeReview')}>
      <dl>
        <div><dt>Demo</dt><dd>{preview.request.demo_id}</dd></div>
        <div><dt>{t('copilot.cameraStyle')}</dt><dd>{preview.request.camera_style}</dd></div>
        <div><dt>{t('copilot.mode')}</dt><dd>{preview.request.mode}</dd></div>
        <div><dt>{t('copilot.shots')}</dt><dd>{shots.length}</dd></div>
        <div><dt>{t('copilot.highlights')}</dt><dd>{preview.request.highlight_ids.length}</dd></div>
        <div><dt>{t('copilot.tickRange')}</dt><dd>{firstTick ?? '—'} → {lastTick ?? '—'}</dd></div>
        <div><dt>{t('copilot.capture')}</dt><dd>{numberField(capture, 'width') ?? '—'}×{numberField(capture, 'height') ?? '—'} · {numberField(capture, 'fps') ?? '—'} fps</dd></div>
        <div className="agent-proposal-details__wide"><dt>{t('copilot.outputDirectory')}</dt><dd title={outputDirectory ?? undefined}>{outputDirectory ?? '—'}</dd></div>
        <div><dt>{t('copilot.generatedPaths')}</dt><dd>{artifacts.length}</dd></div>
        <div className="agent-proposal-details__wide"><dt>{t('copilot.highlights')}</dt><dd>{preview.request.highlight_ids.join(', ')}</dd></div>
      </dl>
      <ol className="agent-proposal-details__changes">
        {shots.map((shot, index) => {
          const keyframes = Array.isArray(shot.keyframes) ? shot.keyframes.length : 0;
          return (
            <li key={stringField(shot, 'id') ?? index}>
              <strong>{stringField(shot, 'id') ?? `${t('copilot.shot')} ${index + 1}`}</strong>
              <span>{numberField(shot, 'startTick') ?? '—'} → {numberField(shot, 'endTick') ?? '—'} tick</span>
              <span>{keyframes} {t('copilot.keyframes')}</span>
            </li>
          );
        })}
      </ol>
      <div className="agent-proposal-details__artifacts">
        <strong>{t('copilot.generatedPaths')}</strong>
        <ul>{artifacts.map((path) => <li key={path} title={path}>{path}</li>)}</ul>
      </div>
      {preview.value.notices.length > 0 ? (
        <div className="agent-proposal-details__notices">
          <strong>{t('copilot.notices')}</strong>
          <ul>{preview.value.notices.map((notice, index) => <li key={`${index}:${notice}`}>{notice}</li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}

function ProposalCard({ proposal, projects }: { proposal: AgentProposal; projects: EditorProject[] }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<ProposalPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const beatProject = preview?.kind === 'beat_alignment'
    ? projects.find((project) => project.id === preview.value.project_id)
    : undefined;
  const reviewable = useMemo(() => hasReviewableChanges(preview, beatProject), [beatProject, preview]);

  useEffect(() => {
    generationRef.current += 1;
    setPreview(null);
    setError(null);
    setBusy(false);
    return () => {
      generationRef.current += 1;
    };
  }, [proposal]);

  const inspect = useCallback(async () => {
    if (busy) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setBusy(true);
    setError(null);
    try {
      let next: ProposalPreview;
      if (proposal.kind === 'hlae') {
        const request = proposal.payload as HlaeProposalIntent;
        next = { kind: 'hlae', request, value: await commands.previewHlaeProposal(request) };
      } else if (proposal.kind === 'beat_alignment') {
        const request = proposal.payload as BeatAlignmentProposalRequest;
        next = { kind: 'beat_alignment', request, value: await commands.previewBeatAlignmentProposal(request) };
      } else {
        const request = proposal.payload as HighlightEditProposalRequest;
        next = { kind: 'highlight_edit', request, value: await commands.previewHighlightEditProposal(request) };
      }
      if (generationRef.current === generation) setPreview(next);
    } catch (cause) {
      if (generationRef.current === generation) setError(readableError(cause));
    } finally {
      if (generationRef.current === generation) setBusy(false);
    }
  }, [busy, proposal]);

  const apply = useCallback(async () => {
    if (!preview || !reviewable || busy) return;
    const target = preview.kind === 'hlae'
      ? `Demo ${preview.request.demo_id} · ${hlaeShotRecords(preview.value).length} ${t('copilot.shots')}`
      : preview.kind === 'beat_alignment'
        ? `${t('copilot.project')} ${preview.value.project_id} · ${preview.value.changes.length} ${t('copilot.clipChanges')}`
        : `${t('copilot.project')} ${preview.value.target_project_id ?? '—'} · ${preview.value.insertions.length} ${t('copilot.clipChanges')}`;
    if (!window.confirm(`${t(preview.kind === 'hlae' ? 'copilot.confirmExport' : 'copilot.confirmApply')}\n\n${target}`)) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setBusy(true);
    setError(null);
    try {
      const value = preview.value;
      if (!value.base_fingerprint || !value.proposal_fingerprint || !value.confirmation_token) {
        throw new Error(t('copilot.previewExpired'));
      }
      const confirmation = {
        base_fingerprint: value.base_fingerprint,
        proposal_fingerprint: value.proposal_fingerprint,
        confirmation_token: value.confirmation_token,
        expected_revision: preview.kind === 'hlae'
          ? preview.value.proposal_revision
          : preview.value.expected_revision,
        confirm: true as const,
      };
      if (preview.kind === 'hlae') {
        await commands.exportHlaeProposal(preview.request, confirmation);
        if (generationRef.current === generation) navigate('/outputs');
      } else if (preview.kind === 'beat_alignment') {
        await commands.applyBeatAlignmentProposal(preview.request, confirmation);
        if (generationRef.current === generation) navigate('/studio/editor');
      } else {
        if (!preview.value.plan) throw new Error(t('copilot.previewExpired'));
        const result = await commands.applyHighlightEditProposal(preview.request, preview.value.plan, confirmation);
        if (generationRef.current === generation) navigate(`/studio/editor?project=${encodeURIComponent(result.project_id)}`);
      }
    } catch (cause) {
      if (generationRef.current === generation) setError(readableError(cause));
    } finally {
      if (generationRef.current === generation) setBusy(false);
    }
  }, [busy, navigate, preview, reviewable, t]);

  const missing = prerequisites(preview);
  return (
    <div className="agent-proposal-card">
      <strong>{proposal.title}</strong>
      <p>{proposalSummary(proposal)}</p>
      {error ? <span className="agent-proposal-card__error">{error}</span> : null}
      {preview ? (
        <>
          <Badge tone={preview.value.ready ? 'success' : 'warning'}>
            {preview.value.ready ? t('copilot.previewReady') : t('copilot.previewBlocked')}
          </Badge>
          <ProposalPreviewDetails preview={preview} {...(beatProject ? { project: beatProject } : {})} />
          {preview.value.ready && !reviewable ? (
            <span className="agent-proposal-card__error">{t('copilot.previewIncomplete')}</span>
          ) : null}
        </>
      ) : null}
      {missing.length > 0 ? (
        <ul>{missing.map((item) => <li key={item.code}>{item.message}</li>)}</ul>
      ) : null}
      <div className="agent-proposal-card__actions">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void inspect()}>
          {busy ? <Spinner /> : null}{t('copilot.preview')}
        </Button>
        <Button size="sm" variant="primary" disabled={busy || !reviewable} onClick={() => void apply()}>
          {proposal.kind === 'hlae' ? t('copilot.export') : t('copilot.apply')}
        </Button>
      </div>
    </div>
  );
}

function UserMessage() {
  const { t } = useI18n();
  return (
    <MessagePrimitive.Root className="agent-message agent-message--user">
      <span className="agent-message__author">{t('copilot.you')}</span>
      <div className="agent-message__bubble"><MessagePrimitive.Parts /></div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const { t } = useI18n();
  return (
    <MessagePrimitive.Root className="agent-message agent-message--assistant">
      <span className="agent-message__author"><Bot size={15} />{t('copilot.assistant')}</span>
      <div className="agent-message__bubble"><MessagePrimitive.Parts /></div>
    </MessagePrimitive.Root>
  );
}

function AgentThread() {
  const { t } = useI18n();
  return (
    <ThreadPrimitive.Root className="agent-thread">
      <ThreadPrimitive.Viewport className="agent-thread__viewport">
        <AuiIf condition={(state) => state.thread.isEmpty}>
          <EmptyState
            icon={<Sparkles size={28} />}
            title={t('copilot.emptyTitle')}
            description={t('copilot.emptyDescription')}
            action={(
              <div className="agent-suggestions">
                <ThreadPrimitive.Suggestion prompt={t('copilot.suggestion.review')} send>
                  {t('copilot.suggestion.review')}
                </ThreadPrimitive.Suggestion>
                <ThreadPrimitive.Suggestion prompt={t('copilot.suggestion.edit')} send>
                  {t('copilot.suggestion.edit')}
                </ThreadPrimitive.Suggestion>
                <ThreadPrimitive.Suggestion prompt={t('copilot.suggestion.hlae')} send>
                  {t('copilot.suggestion.hlae')}
                </ThreadPrimitive.Suggestion>
              </div>
            )}
          />
        </AuiIf>
        <ThreadPrimitive.Messages>
          {({ message }) => message.role === 'user' ? <UserMessage /> : <AssistantMessage />}
        </ThreadPrimitive.Messages>
        <ThreadPrimitive.ViewportFooter className="agent-composer-wrap">
          <ComposerPrimitive.Root className="agent-composer">
            <ComposerPrimitive.Input
              className="agent-composer__input"
              placeholder={t('copilot.placeholder')}
              submitMode="enter"
              rows={2}
            />
            <ComposerPrimitive.Send className="agent-composer__send" aria-label={t('copilot.send')}>
              <Send size={18} />
            </ComposerPrimitive.Send>
            <ComposerPrimitive.Cancel className="agent-composer__cancel" aria-label={t('copilot.cancel')}>
              <Square size={16} />
            </ComposerPrimitive.Cancel>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function ContextSelect({
  label,
  icon,
  value,
  onChange,
  disabled,
  children,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <label className="agent-context-field">
      <span>{icon}{label}</span>
      <select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>
    </label>
  );
}

export function AgentPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [initialThreadId] = useState(storedThreadId);
  const [threadId, setThreadId] = useState<string | null>(initialThreadId);
  const [mode, setMode] = useState<AgentMode>('guide');
  const [demos, setDemos] = useState<DemoSummary[]>([]);
  const [projects, setProjects] = useState<EditorProject[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [demoId, setDemoId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [audioAssetId, setAudioAssetId] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const threadPromise = initialThreadId ? commands.getAgentThread(initialThreadId) : Promise.resolve(null);
    void Promise.all([
      commands.agentStatus(),
      commands.listDemos({ page: 1, page_size: 50, sort: 'newest' }, controller.signal),
      commands.listEditorProjects(controller.signal),
      commands.listMediaAssets(undefined, controller.signal),
      threadPromise,
    ]).then(([nextStatus, demoPage, projectPage, assetPage, thread]) => {
      if (controller.signal.aborted) return;
      setStatus(nextStatus);
      setDemos(demoPage.items);
      setProjects(projectPage.items);
      setAssets(assetPage.items);
      if (thread) setMessages(thread.messages);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(readableError(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setIsLoading(false);
    });
    return () => {
      controller.abort();
      generationRef.current += 1;
      const requestId = requestIdRef.current;
      if (requestId) void commands.cancelAgentChat(requestId).catch(() => undefined);
    };
  }, [initialThreadId]);

  const onNew = useCallback(async (message: AppendMessage) => {
    if (isRunning) return;
    const content = messageText(message);
    if (!content) return;
    const createdAt = new Date().toISOString();
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    requestIdRef.current = requestId;
    const contextSnapshot = { threadId, demoId, projectId, audioAssetId, mode };
    setMessages((current) => [
      ...current,
      { id: userId, role: 'user', content, createdAt, toolCalls: [], proposals: [] },
      { id: assistantId, role: 'assistant', content: '', createdAt, toolCalls: [], proposals: [] },
    ]);
    setIsRunning(true);
    setError(null);
    try {
      await commands.streamAgentChat({
        requestId,
        ...(contextSnapshot.threadId ? { threadId: contextSnapshot.threadId } : {}),
        ...(contextSnapshot.demoId ? { demoId: contextSnapshot.demoId } : {}),
        ...(contextSnapshot.projectId ? { editorProjectId: contextSnapshot.projectId } : {}),
        ...(contextSnapshot.audioAssetId ? { audioAssetId: contextSnapshot.audioAssetId } : {}),
        mode: contextSnapshot.mode,
        message: content,
      }, (event) => {
        if (generationRef.current !== generation) return;
        if (event.type === 'started') {
          setThreadId(event.threadId);
          persistThreadId(event.threadId);
        } else {
          setMessages((current) => applyAgentEvent(current, assistantId, event));
          if (event.type === 'error') setError(event.message);
        }
      });
    } catch (cause) {
      if (generationRef.current === generation) {
        setMessages((current) => rollbackOptimisticRun(current, userId, assistantId));
        setError(readableError(cause));
      }
    } finally {
      if (generationRef.current === generation) {
        requestIdRef.current = null;
        setIsRunning(false);
      }
    }
  }, [audioAssetId, demoId, isRunning, mode, projectId, threadId]);

  const onCancel = useCallback(async () => {
    const requestId = requestIdRef.current;
    if (requestId) await commands.cancelAgentChat(requestId);
  }, []);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning,
    isSendDisabled: !status?.configured || !status.sidecarAvailable,
    onNew,
    onCancel,
  });

  const activity = useMemo(() => messages.flatMap((message) => [
    ...message.toolCalls.map((toolCall, index) => ({
      id: `${message.id}:tool:${index}`, kind: 'tool' as const,
      name: toolCall.name, summary: t('copilot.toolComplete'),
    })),
    ...message.proposals.map((proposal: AgentProposal, index) => ({
      id: proposalActivityKey(message.id, index), kind: 'proposal' as const,
      name: proposal.title, summary: proposalSummary(proposal), proposal,
    })),
  ]).reverse().slice(0, 12), [messages, t]);
  const audioAssets = useMemo(() => assets.filter((asset) => asset.has_audio), [assets]);

  if (isLoading) {
    return <div className="page-state"><Spinner label={t('copilot.loading')} /><span>{t('copilot.loading')}</span></div>;
  }

  const statusTone = status?.configured && status.sidecarAvailable ? 'success' : 'warning';
  const statusText = !status?.sidecarAvailable
    ? t('copilot.noSidecar')
    : status.configured ? t('copilot.ready') : t('copilot.notConfigured');

  return (
    <main className="page agent-page">
      <PageHeader
        eyebrow={t('copilot.eyebrow')}
        title={t('copilot.title')}
        description={t('copilot.description')}
        actions={<Badge tone={statusTone}>{statusText}</Badge>}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <section className="agent-context" aria-label={t('copilot.context')} aria-busy={isRunning}>
        <div className="agent-context__heading">
          <strong>{t('copilot.context')}</strong>
          <SegmentedControl
            label={t('copilot.context')}
            value={mode}
            onChange={setMode}
            disabled={isRunning}
            options={[
              { value: 'guide', label: t('copilot.mode.guide') },
              { value: 'edit', label: t('copilot.mode.edit') },
              { value: 'hlae', label: t('copilot.mode.hlae') },
            ]}
          />
        </div>
        <div className="agent-context__grid">
          <ContextSelect disabled={isRunning} label={t('copilot.matchFile')} icon={<Film size={15} />} value={demoId} onChange={setDemoId}>
            <option value="">{t('copilot.none')}</option>
            {demos.map((demo) => <option key={demo.id} value={demo.id}>{demo.display_name}</option>)}
          </ContextSelect>
          <ContextSelect disabled={isRunning} label={t('copilot.project')} icon={<Sparkles size={15} />} value={projectId} onChange={setProjectId}>
            <option value="">{t('copilot.none')}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </ContextSelect>
          <ContextSelect disabled={isRunning} label={t('copilot.bgm')} icon={<Music2 size={15} />} value={audioAssetId} onChange={setAudioAssetId}>
            <option value="">{t('copilot.none')}</option>
            {audioAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </ContextSelect>
        </div>
        <div className="agent-context__status">
          {status?.configured ? <span><CheckCircle2 size={14} />{status.provider} · {status.model}</span>
            : <Link className="button button--secondary button--sm" to="/settings">{t('copilot.configure')}</Link>}
        </div>
      </section>
      <div className="agent-workspace">
        <section className="agent-chat-panel">
          <AssistantRuntimeProvider runtime={runtime}><AgentThread /></AssistantRuntimeProvider>
        </section>
        <aside className="agent-activity">
          <header><Wrench size={17} /><strong>{t('copilot.activity')}</strong></header>
          {activity.length === 0 ? <p>{t('copilot.noActivity')}</p> : (
            <ol>
              {activity.map((item) => (
                <li key={item.id}>
                  <Badge tone={item.kind === 'proposal' ? 'accent' : 'neutral'}>
                    {item.kind === 'proposal' ? t('copilot.proposal') : t('copilot.tool')}
                  </Badge>
                  {item.kind === 'proposal' ? (
                    <ProposalCard proposal={item.proposal} projects={projects} />
                  ) : <><strong>{item.name}</strong><p>{item.summary}</p></>}
                </li>
              ))}
            </ol>
          )}
          <Notice tone="info">{t('copilot.advisory')}</Notice>
        </aside>
      </div>
    </main>
  );
}
