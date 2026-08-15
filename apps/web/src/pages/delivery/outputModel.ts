/*
 * pages/delivery — the facts an output card prints, derived from `OutputItem`.
 *
 * Pure and free of React and i18n, so the `unit` project can exhaust it.
 *
 * ── What the artboard asks for and the wire does not carry ────────────────
 *
 * 「11 输出与任务记录」 prints 「42 秒 · 60 fps · 186 MB · H.264 / AAC」 under a
 * 168×95 thumbnail. Of those five facts `OutputItem` carries exactly one:
 * `size_bytes`. There is no duration, no frame rate, no codec pair, no
 * thumbnail path and no resolution on the record (`shared/desktop/dto.ts`), and
 * no command returns them.
 *
 * So the card prints what exists — file name, size, stamp, and whether the file
 * is managed by the app or lives outside it — and the missing facts are
 * reported as a contract gap rather than filled with plausible numbers. The one
 * thing that must not happen here is 「60 fps」 appearing because it appears on
 * an artboard.
 */

import type { OutputAvailability, OutputItem } from '../../shared/desktop/dto';

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
