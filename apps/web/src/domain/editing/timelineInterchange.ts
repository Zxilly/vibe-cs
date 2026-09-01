import type {
  EditingDocument,
  MediaAsset,
  Project,
  ProjectEditOperation,
  TextStyle,
  TimelineClip,
  TimelineTrack,
} from '../../shared/desktop/dto';
import { DEFAULT_EDITOR_TEXT_BACKGROUND, DEFAULT_EDITOR_TEXT_COLOR } from '../../design/timeline';

export type TimelineInterchangeFormat = 'otio' | 'xml' | 'edl';

export interface TimelineInterchangeExport {
  readonly text: string;
  readonly warnings: readonly string[];
}

export interface TimelineInterchangeImport {
  readonly operations: readonly ProjectEditOperation[];
  readonly warnings: readonly string[];
  readonly trackCount: number;
  readonly clipCount: number;
}

interface ImportedClip {
  readonly name: string;
  readonly start: number;
  readonly duration: number;
  readonly sourceIn: number;
  readonly sourceOut: number;
  readonly assetId: string | null;
  readonly sourcePath: string | null;
  readonly enabled: boolean;
  readonly text: TextStyle | null;
}

interface ImportedTrack {
  readonly name: string;
  readonly kind: TimelineTrack['kind'];
  readonly clips: readonly ImportedClip[];
}

export function exportTimelineInterchange(
  project: Project,
  assets: readonly MediaAsset[],
  format: TimelineInterchangeFormat,
): TimelineInterchangeExport {
  if (format === 'otio') return exportOtio(project, assets);
  if (format === 'xml') return exportFcpXml(project, assets);
  return exportCmxEdl(project, assets);
}

export function importTimelineInterchange(
  text: string,
  format: TimelineInterchangeFormat,
  document: EditingDocument,
  assets: readonly MediaAsset[],
  createId: () => string,
): TimelineInterchangeImport {
  const parsed = format === 'otio'
    ? importOtio(text)
    : format === 'xml'
      ? importFcpXml(text, document.fps)
      : importCmxEdl(text, document.fps);
  return {
    operations: interchangeOperations(parsed.tracks, document, assets, createId),
    warnings: parsed.warnings,
    trackCount: parsed.tracks.length,
    clipCount: parsed.tracks.reduce((count, track) => count + track.clips.length, 0),
  };
}

export function interchangeFormatFromPath(path: string): TimelineInterchangeFormat | null {
  const extension = path.trim().toLowerCase().split('.').at(-1);
  if (extension === 'otio') return 'otio';
  if (extension === 'xml') return 'xml';
  if (extension === 'edl') return 'edl';
  return null;
}

