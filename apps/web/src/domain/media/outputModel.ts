/*
 * pages/delivery — the facts an output card prints, derived from `OutputItem`.
 *
 * Pure and free of React and i18n, so the `unit` project can exhaust it.
 *
 * Media facts are probe results from the current file, never values inferred
 * from a design or requested capture settings. Missing probe fields stay absent.
 */

import type { DeleteOutputResult, OutputAvailability, OutputItem, OutputMediaInfo } from '../../shared/desktop/dto';

/**
 * Bytes as the artboard writes them: 「186 MB」, 「4.2 GB」, 「218 GB 可用」.
 *
 * Decimal units (1000-based), because that is what a file manager and a disk
 * vendor both show — an output the user is about to compare against free space
 * would otherwise disagree with the operating system by 7 %.
 *
 * One decimal below 10 in a unit, none above: 「4.2 GB」 and 「186 MB」 are both
 * the artboard's own forms. `null` in, `null` out — a record whose size the
 * service could not stat says nothing rather than 「0 B」.
 */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;

  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }

  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit] ?? 'B'}`;
}

/**
 * Whether the file behind the record is still where the record says.
 *
 * `unsafe` joins `missing` rather than `present`: `OutputAvailability`'s third
 * value means the service refused to resolve the path (it escaped the data
 * directory), so the one thing that is certain is that the app must not act on
 * it as if it were a normal file.
 */
export function outputFileIsUsable(availability: OutputAvailability): boolean {
  return availability === 'present';
}

/** Whether deleting the record could also delete a file the app owns. */
export function outputDeletionRemovesFile(item: OutputItem): boolean {
  return item.managed && outputFileIsUsable(item.availability);
}

/**
 * What one deletion did to the file, from `DeleteOutputResult.file_action`.
 *
 * The service names five outcomes; the page prints three sentences. A managed
 * file that could not leave its staging slot is the only one that needs a
 * follow-up (恢复中心's 清理暂存), so it is kept apart from a clean delete.
 */
export type OutputDeletionOutcome = 'file-deleted' | 'file-staged' | 'record-only';

export function outputDeletionOutcome(result: DeleteOutputResult): OutputDeletionOutcome {
  if (result.file_deleted) return 'file-deleted';
  return result.file_action === 'managed_file_pending_cleanup' ? 'file-staged' : 'record-only';
}

/**
 * A stored path as a person reads it.
 *
 * Managed recordings are stored under their canonical identity, which on
 * Windows carries the `\\?\` extended-length prefix (and `\\?\UNC\` for a
 * share). The prefix is the runtime's business and never the user's, so it is
 * removed everywhere a path is shown or copied; 定位文件 keeps the stored value.
 */
export function displayOutputPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
  if (path.startsWith('\\\\?\\')) return path.slice(4);
  return path;
}

/**
 * The same path split for a one-line row: the directory, which may be cut
 * from the end, and the file name, which never is. Cutting a path from the end
 * leaves 「C:\Users\demo\AppData\Roam…」 on every row; the name is the half
 * that tells rows apart.
 */
export function splitDisplayOutputPath(path: string): { readonly directory: string; readonly fileName: string } {
  const shown = displayOutputPath(path);
  const cut = Math.max(shown.lastIndexOf('\\'), shown.lastIndexOf('/'));
  return cut === -1
    ? { directory: '', fileName: shown }
    : { directory: shown.slice(0, cut + 1), fileName: shown.slice(cut + 1) };
}

/**
 * The 「录制结果 / 导出成片 / 合辑导出」 family, from the two fields that carry
 * it. `media_kind` is the service's free-form label for what the file is;
 * `output_kind` is the pipeline that made it. The pipeline is the one the
 * artboard's filter chips name, so it is what this returns, with the montage
 * split out the same way `taskModel` splits it (`data/outputs.ts` and
 * `crates/runtime/src/export.rs` agree on the two export kinds).
 */
export type OutputFamily = 'recording' | 'export' | 'montage';

export function outputFamilyOf(item: OutputItem): OutputFamily {
  if (item.output_kind === 'recording') return 'recording';
  return item.media_kind === 'montage' ? 'montage' : 'export';
}

export function formatOutputMedia(media: OutputMediaInfo | null): string[] {
  if (media === null) return [];
  const facts: string[] = [];
  if (media.duration_seconds !== null) facts.push(`${formatSeconds(media.duration_seconds)} s`);
  if (media.width !== null && media.height !== null) facts.push(`${String(media.width)}×${String(media.height)}`);
  if (media.frame_rate !== null) facts.push(`${formatFrameRate(media.frame_rate)} fps`);
  const codecs = [media.video_codec, media.audio_codec]
    .filter((codec): codec is string => codec !== null && codec.trim() !== '')
    .map((codec) => codec.toUpperCase());
  if (codecs.length > 0) facts.push(codecs.join(' / '));
  return facts;
}

function formatSeconds(seconds: number): string {
  return (Math.round(seconds * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatFrameRate(rate: string): string {
  const [numerator, denominator] = rate.split('/').map(Number);
  if (numerator !== undefined && denominator !== undefined && Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
    return (numerator / denominator).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return rate;
}
