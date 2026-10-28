/*
 * App shell — the first-run mode choice, drawn inside the workbench.
 *
 * It never blocks: the workbench stays usable underneath, the cards disappear
 * once a mode is chosen or the intro is dismissed, and both count as the
 * one-time orientation `shellStore.onboardingComplete` records.
 */

import { Trans } from '@lingui/react/macro';
import { ArrowRight, ChartNoAxesCombined, Clapperboard, type LucideIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '../../design/primitives';
import { MODE_LANDING_PATH, type WorkspaceMode } from './navigation';
import { useShellStore } from './shellStore';

interface ModeCard {
  readonly mode: WorkspaceMode;
  readonly icon: LucideIcon;
  readonly title: ReactNode;
  readonly body: ReactNode;
  readonly action: ReactNode;
}

const MODE_CARDS: readonly ModeCard[] = [
  {
    mode: 'edit',
    icon: Clapperboard,
    title: <Trans>剪辑</Trans>,
    body: <Trans>选材、剪辑与导出</Trans>,
    action: <Trans>开始剪辑</Trans>,
  },
  {
    mode: 'analysis',
    icon: ChartNoAxesCombined,
    title: <Trans>分析</Trans>,
    body: <Trans>比赛数据与战术回放</Trans>,
    action: <Trans>进入分析</Trans>,
  },
];

export function WorkspaceModeIntro() {
  const navigate = useNavigate();
  const headingId = useId();
  const onboardingComplete = useShellStore((state) => state.onboardingComplete);
  const completeOnboarding = useShellStore((state) => state.completeOnboarding);
  const setMode = useShellStore((state) => state.setMode);

  if (onboardingComplete) return null;

  const choose = (mode: WorkspaceMode) => {
    completeOnboarding();
    setMode(mode);
    void navigate(MODE_LANDING_PATH[mode]);
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3" data-home-block="modes">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="text-base font-medium"><Trans>选择工作模式</Trans></h2>
        <Button variant="ghost" size="sm" onClick={completeOnboarding}>
          <Trans>不再显示</Trans>
        </Button>
      </div>
      <ul className="grid grid-cols-2 gap-3">
        {MODE_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <li
              key={card.mode}
              data-mode-card={card.mode}
              className="relative flex min-w-0 items-center gap-3 rounded-md border border-divider bg-bg p-3 transition-colors hover:bg-action-hover focus-within:border-accent"
            >
              <Icon size={20} strokeWidth={1.5} aria-hidden="true" className="flex-none text-neutral-600" />
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-medium">{card.title}</h3>
                <p className="mt-0.5 text-base text-neutral-600">{card.body}</p>
              </div>
              <Button variant="ghost" size="sm" className="flex-none after:absolute after:inset-0 after:rounded-md" onClick={() => choose(card.mode)}>
                {card.action}<ArrowRight size={14} aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
