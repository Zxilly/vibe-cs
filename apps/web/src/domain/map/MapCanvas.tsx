/*
 * Domain layer, 2 of 3 — `domain/map/`: the map surface and its coordinate system.
 *
 * Reference artboard: 「04 2D 回放与热力图」. A 720×720 hairline box centred in
 * the work area, a bottom-left legend chip, and — the caption states it
 * outright — 「右侧提供列表式替代视图，不只靠画布传达信息」.
 *
 * ═══ Why SVG, for all of it ═════════════════════════════════════════════════
 * The three candidate workloads and what each costs in a DOM-node renderer:
 *
 *   heat      up to ~10⁴ raw points. They never reach the DOM: `heatBinning`
 *             collapses them into at most `gridSize²` occupied cells first, and
 *             emits nothing for empty ones. At the default 48² that is a hard
 *             ceiling of 2304 rects and in practice a few hundred, because a
 *             map's playable area is a fraction of its bounding square. The
 *             binning is required for honesty anyway (see that module's note),
 *             so the node bound is free.
 *   paths     ten players × a few hundred samples = ten `<path>` elements. The
 *             sample count lives inside the `d` attribute, not in the node
 *             count, so this is cheap however long the round is.
 *   duels     a few hundred two-point lines that must be clickable, keyboard
 *             reachable and individually nameable.
 *
 * The third one decides it. In canvas, hit testing means keeping a parallel
 * geometry index and re-implementing pointer targeting, and accessibility means
 * building an invisible parallel DOM anyway — at which point the DOM exists and
 * the canvas is redundant. In SVG, hit testing is the browser's, `tabindex` and
 * `aria-label` work on `<g>` (verified in jsdom 30, which is why the keyboard
 * test in this directory is a real test and not a mock), and the only thing
 * bought back is node count — which binning already bounds.
 *
 * The cost is accepted and named: an unbinned 10⁴-point scatter would be slow,
 * so `HeatLayer` takes a `HeatDistribution`, not raw points, and there is no
 * API in this directory that puts one node per sample on screen.
 *
 * A basemap bitmap, when a page has one, goes *behind* the SVG as a plain
 * element (`basemap` prop) rather than an `<image>` inside it. That keeps the
 * one raster in the tree out of the vector layer's compositing, and it lets the
 * page decide how to feed it — which it must, because the Tauri CSP is
 * `default-src 'self'` and no URL from this directory could be loaded anyway.
 * With no basemap the canvas draws a blueprint grid, which is a stand-in that
 * cannot be mistaken for a map.
 *
 * ═══ Controlled, and free of data ═══════════════════════════════════════════
 * Per spec §2.1 rule 6 this component fetches nothing and imports no store.
 * The calibration arrives as a live `RadarOverviewRecord.transform` from the
 * page's query, or falls back to the checked-in table. Layers arrive as
 * children and receive the projection through a render callback, so no context
 * and no global are involved and a layer can be rendered standalone in a test.
 */

import { Trans } from '@lingui/react/macro';
import { useId, type ReactNode } from 'react';

import { EmptyState } from '../../design/data';
import { Notice, type NoticeAction } from '../../design/feedback';
import { Blueprint, cx } from '../../design/layout';
import {
  isUsableCalibration,
  resolveMapCalibration,
  type MapCalibration,
  type OverviewTransform,
} from './mapCalibration';
import { createMapProjection, type MapProjection } from './mapProjection';

/**
 * The artboard's canvas is 720×720. It is a content box, not a panel column, so
 * spec §3.5 has no token for it — the same disposition `design/data/EmptyState`
 * records for its own 172px box. Everything inside is projected into this
 * space and the `viewBox` scales it, so the number is a ratio anchor, not a
 * pixel commitment: at any rendered width one unit stays 1/720th of the canvas.
 */
export const MAP_CANVAS_EXTENT = 720;

/**
 * Blueprint grid pitch, in canvas units. 「04」 draws the work area behind the
 * canvas as a 40px grid; the placeholder reuses that pitch so the stand-in
 * reads as the same drafting surface rather than as a second scale.
 */
const GRID_PITCH = 40;

export type MapCanvasStatus = 'ready' | 'loading' | 'empty';

/** How a legend row is drawn. The artboard uses the first two. */
export type MapLegendGlyph = 'line' | 'dashed' | 'swatch' | 'outline';

