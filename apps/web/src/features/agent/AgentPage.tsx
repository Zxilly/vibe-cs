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
import { Bot, CheckCircle2, Film, FolderOpen, Music2, Send, Sparkles, Square, Wrench } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import type {
  AgentMessage,
  AgentMode,
  AgentProposal,
  AgentStatus,
  AgentVideoProposal,
  BeatAlignmentProposalPreview,
  BeatAlignmentProposalRequest,
  DemoSummary,
  EditorProject,
  HighlightEditProposalPreview,
  HighlightEditProposalRequest,
  HlaeProposalIntent,
  HlaeProposalExportResult,
  HlaeProposalPreview,
  MediaAsset,
  ProposalPrerequisite,
  RecordingJob,
  RecordingPlanResponse,
} from '../../shared/desktop/dto';
import { type MessageKey, useI18n } from '../../shared/i18n';
import { Badge, Button, EmptyState, Notice, PageHeader, SegmentedControl, Spinner } from '../../shared/ui';
import { applyAgentEvent, proposalActivityKey, rollbackOptimisticRun } from './agentSession';
import { deriveAgentRouteContext, resolveAgentNavigation } from './agentNavigation';
import { ProposalMutationBusyError, ProposalMutationCoordinator } from './proposalMutation';
import { recordingJobStage, requireManagedHlaeForRecording } from '../queue/queuePlan';
import { type QueueItem, useQueueStore } from '../queue/queueStore';

import './agent.css';

const THREAD_STORAGE_KEY = 'vibe-cs.agent-thread';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function storedThreadId() {
  try {
    const stored = JSON.parse(localStorage.getItem(THREAD_STORAGE_KEY) ?? 'null') as unknown;
    if (!stored || typeof stored !== 'object') return null;
    const value = stored as { threadId?: unknown };
    return typeof value.threadId === 'string' && UUID_PATTERN.test(value.threadId)
      ? value.threadId
      : null;
  } catch {
    return null;
  }
}

