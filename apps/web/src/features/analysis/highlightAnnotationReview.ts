import type {
  EvidenceAnnotation,
  EvidenceAnnotationQuery,
  EvidenceSearchItem,
  Paginated,
} from '../../shared/desktop/dto';
import type { AnalysisWorkspace, Highlight } from '../../shared/desktop/viewModels';

export type HighlightAnnotationSummary = {
  total: number;
  open: number;
  resolved: number;
};

export function createHighlightAnnotationReviewState() {
  let selectedEvidenceId: string | null = null;
  let generation = 0;
  return {
    select(evidenceId: string | null): boolean {
      const changed = evidenceId !== selectedEvidenceId;
      if (changed) {
        selectedEvidenceId = evidenceId;
        generation += 1;
      }
      return changed;
    },
    async acceptCurrent<T>(evidenceId: string, request: Promise<T>): Promise<T | null> {
      if (evidenceId !== selectedEvidenceId) {
        selectedEvidenceId = evidenceId;
        generation += 1;
      }
      const requestGeneration = generation;
      try {
        const result = await request;
        return requestGeneration === generation && evidenceId === selectedEvidenceId
          ? result
          : null;
      } catch (cause) {
        if (requestGeneration !== generation || evidenceId !== selectedEvidenceId) return null;
        throw cause;
      }
    },
  };
}

export type HighlightAnnotationReviewClient = {
  listEvidenceAnnotations(
    query: EvidenceAnnotationQuery,
    signal?: AbortSignal,
  ): Promise<Paginated<EvidenceAnnotation>>;
};

export async function loadHighlightAnnotationReviews(
  client: HighlightAnnotationReviewClient,
  demoId: string,
  signal?: AbortSignal,
  pageSize = 100,
): Promise<EvidenceAnnotation[]> {
  const items: EvidenceAnnotation[] = [];
  let page = 1;
  while (true) {
    const response = await client.listEvidenceAnnotations({
      demo_id: demoId,
      page,
      page_size: pageSize,
    }, signal);
    items.push(...response.items);
    if (items.length >= response.total || response.items.length === 0) return items;
    page += 1;
  }
}

const maximumEvidenceRound = 256;
const canonicalUuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameHighlight(left: Highlight, right: Highlight): boolean {
  return left.id === right.id
    && left.label === right.label
    && left.category === right.category
    && left.kind === right.kind
    && left.description === right.description
    && sameStrings(left.tags, right.tags)
    && sameStrings(left.victims, right.victims)
    && left.player_id === right.player_id
    && left.round === right.round
    && left.start_tick === right.start_tick
    && left.end_tick === right.end_tick
    && left.confidence === right.confidence;
}

function hasPersistableLocator(workspace: AnalysisWorkspace, highlight: Highlight): boolean {
  return canonicalUuid.test(workspace.demo_id)
    && /^[A-Za-z0-9_.:-]{1,256}$/u.test(highlight.id)
    && Number.isInteger(highlight.round)
    && highlight.round >= 1
    && highlight.round <= maximumEvidenceRound
    && Number.isSafeInteger(highlight.start_tick)
    && highlight.start_tick >= 0
    && Number.isSafeInteger(highlight.end_tick)
    && highlight.end_tick >= highlight.start_tick;
}

function analysisHref(
  workspace: AnalysisWorkspace,
  highlight: Highlight,
  tab: 'highlights' | 'replay',
  evidenceId: string,
): string {
  return `/analysis?${new URLSearchParams({
    demo: workspace.demo_id,
    tab,
    round: String(highlight.round),
    player: highlight.player_id,
    tick: String(highlight.start_tick),
    evidence: evidenceId,
  }).toString()}`;
}

export function canonicalHighlightAnnotationItem(
  workspace: AnalysisWorkspace,
  highlight: Highlight,
): EvidenceSearchItem | null {
  const canonical = workspace.highlights.find((candidate) => candidate.id === highlight.id) ?? null;
  if (!canonical || !sameHighlight(canonical, highlight) || !hasPersistableLocator(workspace, canonical)) {
    return null;
  }
  const evidenceId = `demo:${workspace.demo_id}/highlight:${highlight.id}`;
  const actorName = workspace.players.find((player) => player.id === highlight.player_id)?.name ?? null;
  const victimNames = highlight.victims.map(
    (victimId) => workspace.players.find((player) => player.id === victimId)?.name ?? null,
  );

  return {
    evidence_id: evidenceId,
    demo_id: workspace.demo_id,
    demo_display_name: workspace.demo_id,
    map_name: workspace.map_name,
    match_date: null,
    round: highlight.round,
    tick: highlight.start_tick,
    end_tick: highlight.end_tick,
    event_type: highlight.kind,
    actor_id: highlight.player_id,
    actor_name: actorName,
    target_id: null,
    target_name: null,
    weapon: null,
    headshot: null,
    penetrated: null,
    source_kind: 'highlight',
    source_id: highlight.id,
    attributes: {
      title: highlight.label,
      description: highlight.description,
      score: highlight.confidence,
      tags: highlight.tags,
      victim_ids: highlight.victims,
      victim_names: victimNames,
    },
    analysis_href: analysisHref(workspace, highlight, 'highlights', evidenceId),
    replay_href: analysisHref(workspace, highlight, 'replay', evidenceId),
  };
}

export function highlightAnnotationSummary(
  item: EvidenceSearchItem,
  annotations: EvidenceAnnotation[],
): HighlightAnnotationSummary {
  const seen = new Set<string>();
  let open = 0;
  let resolved = 0;
  for (const annotation of annotations) {
    if (seen.has(annotation.id)
      || annotation.demo_id !== item.demo_id
      || annotation.evidence_id !== item.evidence_id
      || annotation.round !== item.round
      || annotation.tick !== item.tick) continue;
    seen.add(annotation.id);
    if (annotation.review_state === 'open') open += 1;
    else resolved += 1;
  }
  return { total: open + resolved, open, resolved };
}