/**
 * The palette roles a map object can take. Named by meaning, not by token, so a
 * page never spells a colour: 「04」 paints the focused player in accent, the
 * opposing side in `--color-team-b`, and kill-verified axes in `--color-fail`.
 */
export type MapTone = 'accent' | 'team-b' | 'fail' | 'ok' | 'muted';

export interface MapLegendItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly glyph: MapLegendGlyph;
  readonly tone: MapTone;
}

export interface MapCanvasError {
  readonly message: ReactNode;
  /** Notice requires a way out; so does this. */
  readonly action: NoticeAction;
}

export interface MapCanvasProps {
  /** `de_mirage`, as the workspace record spells it. */
  readonly mapName: string;
  /** Live transform from `RadarOverviewRecord`. Wins over the built-in table. */
  readonly overviewTransform?: OverviewTransform | null | undefined;
  /** Skip resolution entirely and use this. For tests and for synthetic maps. */
  readonly calibration?: MapCalibration | null | undefined;
  /** Accessible name of the drawing, e.g. 「Mirage · 第 21 回合」. */
  readonly label: string;
  /** The page's basemap element. Nothing is loaded from this directory. */
  readonly basemap?: ReactNode | undefined;
  readonly status?: MapCanvasStatus | undefined;
  /** Set to render the failure path; carries its own recovery action. */
  readonly error?: MapCanvasError | null | undefined;
  /** Extra sentence under the empty title, e.g. what filter produced it. */
  readonly emptyDescription?: ReactNode | undefined;
  /** Recovery actions for the empty state, per the states artboard's rule. */
  readonly emptyActions?: ReactNode | undefined;
  /** The bottom-left chip of 「04」. */
  readonly legend?: readonly MapLegendItem[] | undefined;
  /**
   * The text rendering of what is selected — 「Kael → Corvin · 穿墙 · 交战轴
   * 132° · 距离 18.7m」. The artboard puts a written summary beside the legend
   * for exactly this reason, and it is what makes a selection on a picture
   * perceivable without the picture.
   */
  readonly selectionSummary?: ReactNode | undefined;
  /** Provenance line, e.g. 「坐标来自本地 overview 与 VPK 雷达，采样 64 tick。」 */
  readonly footnote?: ReactNode | undefined;
  /** Layers. A callback receives the projection; plain nodes are rendered as-is. */
  readonly children?: ReactNode | ((projection: MapProjection) => ReactNode) | undefined;
  readonly className?: string | undefined;
}

const LEGEND_TONE_FILL: Record<MapTone, string> = {
  accent: 'bg-accent-800',
  'team-b': 'bg-team-b',
  fail: 'bg-fail',
  ok: 'bg-ok',
  muted: 'bg-neutral-400',
};

const LEGEND_TONE_BORDER: Record<MapTone, string> = {
  accent: 'border-accent-800',
  'team-b': 'border-team-b',
  fail: 'border-fail',
  ok: 'border-ok',
  muted: 'border-neutral-400',
};

function LegendGlyph({ glyph, tone }: { glyph: MapLegendGlyph; tone: MapTone }) {
  if (glyph === 'swatch') {
    return <span aria-hidden="true" className={cx('block size-[13px]', LEGEND_TONE_FILL[tone])} />;
  }
  if (glyph === 'outline') {
    return <span aria-hidden="true" className={cx('block size-[13px] border', LEGEND_TONE_BORDER[tone])} />;
  }
  if (glyph === 'dashed') {
    // 「04」: `width:18px;height:0;border-top:1.5px dashed`.
    return <span aria-hidden="true" className={cx('block w-[18px] border-t border-dashed', LEGEND_TONE_BORDER[tone])} />;
  }
  // 「04」: `width:18px;height:2px;background`.
  return <span aria-hidden="true" className={cx('block h-[2px] w-[18px]', LEGEND_TONE_FILL[tone])} />;
}

/** The square frame every state is drawn inside, so the layout never jumps. */
function CanvasFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Blueprint className={cx('relative aspect-square w-full max-w-[720px] bg-bg', className)}>{children}</Blueprint>
  );
}