function exportOtio(project: Project, assets: readonly MediaAsset[]): TimelineInterchangeExport {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset] as const));
  const warnings: string[] = [];
  const tracks = [...project.document.tracks]
    .filter((track) => !track.hidden)
    .sort((left, right) => left.order - right.order)
    .map((track) => {
      let cursor = 0;
      const children: unknown[] = [];
      for (const clip of [...track.clips].filter((item) => item.placement.enabled).sort(byTimelineStart)) {
        if (clip.placement.start > cursor + 1e-6) {
          children.push({
            OTIO_SCHEMA: 'Gap.1',
            name: '',
            source_range: otioTimeRange(0, clip.placement.start - cursor, project.document.fps),
            effects: [], markers: [], metadata: {}, enabled: true,
          });
        } else if (clip.placement.start < cursor - 1e-6) {
          warnings.push(`Track ${track.name}: overlapping clip ${clip.name} relies on Vibe CS timeline_start metadata.`);
        }
        const assetId = clipAssetId(clip);
        const asset = assetId === null ? null : assetsById.get(assetId) ?? null;
        children.push({
          OTIO_SCHEMA: 'Clip.2',
          name: clip.name,
          source_range: otioTimeRange(
            clip.placement.source_in,
            clip.placement.source_out - clip.placement.source_in,
            project.document.fps,
          ),
          effects: [],
          markers: [],
          enabled: clip.placement.enabled,
          metadata: {
            vibe_cs: {
              timeline_start_seconds: clip.placement.start,
              timeline_duration_seconds: clip.placement.duration,
              track_kind: track.kind,
              asset_id: assetId,
              speed: clip.placement.speed,
              reverse: clip.placement.reverse,
              text: clip.text,
            },
          },
          media_reference: asset === null
            ? { OTIO_SCHEMA: 'MissingReference.1', name: clip.name, metadata: {} }
            : {
                OTIO_SCHEMA: 'ExternalReference.1',
                name: asset.name,
                target_url: fileUrl(asset.path),
                available_range: asset.duration_seconds === null
                  ? null
                  : otioTimeRange(0, asset.duration_seconds, project.document.fps),
                metadata: { vibe_cs: { asset_id: asset.id } },
              },
        });
        cursor = Math.max(cursor, clip.placement.start + clip.placement.duration);
      }
      return {
        OTIO_SCHEMA: 'Track.1',
        name: track.name,
        kind: track.kind === 'audio' ? 'Audio' : 'Video',
        children,
        source_range: null,
        effects: [], markers: [],
        metadata: { vibe_cs: { track_kind: track.kind } },
        enabled: true,
      };
    });
  return {
    text: `${JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      name: project.name,
      global_start_time: null,
      metadata: { vibe_cs: { width: project.document.width, height: project.document.height, fps: project.document.fps } },
      tracks: { OTIO_SCHEMA: 'Stack.1', name: 'tracks', children: tracks, source_range: null, effects: [], markers: [], metadata: {}, enabled: true },
    }, null, 2)}\n`,
    warnings,
  };
}

function exportFcpXml(project: Project, assets: readonly MediaAsset[]): TimelineInterchangeExport {
  const story = storyTrack(project.document);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset] as const));
  const fps = project.document.fps;
  const clips = story.clips.filter((clip) => clip.placement.enabled).sort(byTimelineStart);
  const warnings = nonStoryWarnings(project.document, 'Final Cut Pro XML');
  const clipItems = clips.map((clip, index) => {
    const assetId = clipAssetId(clip);
    const asset = assetId === null ? null : assetsById.get(assetId) ?? null;
    if (asset === null) warnings.push(`Unlinked clip ${clip.name} exports without a file path.`);
    return `<clipitem id="clipitem-${index + 1}"><name>${xml(clip.name)}</name><enabled>${clip.placement.enabled ? 'TRUE' : 'FALSE'}</enabled><start>${frames(clip.placement.start, fps)}</start><end>${frames(clip.placement.start + clip.placement.duration, fps)}</end><in>${frames(clip.placement.source_in, fps)}</in><out>${frames(clip.placement.source_out, fps)}</out><file id="file-${index + 1}"><name>${xml(asset?.name ?? clip.name)}</name><pathurl>${xml(asset === null ? '' : fileUrl(asset.path))}</pathurl><rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate></file><logginginfo><lognote>${xml(assetId === null ? '' : `vibe-cs-asset-id:${assetId}`)}</lognote></logginginfo></clipitem>`;
  }).join('');
  return {
    text: `<?xml version="1.0" encoding="UTF-8"?>\n<xmeml version="5"><sequence id="sequence-1"><name>${xml(project.name)}</name><duration>${frames(project.document.duration_seconds, fps)}</duration><rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate><media><video><format><samplecharacteristics><width>${project.document.width}</width><height>${project.document.height}</height></samplecharacteristics></format><track>${clipItems}</track></video></media></sequence></xmeml>\n`,
    warnings,
  };
}