function persistThreadId(threadId: string) {
  localStorage.setItem(THREAD_STORAGE_KEY, JSON.stringify({ threadId }));
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

function proposalSummary(proposal: AgentProposal, t: (key: MessageKey) => string): string {
  const payload = record(proposal.payload);
  if (!payload) return t('copilot.summary.draft');
  if (proposal.kind === 'beat_alignment') {
    const draft = record(payload.draft);
    const count = Array.isArray(draft?.clips) ? draft.clips.length : 0;
    return `${t('copilot.summary.beatAlignment')} · ${count} ${t('copilot.clipChanges')}`;
  }
  if (proposal.kind === 'hlae') {
    const highlights = Array.isArray(payload.highlight_ids) ? payload.highlight_ids.length : 0;
    return `${t('copilot.summary.shotPlan')} · ${highlights} ${t('copilot.highlights')}`;
  }
  if (proposal.kind === 'video_render') {
    const items = Array.isArray(payload.items) ? payload.items.length : 0;
    return `${t('copilot.summary.video')} · ${items} ${t('copilot.highlights')}`;
  }
  const highlights = Array.isArray(payload.highlight_ids) ? payload.highlight_ids.length : 0;
  return `${t('copilot.summary.edit')} · ${highlights} ${t('copilot.highlights')}`;
}

function proposalTitle(proposal: AgentProposal, t: (key: MessageKey) => string): string {
  if (proposal.kind === 'video_render') return t('copilot.summary.video');
  if (proposal.kind === 'hlae') return t('copilot.summary.shotPlan');
  if (proposal.kind === 'beat_alignment') return t('copilot.summary.beatAlignment');
  return t('copilot.summary.edit');
}

function toolTitle(name: string, t: (key: MessageKey) => string): string {
  if (name === 'draft_video_plan') return t('copilot.tool.videoDraft');
  if (name === 'draft_hlae_plan') return t('copilot.tool.shotPlan');
  if (name === 'draft_edit_plan' || name === 'draft_beat_alignment') return t('copilot.tool.editDraft');
  if (name === 'read_editor_timeline') return t('copilot.tool.readEdit');
  if (name === 'read_audio_analysis') return t('copilot.tool.readAudio');
  if (name === 'navigate_workspace') return t('copilot.tool.navigate');
  if (name.startsWith('read_')) return t('copilot.tool.readMatch');
  return t('copilot.tool.action');
}

function agentVideoQueueItems(proposal: AgentVideoProposal): QueueItem[] {
  return proposal.items.map((item, index) => {
    const design = proposal.shot_designs?.[index];
    const evidence = `${item.highlight_id ?? ''} ${item.title}`.toLocaleLowerCase();
    const category: QueueItem['category'] = evidence.includes('multikill') || evidence.includes('multi-kill')
      ? 'multi-kill'
      : evidence.includes('clutch')
        ? 'clutch'
        : evidence.includes('entry')
          ? 'entry'
          : evidence.includes('utility')
            ? 'utility'
            : 'custom';
    return {
      id: item.id,
      demoId: item.demo_id,
      ...(item.highlight_id ? { highlightId: item.highlight_id } : {}),
      demoName: `Demo ${item.demo_id.slice(0, 8)}`,
      playerId: item.player_id,
      playerName: item.title.split(/\s+/u)[0] || item.player_id,
      title: item.title,
      category,
      startTick: item.start_tick,
      endTick: item.end_tick,
      preRollSeconds: item.pre_roll_seconds,
      postRollSeconds: item.post_roll_seconds,
      perspective: item.victim_pov ? 'victim' : 'pov',
      cameraStyle: item.camera_style ?? 'pov',
      ...(design ? {
        cameraIntent: design.camera_intent,
        cameraRationale: design.rationale,
        ...(design.map_name ? { mapName: design.map_name } : {}),
      } : {}),
      enabled: true,
      origin: 'demo',
    };
  });
}

type ProposalPreview =
  | { kind: 'video_render'; value: RecordingPlanResponse; request: AgentVideoProposal }
  | { kind: 'hlae'; value: HlaeProposalPreview; request: HlaeProposalIntent }
  | { kind: 'beat_alignment'; value: BeatAlignmentProposalPreview; request: BeatAlignmentProposalRequest }
  | { kind: 'highlight_edit'; value: HighlightEditProposalPreview; request: HighlightEditProposalRequest };

function prerequisites(preview: ProposalPreview | null): ProposalPrerequisite[] {
  return preview && preview.kind !== 'video_render' ? preview.value.prerequisites : [];
}

function previewReady(preview: ProposalPreview | null): boolean {
  return preview !== null && (preview.kind === 'video_render' || preview.value.ready);
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

function hlaeIntent(proposal: AgentProposal, mode: HlaeProposalIntent['mode']): HlaeProposalIntent {
  const payload = proposal.payload as Partial<HlaeProposalIntent>;
  return {
    demo_id: payload.demo_id ?? '',
    highlight_ids: payload.highlight_ids ?? [],
    camera_style: payload.camera_style ?? 'pov',
    mode,
    lead_seconds: payload.lead_seconds ?? 2.5,
    tail_seconds: payload.tail_seconds ?? 2,
  };
}

function HlaeExportResult({ result, onReveal }: {
  result: HlaeProposalExportResult;
  onReveal: (directory: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="agent-proposal-details agent-proposal-details--exported" aria-label={t('copilot.exportComplete')}>
      <div className="agent-proposal-details__export-heading">
        <CheckCircle2 size={18} aria-hidden="true" />
        <div><strong>{t('copilot.exportComplete')}</strong></div>
      </div>
      <Button size="sm" variant="secondary" onClick={() => onReveal(result.directory)}>
        <FolderOpen size={14} />{t('copilot.revealBundle')}
      </Button>
    </section>
  );
}

function VideoRenderResult({ job, onCancel }: { job: RecordingJob; onCancel: () => void }) {
  const { t } = useI18n();
  const stage = recordingJobStage(job.message);
  const terminal = ['completed', 'failed', 'cancelled'].includes(job.status);
  return (
    <section className="agent-proposal-details agent-video-result" aria-label={t('copilot.videoJob')}>
      <div className="agent-proposal-details__export-heading">
        {job.status === 'completed' ? <CheckCircle2 size={18} aria-hidden="true" /> : <Film size={18} aria-hidden="true" />}
        <div>
          <strong>{job.status === 'completed' ? t('copilot.videoComplete') : t('copilot.videoJob')}</strong>
          <span>{stage ? `${t(stage.key)} · ${stage.ordinal}/${stage.total}` : job.message}</span>
        </div>
      </div>
      <progress max={1} value={Math.max(0, Math.min(1, job.progress))} />
      {job.outputs.length > 0 ? (
        <ul className="agent-proposal-details__export-files">
          {job.outputs.map((output) => <li key={output.id} title={output.path}>{output.path}</li>)}
        </ul>
      ) : null}
      <div className="agent-proposal-card__actions">
        {!terminal ? <Button size="sm" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button> : null}
        {job.outputs.length > 0 ? <Link className="button button--secondary button--sm" to="/outputs">{t('copilot.openVideo')}</Link> : null}
      </div>
    </section>
  );
}

function beatProjectMatchesPreview(
  preview: BeatAlignmentProposalPreview,
  project: EditorProject | undefined,
  selectedAudioAssetId: string,
): boolean {
  if (!project
    || project.id !== preview.project_id
    || project.revision !== preview.expected_revision
    || !preview.audio
    || !preview.audio_placement
    || preview.audio.asset_id !== selectedAudioAssetId) return false;
  const clipIds = new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  return preview.changes.length > 0 && preview.changes.every((change) => clipIds.has(change.clip_id));
}

function hasReviewableChanges(
  preview: ProposalPreview | null,
  project: EditorProject | undefined,
  selectedAudioAssetId: string,
): boolean {
  if (!preview) return false;
  if (preview.kind === 'video_render') return preview.value.items.length > 0;
  if (!preview.value.ready) return false;
  if (preview.kind === 'hlae') {
    const plan = record(preview.value.typed_plan);
    const compiled = record(preview.value.compiled_preview);
    return plan !== null && compiled !== null && hlaeShotRecords(preview.value).length > 0;
  }
  if (preview.kind === 'beat_alignment') {
    return beatProjectMatchesPreview(preview.value, project, selectedAudioAssetId);
  }
  return preview.value.mappings.length > 0;
}

function ProposalPreviewDetails({ preview, project }: { preview: ProposalPreview; project?: EditorProject }) {
  const { t } = useI18n();
  if (preview.kind === 'video_render') {
    return (
      <section className="agent-proposal-details" aria-label={t('copilot.videoPlan')}>
        <dl>
          <div><dt>{t('copilot.delivery')}</dt><dd>MP4</dd></div>
          <div><dt>{t('copilot.highlights')}</dt><dd>{preview.value.items.length}</dd></div>
          <div><dt>{t('copilot.estimatedDuration')}</dt><dd>{preview.value.estimated_seconds === null ? '—' : `${preview.value.estimated_seconds.toFixed(1)}s`}</dd></div>
        </dl>
        <ol className="agent-proposal-details__changes">
          {preview.value.items.map((item, index) => {
            const design = preview.request.shot_designs?.[index];
            return (
            <li key={item.id}>
              <strong>{item.title}</strong>
              <span>{item.start_tick} → {item.end_tick} tick</span>
              <span>{item.pre_roll_seconds.toFixed(1)}s / {item.post_roll_seconds.toFixed(1)}s context</span>
              {design ? <span>{design.map_name ?? 'Map'} · {design.camera_style} · {design.camera_intent}</span> : null}
              {design ? <span>{design.rationale}</span> : null}
            </li>
            );
          })}
        </ol>
      </section>
    );
  }
  if (!preview.value.ready) {
    if (preview.kind !== 'hlae' || !preview.value.installation_status) return null;
    const status = preview.value.installation_status;
    return (
      <section className="agent-proposal-details" aria-label={t('copilot.hlaeInstallStatus')}>
        <Notice tone={status.available ? 'info' : 'warning'}>
          {status.available ? t('copilot.hlaeInstalled') : t('copilot.hlaeMissing')}
          {' · '}{status.executable ?? status.messages[0]}
        </Notice>
      </section>
    );
  }

  if (preview.kind === 'beat_alignment') {
    const clips = new Map(project?.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)) ?? []);
    const audio = preview.value.audio;
    const placement = preview.value.audio_placement;
    return (
      <section className="agent-proposal-details" aria-label={t('copilot.changeReview')}>
        <dl>
          <div><dt>{t('copilot.project')}</dt><dd>{preview.value.project_id}</dd></div>
          <div><dt>{t('copilot.revision')}</dt><dd>{preview.value.expected_revision}</dd></div>
          <div><dt>{t('copilot.clipChanges')}</dt><dd>{preview.value.changes.length}</dd></div>
          <div><dt>BGM</dt><dd>{audio?.name ?? '—'}</dd></div>
          <div><dt>Audio asset</dt><dd>{audio?.asset_id ?? '—'}</dd></div>
          <div><dt>File identity</dt><dd>{audio ? `${audio.content_sha256.slice(0, 12)}… · ${(audio.file_size / 1_048_576).toFixed(1)} MiB` : '—'}</dd></div>
          <div><dt>Analysis</dt><dd>{audio ? `${audio.analysis_sha256.slice(0, 12)}…` : '—'}</dd></div>
          <div><dt>Audio track</dt><dd>{placement?.track_id ?? '—'} {placement?.insert_audio_track ? '· new' : '· existing'}</dd></div>
          <div><dt>Audio clip</dt><dd>{placement?.clip_id ?? '—'} {placement?.insert_audio_clip ? '· insert' : '· verify'}</dd></div>
          <div><dt>BGM placement</dt><dd>{placement ? `${placement.timeline_start_seconds.toFixed(3)}s → ${placement.timeline_end_seconds.toFixed(3)}s` : '—'}</dd></div>
          <div><dt>BGM source</dt><dd>{placement ? `${placement.source_in_seconds.toFixed(3)}s → ${placement.source_out_seconds.toFixed(3)}s · ${placement.volume.toFixed(2)}×` : '—'}</dd></div>
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
    const insertionByHighlight = new Map(
      preview.value.insertions.map((insertion) => [insertion.highlight_id, insertion] as const),
    );
    return (
      <section className="agent-proposal-details" aria-label={t('copilot.changeReview')}>
        <dl>
          <div><dt>Demo</dt><dd>{preview.request.demo_id}</dd></div>
          <div><dt>{t('copilot.project')}</dt><dd>{preview.value.target_project_id ?? '—'}</dd></div>
          <div><dt>{t('copilot.revision')}</dt><dd>{preview.value.creates_new_project ? t('copilot.newProject') : preview.value.expected_revision}</dd></div>
          <div><dt>{t('copilot.recordedClips')}</dt><dd>{preview.value.mappings.length}</dd></div>
          <div><dt>{t('copilot.pacing')}</dt><dd>{preview.request.intent.pacing}</dd></div>
          <div><dt>{t('copilot.contextWindow')}</dt><dd>±{preview.request.intent.include_context_seconds.toFixed(2)}s</dd></div>
          <div><dt>{t('copilot.transition')}</dt><dd>{preview.request.intent.transition}</dd></div>
        </dl>
        <ol className="agent-proposal-details__changes">
          {preview.value.mappings.map((mapping) => {
            const insertion = insertionByHighlight.get(mapping.highlight_id);
            return (
              <li key={mapping.highlight_id}>
                <strong>{mapping.highlight_id}</strong>
                <span>{mapping.recorded_clip_id}</span>
                <span>{t('copilot.captureTicks')}: {mapping.capture_start_tick} → {mapping.capture_end_tick} · {mapping.tick_rate.toFixed(3)} tick/s</span>
                <span>{t('copilot.sourceClip')}: {mapping.duration_seconds.toFixed(3)}s · {(mapping.file_size / 1_048_576).toFixed(1)} MiB · {mapping.capture_playback_speed.toFixed(3)}×</span>
                {insertion ? (
                  <>
                    <span>{t('copilot.sourceTicks')}: {insertion.source_start_tick} → {insertion.source_end_tick}</span>
                    <span>{t('copilot.sourceTrim')}: {insertion.source_in_seconds.toFixed(3)}s → {insertion.source_out_seconds.toFixed(3)}s</span>
                    <span>{t('copilot.timeline')}: {insertion.timeline_start_seconds.toFixed(3)}s → {insertion.timeline_end_seconds.toFixed(3)}s · {insertion.playback_speed.toFixed(3)}×</span>
                    <span>{t('copilot.transition')}: {insertion.transition_in ?? 'cut'}{insertion.transition_duration_seconds === null ? '' : ` · ${insertion.transition_duration_seconds.toFixed(3)}s`}</span>
                  </>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>
    );
  }

  const compiled = record(preview.value.compiled_preview);
  const shots = hlaeShotRecords(preview.value);
  const firstTick = numberField(compiled, 'firstTick');
  const lastTick = numberField(compiled, 'lastTick');
  return (
    <section className="agent-proposal-details" aria-label={t('copilot.changeReview')}>
      <dl>
        <div><dt>Demo</dt><dd>{preview.request.demo_id}</dd></div>
        <div><dt>{t('copilot.cameraStyle')}</dt><dd>{preview.request.camera_style}</dd></div>
        <div><dt>{t('copilot.mode')}</dt><dd>{preview.request.mode}</dd></div>
        <div><dt>{t('copilot.contextWindow')}</dt><dd>{preview.request.lead_seconds.toFixed(2)}s / {preview.request.tail_seconds.toFixed(2)}s</dd></div>
        <div><dt>{t('copilot.shots')}</dt><dd>{shots.length}</dd></div>
        <div><dt>{t('copilot.highlights')}</dt><dd>{preview.request.highlight_ids.length}</dd></div>
        <div><dt>{t('copilot.tickRange')}</dt><dd>{firstTick ?? '—'} → {lastTick ?? '—'}</dd></div>
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
    </section>
  );
}

export function AgentProposalConfirmation({
  message,
  target,
  actionLabel,
  onCancel,
  onConfirm,
}: {
  message: string;
  target: string;
  actionLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className="agent-proposal-confirmation" role="alertdialog" aria-label={message}>
      <p>{message}</p>
      <strong>{target}</strong>
      <div className="agent-proposal-card__actions">
        <Button size="sm" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button size="sm" variant="primary" onClick={onConfirm}>{actionLabel}</Button>
      </div>
    </section>
  );
}

function ProposalCard({
  proposalId,
  proposal,
  projects,
  selectedAudioAssetId,
  mutationCoordinator,
  mutationOwner,
}: {
  proposalId: string;
  proposal: AgentProposal;
  projects: EditorProject[];
  selectedAudioAssetId: string;
  mutationCoordinator: ProposalMutationCoordinator;
  mutationOwner: string | null;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const initialMode = record(proposal.payload)?.mode === 'capture' ? 'capture' : 'preview';
  const [hlaeMode, setHlaeMode] = useState<HlaeProposalIntent['mode']>(initialMode);
  const [preview, setPreview] = useState<ProposalPreview | null>(null);
  const [exported, setExported] = useState<HlaeProposalExportResult | null>(null);
  const [recordingJobId, setRecordingJobId] = useState<string | null>(null);
  const [recordingJob, setRecordingJob] = useState<RecordingJob | null>(null);
  const [confirmationTarget, setConfirmationTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const mutationActiveRef = useRef(false);
  const mutationLocked = mutationOwner !== null;
  const beatProject = preview?.kind === 'beat_alignment'
    ? projects.find((project) => project.id === preview.value.project_id)
    : undefined;
  const reviewable = useMemo(
    () => hasReviewableChanges(preview, beatProject, selectedAudioAssetId),
    [beatProject, preview, selectedAudioAssetId],
  );

  useEffect(() => {
    generationRef.current += 1;
    setPreview(null);
    setExported(null);
    setRecordingJobId(null);
    setRecordingJob(null);
    setConfirmationTarget(null);
    setHlaeMode(initialMode);
    setError(null);
    setBusy(false);
    return () => {
      generationRef.current += 1;
    };
  }, [initialMode, proposal]);

  useEffect(() => {
    if (proposal.kind !== 'beat_alignment' || mutationActiveRef.current) return;
    generationRef.current += 1;
    setPreview(null);
    setConfirmationTarget(null);
    setError(null);
    setBusy(false);
  }, [proposal.kind, selectedAudioAssetId]);

  useEffect(() => {
    if (!recordingJobId) return;
    let disposed = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const next = await commands.getRecordingJob(recordingJobId, controller.signal);
        if (disposed) return;
        setRecordingJob(next);
        if (!['completed', 'failed', 'cancelled'].includes(next.status)) {
          timer = window.setTimeout(() => void refresh(), 750);
        }
      } catch (cause) {
        if (disposed) return;
        setError(readableError(cause));
        timer = window.setTimeout(() => void refresh(), 2_000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [recordingJobId]);

  const inspect = useCallback(async () => {
    if (busy || mutationLocked) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setBusy(true);
    setError(null);
    try {
      let next: ProposalPreview;
      if (proposal.kind === 'video_render') {
        const request = proposal.payload as AgentVideoProposal;
        await requireManagedHlaeForRecording(
          commands.prepareManagedHlae,
          t('copilot.videoEnginePreparationFailed'),
        );
        next = {
          kind: 'video_render',
          request,
          value: await commands.planRecording({ items: request.items }),
        };
      } else if (proposal.kind === 'hlae') {
        const request = hlaeIntent(proposal, hlaeMode);
        next = { kind: 'hlae', request, value: await commands.previewHlaeProposal(request) };
      } else if (proposal.kind === 'beat_alignment') {
        const request = proposal.payload as BeatAlignmentProposalRequest;
        if (!selectedAudioAssetId || request.audio_asset_id !== selectedAudioAssetId) {
          throw new Error('The selected BGM changed. Ask the copilot for a new beat-alignment draft.');
        }
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
  }, [busy, hlaeMode, mutationLocked, proposal, selectedAudioAssetId, t]);

  const requestApply = useCallback(() => {
    if (!preview || !reviewable || busy || mutationLocked) return;
    const target = preview.kind === 'video_render'
      ? `${preview.value.items.length} ${t('copilot.highlights')} · MP4 · ${preview.value.estimated_seconds?.toFixed(1) ?? '—'}s`
      : preview.kind === 'hlae'
      ? `Demo ${preview.request.demo_id} · ${hlaeShotRecords(preview.value).length} ${t('copilot.shots')}`
      : preview.kind === 'beat_alignment'
        ? `${t('copilot.project')} ${preview.value.project_id} · ${preview.value.changes.length} ${t('copilot.clipChanges')}`
        : `${t('copilot.project')} ${preview.value.target_project_id ?? '—'} · ${preview.value.insertions.length} ${t('copilot.clipChanges')}`;
    setConfirmationTarget(target);
  }, [busy, mutationLocked, preview, reviewable, t]);

  const apply = useCallback(async () => {
    if (!preview || !reviewable || !confirmationTarget || busy || mutationLocked) return;
    setConfirmationTarget(null);
    setBusy(true);
    setError(null);
    mutationActiveRef.current = true;
    try {
      await mutationCoordinator.run(proposalId, async () => {
        if (preview.kind === 'video_render') {
          // This value is only sent after the CDP-visible alertdialog above was
          // explicitly confirmed. Other recording entry points keep native consent.
          const result = await commands.executeRecordingPlan(preview.value.plan_id, true);
          setRecordingJob(null);
          setRecordingJobId(result.job_id);
          return;
        }
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
          const result = await commands.exportHlaeProposal(preview.request, confirmation);
          setExported(result);
        } else if (preview.kind === 'beat_alignment') {
          const result = await commands.applyBeatAlignmentProposal(preview.request, confirmation);
          navigate(`/studio/editor?project=${encodeURIComponent(result.project_id)}`);
        } else {
          if (!preview.value.plan) throw new Error(t('copilot.previewExpired'));
          const result = await commands.applyHighlightEditProposal(preview.request, preview.value.plan, confirmation);
          navigate(`/studio/editor?project=${encodeURIComponent(result.project_id)}`);
        }
      });
    } catch (cause) {
      if (!(cause instanceof ProposalMutationBusyError)) setError(readableError(cause));
    } finally {
      mutationActiveRef.current = false;
      setBusy(false);
    }
  }, [busy, confirmationTarget, mutationCoordinator, mutationLocked, navigate, preview, proposalId, reviewable, t]);

  const revealExport = useCallback(async (directory: string) => {
    if (busy || mutationLocked) return;
    setBusy(true);
    setError(null);
    mutationActiveRef.current = true;
    try {
      await mutationCoordinator.run(proposalId, () => commands.revealHlaeBundle(directory));
    } catch (cause) {
      if (!(cause instanceof ProposalMutationBusyError)) setError(readableError(cause));
    } finally {
      mutationActiveRef.current = false;
      setBusy(false);
    }
  }, [busy, mutationCoordinator, mutationLocked, proposalId]);

  const cancelRecording = useCallback(async () => {
    if (!recordingJobId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const cancelled = await commands.cancelRecordingJob(recordingJobId);
      setRecordingJob(cancelled);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, recordingJobId]);

  const openVideoWorkspace = useCallback(() => {
    if (proposal.kind !== 'video_render' || busy || mutationLocked) return;
    const request = proposal.payload as AgentVideoProposal;
    const items = agentVideoQueueItems(request);
    if (items.length === 0) {
      setError(t('copilot.previewIncomplete'));
      return;
    }
    useQueueStore.getState().replace(items);
    navigate('/queue?source=agent');
  }, [busy, mutationLocked, navigate, proposal, t]);

  const missing = prerequisites(preview);
  return (
    <div className="agent-proposal-card">
      <strong>{proposalTitle(proposal, t)}</strong>
      <p>{proposalSummary(proposal, t)}</p>
      {proposal.kind === 'hlae' ? (
        <SegmentedControl
          label={t('copilot.hlaeOutputMode')}
          value={hlaeMode}
          onChange={(value) => {
            setHlaeMode(value);
            setPreview(null);
            setExported(null);
            setConfirmationTarget(null);
          }}
          disabled={busy || mutationLocked}
          options={[
            { value: 'preview', label: t('copilot.previewMode') },
            { value: 'capture', label: t('copilot.captureMode') },
          ]}
        />
      ) : null}
      {error ? <span className="agent-proposal-card__error">{error}</span> : null}
      {preview ? (
        <>
          <Badge tone={previewReady(preview) ? 'success' : 'warning'}>
            {previewReady(preview) ? t('copilot.previewReady') : t('copilot.previewBlocked')}
          </Badge>
          <ProposalPreviewDetails preview={preview} {...(beatProject ? { project: beatProject } : {})} />
          {previewReady(preview) && !reviewable ? (
            <span className="agent-proposal-card__error">{t('copilot.previewIncomplete')}</span>
          ) : null}
        </>
      ) : null}
      {missing.length > 0 ? (
        <ul>{missing.map((item) => <li key={item.code}>{item.message}</li>)}</ul>
      ) : null}
      {confirmationTarget && preview ? (
        <AgentProposalConfirmation
          message={t(preview.kind === 'video_render' ? 'copilot.confirmVideo' : preview.kind === 'hlae' ? 'copilot.confirmExport' : 'copilot.confirmApply')}
          target={confirmationTarget}
          actionLabel={preview.kind === 'video_render'
            ? t('copilot.generateVideo')
            : preview.kind === 'hlae'
            ? t(hlaeMode === 'capture' ? 'copilot.exportCaptureBundle' : 'copilot.exportPreviewBundle')
            : t('copilot.apply')}
          onCancel={() => setConfirmationTarget(null)}
          onConfirm={() => void apply()}
        />
      ) : null}
      {exported ? <HlaeExportResult result={exported} onReveal={(directory) => void revealExport(directory)} /> : null}
      {recordingJob ? <VideoRenderResult job={recordingJob} onCancel={() => void cancelRecording()} /> : null}
      <div className="agent-proposal-card__actions">
        {proposal.kind === 'video_render' ? (
          <Button size="sm" variant="primary" disabled={busy || mutationLocked} onClick={openVideoWorkspace}>
            <Film size={14} />{t('copilot.openRecordingWorkspace')}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="secondary" disabled={busy || mutationLocked} onClick={() => void inspect()}>
              {busy ? <Spinner /> : null}{t('copilot.preview')}
            </Button>
            <Button size="sm" variant="primary" disabled={busy || mutationLocked || !reviewable} onClick={requestApply}>
              {proposal.kind === 'hlae'
                ? t(hlaeMode === 'capture' ? 'copilot.exportCaptureBundle' : 'copilot.exportPreviewBundle')
                : t('copilot.apply')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

type AgentActivityItem =
  | { id: string; kind: 'tool'; name: string; summary: string }
  | { id: string; kind: 'proposal'; name: string; summary: string; proposal: AgentProposal };

export function AgentActivityPanel({
  activity,
  projects,
  selectedAudioAssetId,
  mutationCoordinator,
  mutationOwner,
  variant = 'page',
}: {
  activity: AgentActivityItem[];
  projects: EditorProject[];
  selectedAudioAssetId: string;
  mutationCoordinator: ProposalMutationCoordinator;
  mutationOwner: string | null;
  variant?: 'page' | 'dock';
}) {
  const { t } = useI18n();
  return (
    <aside className={`agent-activity${variant === 'dock' ? ' agent-activity--dock' : ''}`}>
      <header><Wrench size={17} /><strong>{t('copilot.activity')}</strong></header>
      {activity.length === 0 ? <p>{t('copilot.noActivity')}</p> : (
        <ol>
          {activity.map((item) => (
            <li key={item.id}>
              <Badge tone={item.kind === 'proposal' ? 'accent' : 'neutral'}>
                {item.kind === 'proposal' ? t('copilot.proposal') : t('copilot.tool')}
              </Badge>
              {item.kind === 'proposal' ? (
                <ProposalCard
                  proposalId={item.id}
                  proposal={item.proposal}
                  projects={projects}
                  selectedAudioAssetId={selectedAudioAssetId}
                  mutationCoordinator={mutationCoordinator}
                  mutationOwner={mutationOwner}
                />
              ) : <><strong>{toolTitle(item.name, t)}</strong><p>{item.summary}</p></>}
            </li>
          ))}
        </ol>
      )}
      <Notice tone="info">{t('copilot.advisory')}</Notice>
    </aside>
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

type AgentWorkspaceSurface = 'page' | 'dock';

const workspaceDestinationKeys = {
  review: 'nav.review',
  players: 'players.title',
  evidence: 'nav.evidenceSearch',
  replay: 'analysis.tab.replay',
  heatmap: 'analysis.tab.heatmap',
  edit: 'nav.edit',
  queue: 'queue.title',
  studio: 'studio.title',
  outputs: 'outputs.title',
  neutral: 'shell.workspace',
} satisfies Record<ReturnType<typeof deriveAgentRouteContext>['destination'], MessageKey>;

export function AgentPage({ surface = 'page' }: { surface?: AgentWorkspaceSurface }) {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
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
  const [proposalMutationCoordinator] = useState(() => new ProposalMutationCoordinator());
  const [proposalMutationOwner, setProposalMutationOwner] = useState<string | null>(null);
  const generationRef = useRef(0);
  const requestIdRef = useRef<string | null>(null);
  const routeContext = useMemo(
    () => deriveAgentRouteContext(location.pathname, location.search),
    [location.pathname, location.search],
  );

  useEffect(() => {
    if (routeContext.demoId) setDemoId(routeContext.demoId);
    if (routeContext.projectId) setProjectId(routeContext.projectId);
    if (routeContext.workflow === 'review') setMode('guide');
    if (routeContext.workflow === 'edit') setMode('edit');
  }, [routeContext]);

  useEffect(() => {
    return proposalMutationCoordinator.subscribe(setProposalMutationOwner);
  }, [proposalMutationCoordinator]);

  useEffect(() => {
    const controller = new AbortController();
    const threadPromise = initialThreadId ? commands.getAgentThread(initialThreadId) : Promise.resolve(null);
    void Promise.all([
      commands.agentStatus(),
      commands.listDemos({ page: 1, page_size: 50, sort: 'updated_desc' }, controller.signal),
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
    if (isRunning || proposalMutationCoordinator.activeOwner !== null) return;
    const content = messageText(message);
    if (!content) return;
    const createdAt = new Date().toISOString();
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    requestIdRef.current = requestId;
    const contextSnapshot = { threadId, demoId, projectId, audioAssetId, mode, routeContext };
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
        threadId: contextSnapshot.threadId,
        demoId: contextSnapshot.demoId || null,
        editorProjectId: contextSnapshot.projectId || null,
        audioAssetId: contextSnapshot.audioAssetId || null,
        workspaceContext: contextSnapshot.routeContext,
        mode: contextSnapshot.mode,
        message: content,
      }, (event) => {
        if (generationRef.current !== generation) return;
        if (event.type === 'started') {
          setThreadId(event.threadId);
          persistThreadId(event.threadId);
        } else {
          setMessages((current) => applyAgentEvent(current, assistantId, event));
          if (event.type === 'toolCall') {
            const target = resolveAgentNavigation(event.toolCall, {
              demoId: contextSnapshot.demoId || null,
              projectId: contextSnapshot.projectId || null,
            });
            if (target) void navigate(target);
          }
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
  }, [audioAssetId, demoId, isRunning, mode, navigate, projectId, proposalMutationCoordinator, routeContext, threadId]);

  const onCancel = useCallback(async () => {
    const requestId = requestIdRef.current;
    if (requestId) await commands.cancelAgentChat(requestId);
  }, []);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning,
    isSendDisabled: !status?.configured || !status.runtimeAvailable || proposalMutationOwner !== null,
    onNew,
    onCancel,
  });

  const activity = useMemo<AgentActivityItem[]>(() => messages.flatMap((message) => [
    ...message.toolCalls.map((toolCall, index) => ({
      id: `${message.id}:tool:${index}`, kind: 'tool' as const,
      name: toolCall.name, summary: t('copilot.toolComplete'),
    })),
    ...message.proposals.map((proposal: AgentProposal, index) => ({
      id: proposalActivityKey(message.id, index), kind: 'proposal' as const,
      name: proposal.title, summary: proposalSummary(proposal, t), proposal,
    })),
  ]).reverse().slice(0, 12), [messages, t]);
  const audioAssets = useMemo(() => assets.filter((asset) => asset.has_audio), [assets]);

  if (isLoading) {
    if (surface === 'dock') {
      return (
        <aside className="ai-workspace-dock" aria-label={t('copilot.workspaceDock')}>
          <header><Bot size={17} /><strong>{t('copilot.workspaceDock')}</strong></header>
          <div className="ai-workspace-dock__loading"><Spinner label={t('copilot.loading')} /></div>
        </aside>
      );
    }
    return <div className="page-state"><Spinner label={t('copilot.loading')} /><span>{t('copilot.loading')}</span></div>;
  }

  const statusTone = status?.configured && status.runtimeAvailable ? 'success' : 'warning';
  const statusText = !status?.runtimeAvailable
    ? t('copilot.noRuntime')
    : status.configured ? t('copilot.ready') : t('copilot.notConfigured');

  if (surface === 'dock') {
    return (
      <aside className="ai-workspace-dock" aria-label={t('copilot.workspaceDock')}>
        <header className="ai-workspace-dock__header">
          <span><Bot size={17} /><strong>{t('copilot.workspaceDock')}</strong></span>
          <Badge tone={statusTone}>{statusText}</Badge>
        </header>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <section className="ai-workspace-dock__context" aria-label={t('copilot.context')}>
          <span>{t(workspaceDestinationKeys[routeContext.destination])}</span>
          <span title={demoId || undefined}>{demoId ? t('copilot.matchFile') : t('copilot.none')}</span>
          <span title={projectId || undefined}>{projectId ? t('copilot.project') : t('copilot.none')}</span>
          {routeContext.roundNumber !== null ? <span>R{routeContext.roundNumber}</span> : null}
          {routeContext.tick !== null ? <span>T{routeContext.tick}</span> : null}
          {routeContext.playerId ? <span title={routeContext.playerId}>STEAM64</span> : null}
        </section>
        <div className="ai-workspace-dock__mode">
          <SegmentedControl
            label={t('copilot.context')}
            value={mode}
            onChange={setMode}
            disabled={isRunning || proposalMutationOwner !== null}
            options={[
              { value: 'guide', label: t('copilot.mode.guide') },
              { value: 'edit', label: t('copilot.mode.edit') },
              { value: 'hlae', label: t('copilot.mode.hlae') },
            ]}
          />
        </div>
        {activity.length > 0 ? (
          <AgentActivityPanel
            activity={activity}
            projects={projects}
            selectedAudioAssetId={audioAssetId}
            mutationCoordinator={proposalMutationCoordinator}
            mutationOwner={proposalMutationOwner}
            variant="dock"
          />
        ) : null}
        <section className="ai-workspace-dock__thread">
          <AssistantRuntimeProvider runtime={runtime}><AgentThread /></AssistantRuntimeProvider>
        </section>
      </aside>
    );
  }

  return (
    <main className="page agent-page">
      <PageHeader
        eyebrow={t('copilot.eyebrow')}
        title={t('copilot.title')}
        description={t('copilot.description')}
        actions={<Badge tone={statusTone}>{statusText}</Badge>}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <section className="agent-context" aria-label={t('copilot.context')} aria-busy={isRunning || proposalMutationOwner !== null}>
        <div className="agent-context__heading">
          <strong>{t('copilot.context')}</strong>
          <SegmentedControl
            label={t('copilot.context')}
            value={mode}
            onChange={setMode}
            disabled={isRunning || proposalMutationOwner !== null}
            options={[
              { value: 'guide', label: t('copilot.mode.guide') },
              { value: 'edit', label: t('copilot.mode.edit') },
              { value: 'hlae', label: t('copilot.mode.hlae') },
            ]}
          />
        </div>
        <div className="agent-context__grid">
          <ContextSelect disabled={isRunning || proposalMutationOwner !== null} label={t('copilot.matchFile')} icon={<Film size={15} />} value={demoId} onChange={setDemoId}>
            <option value="">{t('copilot.none')}</option>
            {demos.map((demo) => <option key={demo.id} value={demo.id}>{demo.display_name}</option>)}
          </ContextSelect>
          <ContextSelect disabled={isRunning || proposalMutationOwner !== null} label={t('copilot.project')} icon={<Sparkles size={15} />} value={projectId} onChange={setProjectId}>
            <option value="">{t('copilot.none')}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </ContextSelect>
          <ContextSelect disabled={isRunning || proposalMutationOwner !== null} label={t('copilot.bgm')} icon={<Music2 size={15} />} value={audioAssetId} onChange={setAudioAssetId}>
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
        <AgentActivityPanel
          activity={activity}
          projects={projects}
          selectedAudioAssetId={audioAssetId}
          mutationCoordinator={proposalMutationCoordinator}
          mutationOwner={proposalMutationOwner}
        />
      </div>
    </main>
  );
}

export function AgentDock() {
  return <AgentPage surface="dock" />;
}