export function MapCanvas({
  mapName,
  overviewTransform,
  calibration,
  label,
  basemap,
  status = 'ready',
  error,
  emptyDescription,
  emptyActions = null,
  legend,
  selectionSummary,
  footnote,
  children,
  className,
}: MapCanvasProps) {
  const gridId = useId();
  const captionId = useId();

  const resolved = calibration ?? resolveMapCalibration(mapName, overviewTransform);
  const usable = isUsableCalibration(resolved);
  const provisional = usable && resolved.confidence === 'provisional';

  let body: ReactNode;
  if (error) {
    body = (
      <Notice tone="danger" action={error.action}>
        {error.message}
      </Notice>
    );
  } else if (status === 'loading') {
    // No percentage and no fake grid: the states artboard forbids a made-up
    // denominator, and a partially drawn map would be exactly that.
    body = (
      <CanvasFrame className="animate-pulse bg-neutral-200">
        <span role="status" aria-busy="true" className="sr-only">
          <Trans>正在读取空间证据</Trans>
        </span>
      </CanvasFrame>
    );
  } else if (!usable) {
    body = (
      <EmptyState
        title={<Trans>缺少这张地图的雷达标定</Trans>}
        description={
          <Trans>
            没有找到 {mapName} 的 overview 变换，世界坐标无法落到画面上。安装 CS2 后可从本地雷达读取。
          </Trans>
        }
        actions={emptyActions}
      />
    );
  } else if (status === 'empty') {
    body = (
      <EmptyState
        title={<Trans>这张地图还没有空间证据</Trans>}
        description={emptyDescription ?? <Trans>分析完成后才有位置样本、朝向与经击杀验证的交战轴。</Trans>}
        actions={emptyActions}
      />
    );
  } else {
    const projection = createMapProjection(resolved, {
      width: MAP_CANVAS_EXTENT,
      height: MAP_CANVAS_EXTENT,
    });
    body = (
      <CanvasFrame>
        {basemap === undefined ? null : <div className="absolute inset-0 overflow-hidden">{basemap}</div>}
        <svg
          viewBox={`0 0 ${MAP_CANVAS_EXTENT} ${MAP_CANVAS_EXTENT}`}
          className="absolute inset-0 block size-full"
          role="group"
          aria-label={label}
          aria-describedby={captionId}
          data-map={resolved.mapName}
        >
          <title>{label}</title>
          {basemap === undefined ? (
            <>
              <defs>
                <pattern id={gridId} width={GRID_PITCH} height={GRID_PITCH} patternUnits="userSpaceOnUse">
                  <path
                    d={`M ${GRID_PITCH} 0 L 0 0 0 ${GRID_PITCH}`}
                    fill="none"
                    className="stroke-grid"
                    strokeWidth={1}
                  />
                </pattern>
              </defs>
              <rect
                x={0}
                y={0}
                width={MAP_CANVAS_EXTENT}
                height={MAP_CANVAS_EXTENT}
                fill={`url(#${gridId})`}
                data-testid="map-blueprint-grid"
              />
            </>
          ) : null}
          {typeof children === 'function' ? children(projection) : children}
        </svg>
        {legend && legend.length > 0 ? (
          <ul className="absolute bottom-3 left-3 flex list-none flex-wrap gap-4 border border-divider bg-bg px-2 py-1 text-2xs text-neutral-700">
            {legend.map((item) => (
              <li key={item.id} className="inline-flex items-center gap-2">
                <LegendGlyph glyph={item.glyph} tone={item.tone} />
                {item.label}
              </li>
            ))}
          </ul>
        ) : null}
      </CanvasFrame>
    );
  }

  return (
    <figure className={cx('flex min-h-0 min-w-0 flex-col gap-3', className)} data-map-name={mapName}>
      <div className="flex min-h-0 flex-1 items-center justify-center p-5">{body}</div>
      <figcaption id={captionId} className="flex flex-col gap-1 text-xs leading-normal text-neutral-700">
        {/*
          The selection's written form. `aria-live` because selecting a shape on
          a drawing produces no other announcement — the shape itself is silent.
        */}
        {selectionSummary === undefined ? null : (
          <p aria-live="polite" data-testid="map-selection-summary" className="text-sm text-text">
            {selectionSummary}
          </p>
        )}
        {provisional ? (
          <p data-testid="map-calibration-warning" className="text-warn-text">
            <Trans>{resolved.mapName} 用的是占位标定，坐标可能整体偏移；接上本地雷达后会自动改用真实变换。</Trans>
          </p>
        ) : null}
        {footnote === undefined ? null : <p>{footnote}</p>}
      </figcaption>
    </figure>
  );
}
