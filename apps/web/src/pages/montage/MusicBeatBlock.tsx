/*
 * pages/montage — block B, 配乐与节拍.
 *
 * 「low-orbit.mp3 · 128 BPM · 置信度 0.92」, 「更换音乐」, the two suggestion
 * cards with their per-card 预览 / 应用, and the 片段 / 名称 / 入点 / 时长 /
 * 最近拍点 / 偏移 table.
 *
 * ── 预览 writes nothing, and that is structural ───────────────────────────
 *
 * The artboard's own footnote: 「节拍建议不会直接修改工程，应用前可逐条预览」.
 * Here that is not a promise, it is the shape of the code:
 *
 *   `alignClipsToBeats` takes beats and durations and **has no project id**,
 *   so the request that produces the suggestions could not write a project;
 *   「预览」 stores a clip id in a `useState` and the table renders
 *   `previewBeatDraft(project, draft, [id])` — a *pure* document that exists
 *   only for this render. Leaving preview drops it, and the project is
 *   byte-for-byte what it was, which
 *   `montagePage.interaction.test.tsx` asserts field by field;
 *   「应用」 is the only path to `props.project.save`.
 *
 * ── 「更换音乐」 is a path, not an upload ──────────────────────────────────
 *
 * `MontageSettingsRecord.background_music` is an **absolute local path** — the
 * renderer resolves it with `Path::is_file` — while the BPM and the beat grid
 * come from a *media asset* id. So the flow is: native picker (a real
 * capability, `data/nativeShell.ts`) → `importMediaAsset(path)` → store
 * `asset.path`. The asset is then found again by matching that path against the
 * library, which is the join this page has to perform because the project does
 * not carry the asset id (recorded as a backend gap). Music that was never
 * imported still renders and still exports; it simply has no analysis, and the
 * panel says so instead of showing an empty BPM.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useMemo, useState } from 'react';

import { DataTable, EmptyState, type DataTableColumn } from '../../design/data';
import { Alert } from '../../design/feedback';
import { Button, Badge } from '../../design/primitives';
import { dataErrorMessage } from '../../data/errors';
import { useAudioAnalysis, useAssetWaveform, useImportMediaAsset, useMediaAssets } from '../../data/mediaAssets';
import { useBeatAlignmentPreview } from '../../data/montage';
import { useNativeShell, useNativeShellAction } from '../../data/nativeShell';
import { useRecordedClips } from '../../data/outputs';
import { Waveform } from '../../domain/media';
import type { AudioAnalysis, BeatAlignmentDraft, MediaAsset, MontageProjectRecord } from '../../shared/desktop/dto';
import {
  BEAT_SUGGESTION_TOLERANCE_SECONDS,
  buildBeatAlignmentRequest,
  previewBeatDraft,
  readBeatSuggestions,
  type BeatSuggestion,
} from './montageBeats';
import {
  applyBeatDraftToProject,
  beatOrdinal,
  formatBeatOffset,
  formatMontageTimecode,
  montageTimeline,
  nearestBeat,
  type MontageBlockProps,
  type MontageTimelineRow,
} from './montageContract';
import { editMontageSettings } from './montageSettings';

/** Below this the analysis is telling the page not to trust it. */
const LOW_CONFIDENCE = 0.5;
/** Between the two, it committed to a tempo but not confidently. */
const FAIR_CONFIDENCE = 0.75;

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'];

