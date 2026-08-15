/*
 * Domain layer, 2 of 3 — `domain/map/`: duels.
 *
 * Reference: 「04 2D 回放与热力图」 draws each engagement as a dashed axis in the
 * brick red spec §3.1 collects as `--color-fail`, from attacker to victim, with
 * an X at the victim's end, and names it in the legend
 * 「经击杀验证的交战轴」. The event
 * list on the right rail gives the same objects in words — 「Kael → Corvin ·
 * 穿墙」, 「交战轴 132° · 距离 18.7m」 — and the artboard's caption states why
 * both exist: 「右侧提供列表式替代视图，不只靠画布传达信息」.
 *
 * This layer therefore has to do two things at once: draw an axis, and be a
 * selectable object with a name a reader can hear. Selection is controlled
 * (`selectedEngagementId` in, `onSelectEngagement` out) and keyboard movement
 * comes from `useRovingSelection`, so the map is one tab stop and the arrows
 * walk the duels.
 *
 * ── Marking selection without recolouring evidence ─────────────────────────
 * The axis keeps `--color-fail` whatever happens to it, because the colour is
 * what the legend defines it as — a kill-verified axis. Selection is carried by
 * weight and by an accent ring on the two endpoints, so a selected duel is
 * still legibly a duel and the legend keeps meaning what it says.
 *
 * ── Qualifiers ─────────────────────────────────────────────────────────────
 * 穿墙 / 闪盲 / 爆头 reach the DOM as data attributes *and* the accessible name;
 * only 穿墙 changes the drawing (a heavier dash), because it is the one the
 * product treats as a risk elsewhere — spec §3.1 assigns 「穿墙风险」 to
 * `--color-warn` on the recording side.
 */

import { t } from '@lingui/core/macro';

import { LayerEmpty } from './LayerEmpty';
import type { MapProjection } from './mapProjection';
import { crossCommand, worldBearingDegrees, worldDistanceMetres } from './pathGeometry';
import type { MapSide, WorldPoint } from './types';
import { useRovingSelection } from './useRovingSelection';

/** One end of a duel: who, where, and on whose side. */
export interface EngagementActor extends WorldPoint {
  /** `ReplayPlayerRecord.id`. */
  readonly playerId: string;
  /** `ReplayPlayerRecord.name`. */
  readonly playerName: string;
  readonly side?: MapSide | undefined;
}

/**
 * One kill. `id` and `tick` are what a page needs to route back into the
 * workspace (spec §4.4 keeps `tick` and `evidence` in the URL); the id is
 * expected to be the evidence id, which is what `PlayerHeatmapPoint.evidence_id`
 * carries for the same event.
 */
export interface Engagement {
  readonly id: string;
  readonly tick: number;
  readonly round?: number | undefined;
  readonly attacker: EngagementActor;
  readonly victim: EngagementActor;
  /** As the demo spells it — `deagle`, `ak47`. Rendered verbatim. */
  readonly weapon: string;
  readonly headshot?: boolean | undefined;
  /** 穿墙. */
  readonly throughWall?: boolean | undefined;
  /** 闪盲 — the attacker was blind when they fired. */
  readonly attackerBlind?: boolean | undefined;
  /** 闪盲 — the victim was blind when they died. */
  readonly victimBlind?: boolean | undefined;
}

export interface EngagementLayerProps {
  readonly projection: MapProjection;
  readonly engagements: readonly Engagement[];
  readonly visible?: boolean | undefined;
  readonly selectedEngagementId?: string | null | undefined;
  readonly highlightedEngagementId?: string | null | undefined;
  /** Omit to render a read-only layer. */
  readonly onSelectEngagement?: ((engagementId: string) => void) | undefined;
  readonly className?: string | undefined;
}

const VICTIM_CROSS_SIZE = 16;
const ATTACKER_RADIUS = 4;
const SELECTION_RING_RADIUS = 11;

/**
 * The written form of one duel — 「Kael → Corvin · 穿墙 · 交战轴 132° · 距离
 * 18.7m」. Exported because the page's event list needs the identical sentence:
 * the artboard's whole point is that the list and the canvas describe the same
 * objects, and two spellings of one duel would break that.
 *
 * The angle and the distance are computed in *world* space by `pathGeometry`,
 * not from the drawing, so they do not change when the canvas is resized.
 */