function exportCmxEdl(project: Project, assets: readonly MediaAsset[]): TimelineInterchangeExport {
  const story = storyTrack(project.document);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset] as const));
  const fps = project.document.fps;
  const warnings = nonStoryWarnings(project.document, 'CMX3600 EDL');
  const events: string[] = [`TITLE: ${project.name}`, 'FCM: NON-DROP FRAME', ''];
  story.clips.filter((clip) => clip.placement.enabled).sort(byTimelineStart).forEach((clip, index) => {
    const assetId = clipAssetId(clip);
    const asset = assetId === null ? null : assetsById.get(assetId) ?? null;
    const reel = reelName(asset?.name ?? clip.name);
    events.push(`${String(index + 1).padStart(3, '0')}  ${reel.padEnd(8)} V     C        ${timecode(clip.placement.source_in, fps)} ${timecode(clip.placement.source_out, fps)} ${timecode(clip.placement.start, fps)} ${timecode(clip.placement.start + clip.placement.duration, fps)}`);
    events.push(`* FROM CLIP NAME: ${clip.name}`);
    if (assetId !== null) events.push(`* VIBE-CS-ASSET-ID: ${assetId}`);
    if (asset !== null) events.push(`* SOURCE FILE: ${asset.path}`);
    events.push('');
  });
  return { text: `${events.join('\r\n')}\r\n`, warnings };
}

function importOtio(text: string): { tracks: ImportedTrack[]; warnings: string[] } {
  let root: unknown;
  try { root = JSON.parse(text); } catch { throw new Error('OTIO JSON is invalid.'); }
  if (!isRecord(root) || typeof root.OTIO_SCHEMA !== 'string' || !root.OTIO_SCHEMA.startsWith('Timeline.')) {
    throw new Error('OTIO root must be a Timeline.');
  }
  const stack = isRecord(root.tracks) ? root.tracks : null;
  if (stack === null || !Array.isArray(stack.children)) throw new Error('OTIO Timeline has no track stack.');
  const warnings: string[] = [];
  const tracks: ImportedTrack[] = [];
  for (const rawTrack of stack.children) {
    if (!isRecord(rawTrack) || !Array.isArray(rawTrack.children)) continue;
    const metadata = vibeMetadata(rawTrack.metadata);
    const kind = trackKind(metadata.track_kind, rawTrack.kind);
    let cursor = 0;
    const clips: ImportedClip[] = [];
    for (const child of rawTrack.children) {
      if (!isRecord(child)) continue;
      if (typeof child.OTIO_SCHEMA === 'string' && child.OTIO_SCHEMA.startsWith('Gap.')) {
        cursor += otioRange(child.source_range).duration;
        continue;
      }
      if (typeof child.OTIO_SCHEMA !== 'string' || !child.OTIO_SCHEMA.startsWith('Clip.')) {
        warnings.push(`Track ${String(rawTrack.name ?? '')}: unsupported OTIO child was skipped.`);
        continue;
      }
      const source = otioRange(child.source_range);
      const clipMetadata = vibeMetadata(child.metadata);
      const reference = isRecord(child.media_reference) ? child.media_reference : {};
      const referenceMetadata = vibeMetadata(reference.metadata);
      const duration = finitePositive(clipMetadata.timeline_duration_seconds) ?? source.duration;
      const start = finiteNonNegative(clipMetadata.timeline_start_seconds) ?? cursor;
      clips.push({
        name: boundedName(child.name),
        start,
        duration,
        sourceIn: source.start,
        sourceOut: source.start + source.duration,
        assetId: stringOrNull(clipMetadata.asset_id) ?? stringOrNull(referenceMetadata.asset_id),
        sourcePath: targetPath(reference.target_url),
        enabled: child.enabled !== false,
        text: textStyleOrNull(clipMetadata.text),
      });
      cursor = Math.max(cursor, start + duration);
    }
    tracks.push({ name: boundedName(rawTrack.name), kind, clips });
  }
  return { tracks, warnings };
}