export function MusicBeatBlock({ project: desk, selection, service }: MontageBlockProps) {
  const shell = useNativeShell();
  const shellAction = useNativeShellAction();
  const importAsset = useImportMediaAsset();
  const assets = useMediaAssets(null);
  const align = useBeatAlignmentPreview();

  const [draft, setDraft] = useState<BeatAlignmentDraft | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  const project = desk.project;
  const musicPath = project?.settings.background_music ?? null;

  /* The asset behind the stored path. `undefined` while the library loads and
     when the file was never imported — two different states, told apart below
     by `assets.isPending`. */
  const musicAsset: MediaAsset | undefined = useMemo(
    () => (assets.data?.items ?? []).find((asset) => asset.path === musicPath),
    [assets.data, musicPath],
  );

  const analysis = useAudioAnalysis(musicAsset?.id ?? null);
  const waveform = useAssetWaveform(musicAsset?.id ?? null);

  const chooseMusic = () => {
    void (async () => {
      const path = await shell.chooseFile({
        title: t`选择配乐`,
        filters: [{ name: t`音频文件`, extensions: AUDIO_EXTENSIONS }],
      });
      if (path === null) return;
      const asset = await importAsset.mutateAsync({ path, kind: 'audio' });
      desk.save(editMontageSettings({ background_music: asset.path }));
      setDraft(null);
      setPreviewing(null);
    })();
  };

  const writable = !service.blocked && project !== null && !desk.saving;

  return (
    <section data-montage-block="music" className="flex min-w-0 flex-col border border-divider">
      <header className="flex min-h-[var(--h-panel-head)] flex-none flex-wrap items-center gap-3 border-b border-divider px-3.5 py-1">
        <h3 className="min-w-0 truncate font-heading tracking-wide" style={{ fontSize: 'var(--text-base)' }}>
          <Trans>配乐与节拍</Trans>
        </h3>
        <MusicSummary
          path={musicPath}
          asset={musicAsset}
          libraryPending={assets.isPending}
          analysis={analysis.data}
          analysisPending={analysis.isPending}
        />
        <span className="flex-1" />
        <span className="flex flex-none items-center gap-2">
          {musicPath === null ? null : (
            <Button
              size="sm"
              data-montage-action="clear-music"
              disabled={!writable}
              onClick={() => {
                desk.save(editMontageSettings({ background_music: null }));
                setDraft(null);
                setPreviewing(null);
              }}
            >
              <Trans>移除配乐</Trans>
            </Button>
          )}
          <Button
            size="sm"
            data-montage-action="choose-music"
            {...shellAction.buttonProps}
            disabled={!writable || !shellAction.available || importAsset.isPending}
            onClick={chooseMusic}
          >
            <Trans>更换音乐</Trans>
          </Button>
        </span>
      </header>

      <div className="flex flex-col gap-3 p-3.5">
        {dataErrorMessage(importAsset.error) === null ? null : (
          <Alert variant="danger" action={{ label: <Trans>重新选择</Trans>, onAction: chooseMusic }}>
            <Trans>这个音频没能导入素材库：{dataErrorMessage(importAsset.error) ?? ''}</Trans>
          </Alert>
        )}

        {musicPath === null ? (
          <EmptyState
            title={<Trans>还没有配乐</Trans>}
            description={<Trans>选一段音乐后，这里会给出可解释的卡点建议。</Trans>}
            headingLevel={4}
            actions={
              <Button
                variant="primary"
                size="md"
                data-montage-action="choose-music-empty"
                {...shellAction.buttonProps}
                disabled={!writable || !shellAction.available}
                onClick={chooseMusic}
              >
                <Trans>选择音乐</Trans>
              </Button>
            }
          />
        ) : (
          <Waveform
            peaks={waveform.data?.waveform ?? []}
            durationSeconds={analysis.data?.duration_seconds ?? musicAsset?.duration_seconds ?? 0}
            loading={waveform.isPending && musicAsset !== undefined}
            label={t`配乐波形`}
          />
        )}

        <BeatSuggestions
          desk={desk}
          analysis={analysis.data}
          draft={draft}
          previewing={previewing}
          writable={writable}
          computing={align.isPending}
          computeError={align.error}
          onCompute={() => {
            if (project === null || analysis.data === undefined) return;
            const built = buildBeatAlignmentRequest(project, desk.clipDurations, analysis.data);
            if (typeof built === 'string') return;
            align.mutate(built.request, {
              onSuccess: (next) => {
                setDraft(next);
                setPreviewing(null);
              },
            });
          }}
          onPreview={setPreviewing}
          onApply={(clipId) => {
            const current = draft;
            if (current === null) return;
            /* Handed to `props.project.save`, so it lands on a freshly re-read
               document (invariant 3) and shares the shell's one conflict
               surface. The transform is the same one 「预览」 rendered. */
            desk.save((document) => applyBeatDraftToProject(document, current, [clipId]));
            setPreviewing(null);
          }}
        />

        <BeatTable
          project={project}
          desk={desk}
          selection={selection}
          analysis={analysis.data}
          draft={draft}
          previewing={previewing}
        />

        <p className="text-xs text-neutral-600">
          <Trans>节拍建议不会直接修改工程，应用前可逐条预览。</Trans>
        </p>
      </div>
    </section>
  );
}

