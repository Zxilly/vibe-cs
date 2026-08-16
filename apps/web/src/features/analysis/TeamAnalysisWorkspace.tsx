import { DollarSign, ShieldCheck } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';

import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { useI18n } from '../../shared/i18n';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import { TeamEconomyAnalysisWorkspace } from './TeamEconomyAnalysisWorkspace';
import type { TeamEconomyEvidence } from './teamEconomyWorkspace';
import { TeamRoundAnalysisWorkspace } from './TeamRoundAnalysisWorkspace';
import type { TeamRoundEvidence } from './teamRoundWorkspace';
import './TeamAnalysisWorkspace.css';

type TeamAnalysisMode = 'rounds' | 'economy';

export type TeamAnalysisWorkspaceProps = {
  workspace: AnalysisWorkspace;
  serviceAvailable: boolean;
  runtimeIdle: boolean;
  watchPending: boolean;
  onNavigate: (navigation: AnalysisNavigationPatch) => void;
  onWatchRound: (evidence: TeamRoundEvidence) => void;
  onAddRound: (evidence: TeamRoundEvidence) => void;
  onWatchEconomy: (evidence: TeamEconomyEvidence) => void;
  onAddEconomy: (evidence: TeamEconomyEvidence) => void;
  addedEvidenceIds?: ReadonlySet<string>;
  focusedEvidenceId?: string | null;
};

export function TeamAnalysisWorkspace({
  workspace,
  serviceAvailable,
  runtimeIdle,
  watchPending,
  onNavigate,
  onWatchRound,
  onAddRound,
  onWatchEconomy,
  onAddEconomy,
  addedEvidenceIds,
  focusedEvidenceId = null,
}: TeamAnalysisWorkspaceProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<TeamAnalysisMode>('rounds');
  const roundTab = useRef<HTMLButtonElement>(null);
  const economyTab = useRef<HTMLButtonElement>(null);

  const selectFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    let next: TeamAnalysisMode | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'Home') next = 'rounds';
    if (event.key === 'ArrowRight' || event.key === 'End') next = 'economy';
    if (!next) return;
    event.preventDefault();
    setMode(next);
    (next === 'rounds' ? roundTab : economyTab).current?.focus();
  };

  return (
    <section
      className="team-analysis-workspace"
      data-testid="team-analysis-workspace"
      data-state-scope="local"
    >
      <header className="team-analysis-switcher">
        <div role="tablist" aria-label={t('analysis.teams.economy.modeLabel')}>
          <button
            type="button"
            id="team-analysis-tab-rounds"
            role="tab"
            aria-controls="team-analysis-panel-rounds"
            aria-selected={mode === 'rounds'}
            tabIndex={mode === 'rounds' ? 0 : -1}
            data-testid="team-analysis-tab-rounds"
            ref={roundTab}
            onClick={() => setMode('rounds')}
            onKeyDown={selectFromKeyboard}
          >
            <ShieldCheck size={13} />
            {t('analysis.teams.economy.roundControl')}
          </button>
          <button
            type="button"
            id="team-analysis-tab-economy"
            role="tab"
            aria-controls="team-analysis-panel-economy"
            aria-selected={mode === 'economy'}
            tabIndex={mode === 'economy' ? 0 : -1}
            data-testid="team-analysis-tab-economy"
            ref={economyTab}
            onClick={() => setMode('economy')}
            onKeyDown={selectFromKeyboard}
          >
            <DollarSign size={13} />
            {t('analysis.teams.economy.economyControl')}
          </button>
        </div>
        <small>{t('analysis.teams.economy.localViewHint')}</small>
      </header>

      <div
        className="team-analysis-panel"
        id={`team-analysis-panel-${mode}`}
        role="tabpanel"
        aria-labelledby={`team-analysis-tab-${mode}`}
      >
        {mode === 'rounds' ? (
          <TeamRoundAnalysisWorkspace
            workspace={workspace}
            serviceAvailable={serviceAvailable}
            runtimeIdle={runtimeIdle}
            watchPending={watchPending}
            onNavigate={onNavigate}
            onWatch={onWatchRound}
            onAddProduction={onAddRound}
            {...(addedEvidenceIds ? { addedEvidenceIds } : {})}
            focusedEvidenceId={focusedEvidenceId}
          />
        ) : (
          <TeamEconomyAnalysisWorkspace
            workspace={workspace}
            serviceAvailable={serviceAvailable}
            runtimeIdle={runtimeIdle}
            watchPending={watchPending}
            onNavigate={onNavigate}
            onWatch={onWatchEconomy}
            onAddProduction={onAddEconomy}
            {...(addedEvidenceIds ? { addedEvidenceIds } : {})}
            focusedEvidenceId={focusedEvidenceId}
          />
        )}
      </div>
    </section>
  );
}
