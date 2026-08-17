/*
 * Domain layer, 2 of 3 — agent/PlanStrip.
 *
 * The proportional band of shots, drawn on every Agent artboard and on both
 * rows of the 2a 方案对照. The widths come from `planStrip.ts`; this file is the
 * paint, the labels and the keyboard.
 *
 * ── Three things worth stating ────────────────────────────────────────────
 *
 * **Every block says what it is.** §6.2: 「颜色不单独承载含义」. A block prints
 * its number and its title, a removed block prints 「已过期」's sibling word
 * 「已删除」 next to a dashed outline, and each block's accessible name carries
 * number, title and length — so the four fills of `planStrip.ts` are a
 * redundant channel and never the only one.
 *
 * **It is a list of buttons when it can be selected, and a list of spans when
 * it cannot.** A band a pointer can click but a keyboard cannot reach is a band
 * half the users cannot use; `EvidenceRow` settled the same question the same
 * way.
 *
 * **Labels clip, the strip does not scroll.** The band is a *proportion*: a
 * 15-shot plan gives some blocks 2% of the width and their titles have to
 * disappear rather than push the band wider — the ruler underneath is only
 * readable if the band is exactly as wide as its container. The full title
 * stays reachable through `title` and the accessible name.
 */

import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import type { ReactNode } from 'react';

import { cn } from '../../design/primitives';
import type { AgentPlanShot } from '../../shared/desktop/dto';

import { formatShotDuration, formatStripTimecode } from './shotFormat';
import {
  planDuration,
  planStripSegments,
  stripRulerMarks,
  type PlanStripSegment,
  type PlanStripTone,
} from './planStripLayout';

/**
 * The four fills. `main` is the flat accent the artboards give the long 主体段,
 * `shot` the step above it, `lead` the neutral 留白 block, `removed` the dashed
 * outline with no fill at all.
 */
const TONE_CLASS: Readonly<Record<PlanStripTone, string>> = {
  lead: 'bg-neutral-300 text-neutral-800',
  shot: 'bg-accent-300 text-accent-900',
  main: 'bg-accent text-bg',
  removed: 'border border-dashed border-neutral-500 text-neutral-600',
};

/** The 留白 block's word. A descriptor, because `planStrip.ts` takes a string. */
const LEAD_LABEL = msg`留白`;

/** §3.4 has no token for this band; the artboards draw it 24–34px. */
const HEIGHT_CLASS = { sm: 'h-6', md: 'h-[30px]' } as const;

export type PlanStripHeight = keyof typeof HEIGHT_CLASS;

export interface PlanStripProps {
  readonly shots: readonly AgentPlanShot[];
  /** 「留白」's length. Drawn only when greater than zero. */
  readonly leadSeconds?: number | undefined;
  /** 「当前 42.0s」 — the row label the 2a compare puts left of the band. */
  readonly caption?: ReactNode | undefined;
  /** Draw the 00:00 · 00:10 · … marks underneath. */
  readonly ruler?: boolean | undefined;
  readonly selectedShotId?: string | null | undefined;
  readonly onSelectShot?: ((shot: AgentPlanShot) => void) | undefined;
  readonly height?: PlanStripHeight | undefined;
  /** Accessible name of the band itself — 「当前方案」 / 「接受全部变更后」. */
  readonly label: string;
  readonly className?: string | undefined;
}

export function PlanStrip({
  shots,
  leadSeconds,
  caption,
  ruler = false,
  selectedShotId,
  onSelectShot,
  height = 'md',
  label,
  className,
}: PlanStripProps) {
  const { i18n } = useLingui();
  const options = leadSeconds === undefined ? {} : { leadSeconds, leadLabel: i18n._(LEAD_LABEL) };
  const segments = planStripSegments(shots, options);
  const total = planDuration(shots, options);
  const byId = new Map(shots.map((shot) => [shot.id, shot]));

  return (
    <div data-plan-strip="" className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center gap-3">
        {caption === undefined ? null : (
          <span data-plan-strip-caption="" className="flex-none text-xs text-neutral-600">
            {caption}
          </span>
        )}
        <ol aria-label={label} className={cn('flex min-w-0 flex-1 gap-[3px]', HEIGHT_CLASS[height])}>
          {segments.map((segment) => (
            <StripBlock
              key={segment.id}
              segment={segment}
              selected={segment.id === selectedShotId}
              {...(onSelectShot === undefined || segment.index === null
                ? {}
                : { onSelect: () => {
                    const shot = byId.get(segment.id);
                    if (shot !== undefined) onSelectShot(shot);
                  } })}
            />
          ))}
        </ol>
      </div>

      {ruler ? (
        <div
          data-plan-strip-ruler=""
          aria-hidden="true"
          className="flex justify-between font-mono text-2xs text-neutral-600"
        >
          {stripRulerMarks(total).map((mark, index) => (
            // Positional fragments of one ruler, not a reorderable list.
            <span key={index}>{formatStripTimecode(mark)}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface StripBlockProps {
  readonly segment: PlanStripSegment;
  readonly selected: boolean;
  readonly onSelect?: (() => void) | undefined;
}

function StripBlock({ segment, selected, onSelect }: StripBlockProps) {
  const duration = formatShotDuration(segment.durationSeconds);
  const number = segment.index === null ? null : String(segment.index).padStart(2, '0');

  const body = (
    <>
      {number === null ? null : <span className="font-mono">{number}</span>}
      <span className="min-w-0 truncate">
        {segment.tone === 'removed' ? (
          <>
            <Trans>已删除</Trans>
            {segment.label === '' ? null : <span className="sr-only"> {segment.label}</span>}
          </>
        ) : (
          segment.label
        )}
      </span>
    </>
  );

  /* The accessible name says the three facts the block is drawn from, so a
     reader who never sees the fill gets the same reading a sighted one does. */
  const name =
    number === null
      ? `${segment.label} ${duration}`
      : `${number} ${segment.label} ${duration}`;

  const shared = cn(
    'flex min-w-0 items-center justify-center gap-1.5 overflow-hidden px-1 text-2xs whitespace-nowrap',
    TONE_CLASS[segment.tone],
    selected && 'outline-2 -outline-offset-2 outline-accent-900',
  );

  return (
    <li
      data-plan-strip-segment={segment.id}
      data-tone={segment.tone}
      style={{ width: `${String(segment.percent)}%` }}
      className="flex min-w-0"
      title={`${segment.label} · ${duration}`}
    >
      {onSelect === undefined ? (
        <span className={cn(shared, 'flex-1')} aria-label={name}>
          {body}
        </span>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={name}
          className={cn(shared, 'flex-1')}
        >
          {body}
        </button>
      )}
    </li>
  );
}