function importFcpXml(text: string, fallbackFps: number): { tracks: ImportedTrack[]; warnings: string[] } {
  const xmlDocument = new DOMParser().parseFromString(text, 'application/xml');
  if (xmlDocument.querySelector('parsererror') !== null) throw new Error('Final Cut Pro XML is invalid.');
  const sequence = xmlDocument.querySelector('xmeml > sequence');
  if (sequence === null) throw new Error('Final Cut Pro XML has no sequence.');
  const fps = positiveNumber(sequence.querySelector(':scope > rate > timebase')?.textContent) ?? fallbackFps;
  const clips: ImportedClip[] = [...sequence.querySelectorAll(':scope > media > video > track > clipitem')].map((item) => {
    const startFrame = number(item, ':scope > start');
    const endFrame = number(item, ':scope > end');
    const sourceIn = number(item, ':scope > in') / fps;
    const sourceOut = number(item, ':scope > out') / fps;
    const note = item.querySelector(':scope > logginginfo > lognote')?.textContent ?? '';
    const assetId = note.match(/vibe-cs-asset-id:([0-9a-f-]{36})/iu)?.[1] ?? null;
    return {
      name: boundedName(item.querySelector(':scope > name')?.textContent),
      start: startFrame / fps,
      duration: Math.max(1 / fps, (endFrame - startFrame) / fps),
      sourceIn,
      sourceOut: Math.max(sourceIn + 1 / fps, sourceOut),
      assetId,
      sourcePath: targetPath(item.querySelector(':scope > file > pathurl')?.textContent),
      enabled: item.querySelector(':scope > enabled')?.textContent?.trim().toUpperCase() !== 'FALSE',
      text: null,
    };
  });
  return { tracks: [{ name: 'Story', kind: 'video', clips }], warnings: [] };
}

function importCmxEdl(text: string, fps: number): { tracks: ImportedTrack[]; warnings: string[] } {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const clips: ImportedClip[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = line.match(/^\s*\d+\s+\S+\s+V\s+C\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})/u);
    if (match === null) continue;
    const comments: string[] = [];
    while ((lines[index + 1] ?? '').startsWith('*')) comments.push(lines[index += 1] ?? '');
    const sourceIn = parseTimecode(match[1]!, fps);
    const sourceOut = parseTimecode(match[2]!, fps);
    const start = parseTimecode(match[3]!, fps);
    const end = parseTimecode(match[4]!, fps);
    clips.push({
      name: commentValue(comments, '* FROM CLIP NAME:') || `EDL ${clips.length + 1}`,
      start,
      duration: Math.max(1 / fps, end - start),
      sourceIn,
      sourceOut: Math.max(sourceIn + 1 / fps, sourceOut),
      assetId: commentValue(comments, '* VIBE-CS-ASSET-ID:') || null,
      sourcePath: commentValue(comments, '* SOURCE FILE:') || null,
      enabled: true,
      text: null,
    });
  }
  if (clips.length === 0) throw new Error('CMX3600 EDL contains no supported video events.');
  return { tracks: [{ name: 'Story', kind: 'video', clips }], warnings: [] };
}

function interchangeOperations(
  imported: readonly ImportedTrack[],
  document: EditingDocument,
  assets: readonly MediaAsset[],
  createId: () => string,
): ProjectEditOperation[] {
  const firstVideo = imported.find((track) => track.kind === 'video' || track.kind === 'overlay') ?? null;
  const tracks = [
    firstVideo === null ? { name: 'Story', kind: 'video' as const, clips: [] } : firstVideo,
    ...imported.filter((track) => track !== firstVideo),
  ].map((track, order) => materializeTrack(track, order === 0 ? document.story_track_id : createId(), order, assets, createId));
  const operations: ProjectEditOperation[] = [{
    op: 'replace_track',
    track_id: document.story_track_id,
    track: { ...tracks[0]!, id: document.story_track_id, kind: 'video', order: 0 },
  }];
  for (const track of document.tracks.filter((track) => track.id !== document.story_track_id)) {
    operations.push({ op: 'remove_track', track_id: track.id });
  }
  tracks.slice(1).forEach((track, index) => operations.push({ op: 'insert_track', index: index + 1, track }));
  operations.push({ op: 'replace_markers', markers: [] });
  return operations;
}