/* ── 「low-orbit.mp3 · 128 BPM · 置信度 0.92」 ────────────────────────────── */

function MusicSummary({
  path,
  asset,
  libraryPending,
  analysis,
  analysisPending,
}: {
  readonly path: string | null;
  readonly asset: MediaAsset | undefined;
  readonly libraryPending: boolean;
  readonly analysis: AudioAnalysis | undefined;
  readonly analysisPending: boolean;
}) {
  if (path === null) {
    return (
      <p className="text-xs text-neutral-600">
        <Trans>未选择配乐</Trans>
      </p>
    );
  }

  const name = asset?.name ?? path.split(/[\\/]/u).pop() ?? path;

  if (asset === undefined) {
    return (
      <p className="flex min-w-0 items-center gap-2 text-xs text-neutral-700">
        <span className="truncate">{name}</span>
        {libraryPending ? null : (
          <Badge variant="outline">
            <Trans>未在素材库中，无法分析节拍</Trans>
          </Badge>
        )}
      </p>
    );
  }

  if (analysisPending) {
    return (
      <p className="flex min-w-0 items-center gap-2 text-xs text-neutral-700">
        <span className="truncate">{name}</span>
        <span role="status" aria-busy="true">
          <Trans>正在分析节拍</Trans>
        </span>
      </p>
    );
  }

  if (analysis === undefined) {
    return <p className="min-w-0 truncate text-xs text-neutral-700">{name}</p>;
  }

  const confidence = analysis.tempo_confidence.toFixed(2);

  return (
    <p className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-neutral-700">
      <span className="truncate">{name}</span>
      {analysis.bpm === null ? (
        <Badge variant="outline">
          <Trans>未测到稳定节拍</Trans>
        </Badge>
      ) : (
        <>
          <span className="font-mono">
            <Trans>{Math.round(analysis.bpm)} BPM</Trans>
          </span>
          <span className="font-mono">
            <Trans>置信度 {confidence}</Trans>
          </span>
        </>
      )}
      {analysis.tempo_confidence < LOW_CONFIDENCE ? (
        <Badge variant="outline">
          <Trans>置信度很低，建议只作参考</Trans>
        </Badge>
      ) : analysis.tempo_confidence < FAIR_CONFIDENCE ? (
        <Badge variant="outline">
          <Trans>置信度一般</Trans>
        </Badge>
      ) : null}
      {analysis.limitations.length === 0 ? null : (
        /* English facts from the analyser, printed verbatim under a Chinese
           label — the same rule the preflight `detail` follows. */
        <span className="text-neutral-600" title={analysis.limitations.join('\n')}>
          <Trans>分析限制 {analysis.limitations.length} 条</Trans>
        </span>
      )}
    </p>
  );
}

/* ── the cards ───────────────────────────────────────────────────────────── */