export function describeEngagement(engagement: Engagement): string {
  const bearing = worldBearingDegrees(engagement.attacker, engagement.victim);
  const distance = worldDistanceMetres(engagement.attacker, engagement.victim);
  const attacker = engagement.attacker.playerName;
  const victim = engagement.victim.playerName;
  const weapon = engagement.weapon;

  const parts: string[] = [t`${attacker} → ${victim} · ${weapon}`];
  if (engagement.throughWall) parts.push(t`穿墙`);
  if (engagement.headshot) parts.push(t`爆头`);
  if (engagement.attackerBlind) parts.push(t`闪盲开火`);
  if (engagement.victimBlind) parts.push(t`受害者被闪`);
  if (bearing !== null) {
    const degrees = Math.round(bearing);
    parts.push(t`交战轴 ${degrees}°`);
  }
  if (distance !== null) {
    const metres = distance.toFixed(1);
    parts.push(t`距离 ${metres}m`);
  }
  return parts.join(' · ');
}

export function EngagementLayer({
  projection,
  engagements,
  visible = true,
  selectedEngagementId,
  highlightedEngagementId,
  onSelectEngagement,
  className,
}: EngagementLayerProps) {
  const items = engagements.map((engagement) => ({ id: engagement.id }));
  const selection = useRovingSelection(items, {
    selectedId: selectedEngagementId,
    ...(onSelectEngagement ? { onSelect: onSelectEngagement } : {}),
  });

  if (!visible) return null;

  if (engagements.length === 0) {
    return <LayerEmpty layer="engagements" label={t`交火：这一段没有经击杀验证的交战轴`} />;
  }

  return (
    <g
      className={className}
      data-layer="engagements"
      {...(selection.interactive ? { role: 'listbox' as const, 'aria-label': t`交火` } : {})}
    >
      {engagements.map((engagement, index) => {
        const from = projection.toCanvas(engagement.attacker);
        const to = projection.toCanvas(engagement.victim);
        const emphasised =
          engagement.id === selectedEngagementId ||
          engagement.id === highlightedEngagementId ||
          engagement.id === selection.hoveredId;
        const selected = engagement.id === selectedEngagementId;

        return (
          <g
            key={engagement.id}
            data-engagement={engagement.id}
            data-tick={engagement.tick}
            data-selected={selected}
            data-through-wall={engagement.throughWall === true}
            data-headshot={engagement.headshot === true}
            aria-label={describeEngagement(engagement)}
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            {...selection.itemProps(engagement.id, index)}
          >
            {/*
              A transparent hit line: the drawn axis is 1.5 units wide, which is
              an unhittable target with a pointer. The visible stroke stays the
              artboard's width and this one takes the clicks.
            */}
            <line
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="transparent"
              strokeWidth={14}
              data-role="hit-area"
            />
            <line
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              className="stroke-fail"
              strokeWidth={emphasised ? 2.5 : 1.5}
              strokeDasharray={engagement.throughWall === true ? '2 3' : '5 4'}
              data-role="axis"
            />
            <circle cx={from.x} cy={from.y} r={ATTACKER_RADIUS} className="fill-fail" data-role="attacker" />
            <path
              d={crossCommand(to, VICTIM_CROSS_SIZE)}
              className="stroke-fail"
              strokeWidth={emphasised ? 2 : 1.5}
              fill="none"
              data-role="victim"
            />
            {selected ? (
              <>
                <circle
                  cx={from.x}
                  cy={from.y}
                  r={SELECTION_RING_RADIUS}
                  fill="none"
                  className="stroke-accent-800"
                  strokeWidth={1.5}
                  data-role="selection-ring"
                />
                <circle
                  cx={to.x}
                  cy={to.y}
                  r={SELECTION_RING_RADIUS}
                  fill="none"
                  className="stroke-accent-800"
                  strokeWidth={1.5}
                  data-role="selection-ring"
                />
              </>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}