function materializeTrack(track: ImportedTrack, id: string, order: number, assets: readonly MediaAsset[], createId: () => string): TimelineTrack {
  return {
    id,
    name: track.name || (order === 0 ? 'Story' : `Track ${order + 1}`),
    kind: track.kind,
    order,
    muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false,
    clips: track.clips.map((clip) => materializeClip(clip, track.kind, assets, createId)),
  };
}

function materializeClip(clip: ImportedClip, kind: TimelineTrack['kind'], assets: readonly MediaAsset[], createId: () => string): TimelineClip {
  const asset = resolveAsset(clip.assetId, clip.sourcePath, assets);
  const text = kind === 'text' || kind === 'caption'
    ? clip.text ?? {
        content: clip.name,
        font_family: 'Arial',
        font_asset_id: null,
        font_size: kind === 'caption' ? 48 : 72,
        color: DEFAULT_EDITOR_TEXT_COLOR,
        background: DEFAULT_EDITOR_TEXT_BACKGROUND,
        align: 'center',
      }
    : clip.text;
  return {
    id: createId(),
    name: clip.name,
    capture_intent: null,
    material: asset === null || text !== null
      ? { kind: 'planned' }
      : { kind: 'asset', asset_id: asset.id, media_duration_seconds: asset.duration_seconds ?? clip.sourceOut },
    placement: {
      start: clip.start,
      duration: clip.duration,
      source_in: clip.sourceIn,
      source_out: clip.sourceOut,
      speed: 1,
      reverse: false,
      frame_hold_source_time: null,
      volume: 1,
      pan: 0,
      enabled: clip.enabled,
    },
    transform: { x: 0, y: kind === 'caption' ? 360 : 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
    text,
    metadata: asset === null && clip.sourcePath !== null
      ? { interchange_source_path: clip.sourcePath, interchange_unlinked: true }
      : {},
    group_id: null,
    link_group_id: null,
    keyframes: [],
    speed_segments: [],
  };
}

function resolveAsset(id: string | null, path: string | null, assets: readonly MediaAsset[]): MediaAsset | null {
  if (id !== null) {
    const exact = assets.find((asset) => asset.id.toLowerCase() === id.toLowerCase());
    if (exact !== undefined) return exact;
  }
  if (path === null) return null;
  const normalized = normalizePath(path);
  return assets.find((asset) => normalizePath(asset.path) === normalized)
    ?? assets.find((asset) => fileName(asset.path).toLowerCase() === fileName(path).toLowerCase())
    ?? null;
}

function storyTrack(document: EditingDocument): TimelineTrack {
  const story = document.tracks.find((track) => track.id === document.story_track_id);
  if (story === undefined) throw new Error('Project has no Story track.');
  return story;
}

function nonStoryWarnings(document: EditingDocument, format: string): string[] {
  const omitted = document.tracks.filter((track) => track.id !== document.story_track_id && !track.hidden && track.clips.some((clip) => clip.placement.enabled));
  return omitted.length === 0 ? [] : [`${format} subset exports Story video only; ${omitted.length} non-Story track(s) were omitted.`];
}

function clipAssetId(clip: TimelineClip): string | null {
  return clip.material.kind === 'planned' ? null : clip.material.asset_id;
}

function otioTimeRange(start: number, duration: number, rate: number): unknown {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: { OTIO_SCHEMA: 'RationalTime.1', value: start * rate, rate },
    duration: { OTIO_SCHEMA: 'RationalTime.1', value: duration * rate, rate },
  };
}

function otioRange(value: unknown): { start: number; duration: number } {
  if (!isRecord(value)) return { start: 0, duration: 0 };
  return { start: rationalSeconds(value.start_time), duration: rationalSeconds(value.duration) };
}