function BeatSuggestions({
  desk,
  analysis,
  draft,
  previewing,
  writable,
  computing,
  computeError,
  onCompute,
  onPreview,
  onApply,
}: {
  readonly desk: MontageBlockProps['project'];
  readonly analysis: AudioAnalysis | undefined;
  readonly draft: BeatAlignmentDraft | null;
  readonly previewing: string | null;
  readonly writable: boolean;
  readonly computing: boolean;
  readonly computeError: unknown;
  readonly onCompute: () => void;
  readonly onPreview: (clipId: string | null) => void;
  readonly onApply: (clipId: string) => void;
}) {
  const project = desk.project;
  if (project === null || analysis === undefined) return null;

  const obstacle = buildBeatAlignmentRequest(project, desk.clipDurations, analysis);
  const blocked = typeof obstacle === 'string' ? obstacle : null;
  const reason =
    blocked === 'no-clips'
      ? t`这份合辑还没有片段`
      : blocked === 'no-beats'
        ? t`这段音乐没有可用的拍点`
        : blocked === 'unknown-durations'
          ? t`素材长度还没读到，稍后再试`
          : undefined;

  const suggestions = draft === null ? [] : readBeatSuggestions(project, desk.clipDurations, draft);
  const unplaced = draft?.unplaced_clip_ids.length ?? 0;
  const error = dataErrorMessage(computeError);

  return (
    <div className="flex flex-col gap-2" data-montage-suggestions="">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          data-montage-action="compute-beats"
          disabled={blocked !== null || computing}
          {...(reason === undefined ? {} : { disabledReason: reason })}
          onClick={onCompute}
        >
          {draft === null ? <Trans>计算节拍建议</Trans> : <Trans>重新计算</Trans>}
        </Button>
        {previewing === null ? null : (
          <Button size="sm" data-montage-action="exit-preview" onClick={() => onPreview(null)}>
            <Trans>退出预览</Trans>
          </Button>
        )}
        {previewing === null ? null : (
          <Badge variant="accent" data-montage-preview-flag="">
            <Trans>预览中 · 工程尚未改动</Trans>
          </Badge>
        )}
      </div>

      {error === null ? null : (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: onCompute }}>
          <Trans>节拍建议没能算出来：{error}</Trans>
        </Alert>
      )}

      {draft !== null && suggestions.length === 0 ? (
        <p className="text-xs text-neutral-600">
          <Trans>每一段都已经落在拍点上（误差小于 {BEAT_SUGGESTION_TOLERANCE_SECONDS} 秒），没有需要调整的片段。</Trans>
        </p>
      ) : null}

      {unplaced === 0 ? null : (
        <p className="text-xs text-neutral-600">
          <Trans>有 {unplaced} 段在允许的时长范围内找不到合适的拍点，保持原样。</Trans>
        </p>
      )}

      {suggestions.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {suggestions.map((suggestion) => (
            <SuggestionCard
              key={suggestion.clipId}
              suggestion={suggestion}
              previewing={previewing === suggestion.clipId}
              writable={writable}
              onPreview={() => onPreview(previewing === suggestion.clipId ? null : suggestion.clipId)}
              onApply={() => onApply(suggestion.clipId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SuggestionCard({
  suggestion,
  previewing,
  writable,
  onPreview,
  onApply,
}: {
  readonly suggestion: BeatSuggestion;
  readonly previewing: boolean;
  readonly writable: boolean;
  readonly onPreview: () => void;
  readonly onApply: () => void;
}) {
  const position = String(suggestion.position).padStart(2, '0');
  const offset = formatBeatOffset(suggestion.deltaSeconds) ?? '';

  return (
    <li
      data-montage-suggestion={suggestion.clipId}
      data-previewing={previewing ? 'true' : 'false'}
      className="flex min-w-0 items-center gap-3 border border-divider p-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm">
          <Trans>
            把片段 {position} 的时长改为 {suggestion.plannedDurationSeconds.toFixed(1)}s（{offset}）
          </Trans>
        </p>
        <p className="text-xs text-neutral-600">
          <Trans>
            对齐第 {suggestion.startBeat} 拍到第 {suggestion.endBeat} 拍，之后的片段会跟着前后移动。
          </Trans>
        </p>
        {suggestion.rationale.length === 0 ? null : (
          <p className="text-2xs text-neutral-600">
            <Trans>对齐依据（服务返回）</Trans>
            <span className="ml-1">{suggestion.rationale.join(' ')}</span>
          </p>
        )}
      </div>
      <Button size="sm" data-montage-action="preview-beat" onClick={onPreview}>
        {previewing ? <Trans>退出预览</Trans> : <Trans>预览</Trans>}
      </Button>
      <Button
        variant="primary"
        size="sm"
        data-montage-action="apply-beat"
        disabled={!writable}
        onClick={onApply}
      >
        {/* A verb — Apply. The bare 「应用」 msgid is the settings section
            「应用」, a noun (App), so this one takes the same context
            `pages/library/ColumnConfigDialog.tsx` established. */}
        <Trans context="dialog-confirm">应用</Trans>
      </Button>
    </li>
  );
}

/* ── the table ───────────────────────────────────────────────────────────── */

interface BeatRow {
  readonly row: MontageTimelineRow;
  readonly position: number;
  readonly title: string;
  readonly changed: boolean;
}

function BeatTable({
  project,
  desk,
  selection,
  analysis,
  draft,
  previewing,
}: {
  readonly project: MontageProjectRecord | null;
  readonly desk: MontageBlockProps['project'];
  readonly selection: MontageBlockProps['selection'];
  readonly analysis: AudioAnalysis | undefined;
  readonly draft: BeatAlignmentDraft | null;
  readonly previewing: string | null;
}) {
  /* The same query the strip reads, so the two tables cannot disagree about a
     take's name; react-query serves the second caller from cache. */
  const takes = useRecordedClips();
  if (project === null) return null;

  /* The document the table draws. Under preview this is a *local* copy — it is
     never saved, and dropping `previewing` restores the real one. */
  const shown =
    previewing === null || draft === null ? project : previewBeatDraft(project, draft, [previewing]);

  const timeline = montageTimeline(shown, desk.clipDurations);
  const beats = analysis?.beats ?? [];
  const titles = new Map((takes.data?.items ?? []).map((take) => [take.id, take.title] as const));

  const rows: readonly BeatRow[] = timeline.rows.map((row, index) => ({
    row,
    position: index + 1,
    title: row.clip.title ?? titles.get(row.clip.clip_id) ?? row.clip.clip_id,
    changed: previewing === row.clip.clip_id,
  }));

  const columns: DataTableColumn<BeatRow>[] = [
    {
      id: 'position',
      header: <Trans>片段</Trans>,
      headerLabel: t`片段`,
      width: '72px',
      variant: 'numeric-meta',
      hideable: false,
      cell: (entry) => String(entry.position).padStart(2, '0'),
    },
    {
      id: 'title',
      header: <Trans>名称</Trans>,
      headerLabel: t`名称`,
      truncate: true,
      hideable: false,
      cell: (entry) => (
        <span className="flex items-center gap-2">
          <span className="truncate">{entry.title}</span>
          {entry.changed ? (
            <Badge variant="accent">
              <Trans>预览</Trans>
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      id: 'start',
      header: <Trans>入点</Trans>,
      headerLabel: t`入点`,
      width: '104px',
      variant: 'numeric',
      cell: (entry) =>
        entry.row.startSeconds === null ? '—' : formatMontageTimecode(entry.row.startSeconds),
    },
    {
      id: 'duration',
      header: <Trans>时长</Trans>,
      headerLabel: t`时长`,
      width: '96px',
      variant: 'numeric',
      cell: (entry) =>
        entry.row.durationSeconds === null ? '—' : `${entry.row.durationSeconds.toFixed(1)}s`,
    },
  ];

  /* 最近拍点 and 偏移 exist only when there is a beat grid. A column of dashes
     would be two columns of nothing, on a page whose whole point is that the
     numbers are real. */
  if (beats.length > 0) {
    columns.push(
      {
        id: 'beat',
        header: <Trans>最近拍点</Trans>,
        headerLabel: t`最近拍点`,
        width: '112px',
        cell: (entry) => {
          if (entry.row.startSeconds === null) return '—';
          const near = nearestBeat(beats, entry.row.startSeconds);
          return near === null ? '—' : <Trans>第 {beatOrdinal(near.beat)} 拍</Trans>;
        },
      },
      {
        id: 'offset',
        header: <Trans>偏移</Trans>,
        headerLabel: t`偏移`,
        width: '96px',
        variant: 'numeric',
        cell: (entry) => {
          if (entry.row.startSeconds === null) return '—';
          const near = nearestBeat(beats, entry.row.startSeconds);
          if (near === null) return '—';
          const offset = formatBeatOffset(near.offsetSeconds);
          return offset ?? <Trans>对齐</Trans>;
        },
      },
    );
  }

  return (
    <DataTable
      caption={<Trans>片段与拍点</Trans>}
      columns={columns}
      rows={rows}
      rowId={(entry) => entry.row.clip.clip_id}
      rowLabel={(entry) => entry.title}
      loading={desk.loading}
      activeRowId={selection.clipId}
      onRowActivate={(rowId) => selection.select(rowId)}
      empty={
        <EmptyState
          title={<Trans>还没有片段</Trans>}
          description={<Trans>先在上面添加片段，这里会给出它们与拍点的关系。</Trans>}
          headingLevel={4}
          actions={null}
        />
      }
    />
  );
}
