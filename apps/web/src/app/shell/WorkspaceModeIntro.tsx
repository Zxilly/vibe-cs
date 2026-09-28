/*
 * App shell — the first-run mode choice, drawn inside the workbench.
 *
 * It never blocks: the workbench stays usable underneath, the cards disappear
 * once a mode is chosen or the intro is dismissed, and both count as the
 * one-time orientation `shellStore.onboardingComplete` records.
 */

import { Trans } from '@lingui/react/macro';
import { ChartNoAxesCombined, Clapperboard, type LucideIcon } from 'lucide-react';
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
    body: <Trans>挑选精彩片段，编排时间轴，录制并导出成片。</Trans>,
    action: <Trans>开始剪辑</Trans>,
  },
  {
    mode: 'analysis',
    icon: ChartNoAxesCombined,
    title: <Trans>分析</Trans>,
    body: <Trans>查看比赛数据、回合事件与战术回放。</Trans>,
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
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-lg font-medium"><Trans>选择工作模式</Trans></h2>
          <p className="text-sm text-neutral-600">
            <Trans>两种模式使用同一份 Demo 资料库，之后可以随时从左上角切换。</Trans>
          </p>
        </div>
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
              className="flex flex-col items-start gap-2 rounded-lg border border-divider bg-bg p-4"
            >
              <Icon size={20} strokeWidth={1.5} aria-hidden="true" className="text-accent-700" />
              <h3 className="text-base font-medium">{card.title}</h3>
              <p className="text-sm leading-relaxed text-neutral-700">{card.body}</p>
              <Button variant="secondary" size="sm" className="mt-1" onClick={() => choose(card.mode)}>
                {card.action}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