function rationalSeconds(value: unknown): number {
  if (!isRecord(value)) return 0;
  const rate = positiveNumber(value.rate) ?? 1;
  return Math.max(0, (finiteNumber(value.value) ?? 0) / rate);
}

function trackKind(metadataKind: unknown, otioKind: unknown): TimelineTrack['kind'] {
  if (metadataKind === 'audio' || metadataKind === 'text' || metadataKind === 'caption' || metadataKind === 'overlay' || metadataKind === 'video') return metadataKind;
  return otioKind === 'Audio' ? 'audio' : 'video';
}

function textStyleOrNull(value: unknown): TextStyle | null {
  if (!isRecord(value)
    || typeof value.content !== 'string'
    || typeof value.font_family !== 'string'
    || typeof value.font_size !== 'number'
    || typeof value.color !== 'string'
    || typeof value.align !== 'string') return null;
  return {
    content: value.content,
    font_family: value.font_family,
    font_asset_id: typeof value.font_asset_id === 'string' ? value.font_asset_id : null,
    font_size: value.font_size,
    color: value.color,
    background: typeof value.background === 'string' ? value.background : null,
    align: value.align,
  };
}

function targetPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (!value.toLowerCase().startsWith('file:')) return value;
  try {
    const url = new URL(value);
    const decoded = decodeURIComponent(url.pathname);
    return /^\/[A-Za-z]:/u.test(decoded) ? decoded.slice(1) : decoded;
  } catch { return value; }
}

function fileUrl(path: string): string {
  const normalized = path.replace(/^\\\\\?\\/u, '').replaceAll('\\', '/');
  return `file:///${encodeURI(normalized).replaceAll('#', '%23')}`;
}

function normalizePath(path: string): string {
  return path.replace(/^\\\\\?\\/u, '').replaceAll('\\', '/').replace(/^\//u, '').toLowerCase();
}

function fileName(path: string): string {
  return path.replaceAll('\\', '/').split('/').at(-1) ?? path;
}

function commentValue(comments: readonly string[], prefix: string): string {
  const comment = comments.find((candidate) => candidate.startsWith(prefix));
  return comment?.slice(prefix.length).trim() ?? '';
}

function timecode(seconds: number, fps: number): string {
  const total = Math.max(0, Math.round(seconds * fps));
  const framesValue = total % fps;
  const totalSeconds = Math.floor(total / fps);
  const secs = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  return [hours, minutes, secs, framesValue].map((part) => String(part).padStart(2, '0')).join(':');
}

function parseTimecode(value: string, fps: number): number {
  const [hours, minutes, seconds, frame] = value.split(':').map(Number);
  return ((hours ?? 0) * 3_600 + (minutes ?? 0) * 60 + (seconds ?? 0)) + (frame ?? 0) / fps;
}

function frames(seconds: number, fps: number): number { return Math.max(0, Math.round(seconds * fps)); }
function reelName(name: string): string { return name.toUpperCase().replace(/[^A-Z0-9]/gu, '').slice(0, 8) || 'AX'; }
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function number(parent: Element, selector: string): number { return finiteNumber(Number(parent.querySelector(selector)?.textContent)) ?? 0; }
function boundedName(value: unknown): string { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 512) : 'Untitled'; }
function positiveNumber(value: unknown): number | null { const numberValue = finiteNumber(Number(value)); return numberValue !== null && numberValue > 0 ? numberValue : null; }
function finitePositive(value: unknown): number | null { const numberValue = finiteNumber(value); return numberValue !== null && numberValue > 0 ? numberValue : null; }
function finiteNonNegative(value: unknown): number | null { const numberValue = finiteNumber(value); return numberValue !== null && numberValue >= 0 ? numberValue : null; }
function finiteNumber(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function stringOrNull(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function vibeMetadata(value: unknown): Record<string, unknown> { return isRecord(value) && isRecord(value.vibe_cs) ? value.vibe_cs : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function byTimelineStart(left: TimelineClip, right: TimelineClip): number { return left.placement.start - right.placement.start || left.id.localeCompare(right.id); }
