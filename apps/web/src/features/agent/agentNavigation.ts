import type { AgentToolCall } from '../../shared/desktop/dto';

export type AgentWorkspaceDestination =
  | 'review'
  | 'players'
  | 'evidence'
  | 'replay'
  | 'heatmap'
  | 'edit'
  | 'queue'
  | 'studio'
  | 'outputs';

export type AgentNavigationContext = {
  demoId: string | null;
  projectId: string | null;
};

export type AgentRouteContext = AgentNavigationContext & {
  workflow: 'review' | 'edit' | 'neutral';
  destination: AgentWorkspaceDestination | 'neutral';
  playerId: string | null;
  roundNumber: number | null;
  tick: number | null;
};

const destinations = new Set<AgentWorkspaceDestination>([
  'review', 'players', 'evidence', 'replay', 'heatmap',
  'edit', 'queue', 'studio', 'outputs',
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const steamIdPattern = /^\d{17}$/u;

function exactParameter(parameters: URLSearchParams, key: string): string | null {
  const values = parameters.getAll(key);
  return values.length === 1 ? values[0] ?? null : null;
}

function boundedInteger(value: string | null, minimum: number, maximum: number): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

function destination(value: unknown): value is AgentWorkspaceDestination {
  return typeof value === 'string' && destinations.has(value as AgentWorkspaceDestination);
}

export function deriveAgentRouteContext(pathname: string, search: string): AgentRouteContext {
  const reviewPaths = new Set(['/library', '/players', '/lineups', '/evidence-search', '/match-history', '/analysis']);
  const editPaths = new Set(['/production', '/queue', '/studio', '/montage', '/studio/editor', '/outputs']);
  const parameters = new URLSearchParams(search);
  const demo = exactParameter(parameters, 'demo');
  const project = exactParameter(parameters, 'project');
  const player = exactParameter(parameters, 'player');
  const tab = exactParameter(parameters, 'tab');
  const destination: AgentRouteContext['destination'] = pathname === '/players'
    ? 'players'
    : pathname === '/evidence-search'
      ? 'evidence'
      : pathname === '/analysis' && (tab === 'replay' || tab === 'heatmap')
        ? tab
        : pathname === '/analysis' || pathname === '/library' || pathname === '/lineups' || pathname === '/match-history'
          ? 'review'
          : pathname === '/queue'
            ? 'queue'
            : pathname === '/studio' || pathname === '/studio/editor' || pathname === '/montage'
              ? 'studio'
              : pathname === '/outputs'
                ? 'outputs'
                : pathname === '/production'
                  ? 'edit'
                  : 'neutral';
  return {
    workflow: reviewPaths.has(pathname) ? 'review' : editPaths.has(pathname) ? 'edit' : 'neutral',
    destination,
    demoId: demo && uuidPattern.test(demo) ? demo : null,
    projectId: project && uuidPattern.test(project) ? project : null,
    playerId: player && steamIdPattern.test(player) ? player : null,
    roundNumber: boundedInteger(exactParameter(parameters, 'round'), 1, 10_000),
    tick: boundedInteger(exactParameter(parameters, 'tick'), 0, 2_147_483_647),
  };
}

export function resolveAgentNavigation(
  toolCall: AgentToolCall,
  context: AgentNavigationContext,
): string | null {
  if (
    toolCall.name !== 'navigate_workspace'
    || !exactRecord(toolCall.input, ['destination'])
    || !destination(toolCall.input.destination)
    || !exactRecord(toolCall.output, ['accepted', 'destination', 'reason'])
    || toolCall.output.accepted !== true
    || toolCall.output.destination !== toolCall.input.destination
    || !destination(toolCall.output.destination)
    || toolCall.output.reason !== null
  ) return null;

  const target = toolCall.output.destination;
  if (target === 'review') return '/library';
  if (target === 'players') return '/players';
  if (target === 'evidence') return '/evidence-search';
  if (target === 'edit') return '/production';
  if (target === 'queue') return '/queue';
  if (target === 'outputs') return '/outputs';
  if (target === 'studio') {
    return context.projectId && uuidPattern.test(context.projectId)
      ? `/studio/editor?project=${encodeURIComponent(context.projectId)}`
      : '/studio';
  }
  if (!context.demoId || !uuidPattern.test(context.demoId)) return null;
  return `/analysis?demo=${encodeURIComponent(context.demoId)}&tab=${target}`;
}
