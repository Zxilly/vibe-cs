import { currentLocale, msg, msgf } from '../../shared/i18n';
import { Camera, Merge, UserRound } from 'lucide-react';

import type { DirectorPlan } from '../../shared/api/dto';
import { Badge, Card, Notice } from '../../shared/ui';
import './recordingDirector.css';

export function DirectorPlanPreview({ plan }: { plan: DirectorPlan }) {
  return (
    <Card className="recording-director-preview" aria-live="polite">
      <header>
        <div><span className="eyebrow">DIRECTOR PREVIEW</span><strong>{msg("m1119")}</strong><small>{msg("m1024")}</small></div>
        <div><Badge tone="blue"><Camera size={12} />{plan.shots.length} {msg("m1273")}</Badge><Badge tone="neutral"><Merge size={12} />{plan.merged_item_count} {msg("m0840")}</Badge><Badge tone="warning"><UserRound size={12} />{plan.victim_reaction_count} {msg("m0154")}</Badge></div>
      </header>
      {plan.warnings.map((warning) => <Notice key={warning} tone="warning">{warning}</Notice>)}
      {plan.shots.length === 0 ? <Notice tone="warning">{msg("m0579")}</Notice> : (
        <ol>
          {plan.shots.map((shot, index) => (
            <li key={`${shot.demo_id}-${shot.player_id}-${shot.start_tick}-${index}`}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <div><strong>{shot.kind === 'victim_reaction' ? msg("m0330") : msg("m1016")} · {shot.player_id}</strong><small>tick {shot.start_tick.toLocaleString(currentLocale())}—{shot.end_tick.toLocaleString(currentLocale())} · {shot.explanation}</small><small>{shot.evidence.join(' · ')}</small></div>
              <Badge tone={shot.kind === 'victim_reaction' ? 'warning' : 'blue'}>{shot.score > 0 ? msgf("m1117", [shot.score.toFixed(2)]) : msg("m0993")}</Badge>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
