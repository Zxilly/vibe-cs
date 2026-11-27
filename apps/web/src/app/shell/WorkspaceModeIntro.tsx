/*
 * App shell — the first-run mode choice, drawn inside the workbench.
 *
 * It never blocks: the workbench stays usable underneath, the cards disappear
 * once a mode is chosen or the intro is dismissed, and both count as the
 * one-time orientation `shellStore.onboardingComplete` records.
 *
 * Only the mode the user is *not* in carries an action. The current card used
 * to offer 「开始剪辑」, which navigated to the page already on screen and so did
 * exactly what 「不再显示」 does — a second, louder name for dismissing that
 * outranked the one card that actually goes somewhere. The current mode is a
 * state, so it reads as one: the 当前 badge and the selected surface.
 */

import { Trans } from '@lingui/react/macro';
import { ArrowRight, ChartNoAxesCombined, Clapperboard, type LucideIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { Badge, Button, cn } from '../../design/primitives';
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
    action: <Trans>进入剪辑</Trans>,
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
  const currentMode = useShellStore((state) => state.mode);
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
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg border border-divider bg-surface-chrome/60 px-4 py-3"
      data-home-block="modes"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-medium text-neutral-700"><Trans>选择工作模式</Trans></h2>
        <Button variant="ghost" size="sm" onClick={completeOnboarding}>
          <Trans>不再显示</Trans>
        </Button>
      </div>
      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {MODE_CARDS.map((card) => {
          const Icon = card.icon;
          const active = card.mode === currentMode;
          return (
            <li
              key={card.mode}
              data-mode-card={card.mode}
              data-mode-active={active ? 'true' : undefined}
              className={cn(
                'relative flex min-w-0 items-center gap-3 rounded-md border px-3 py-2.5 transition-colors',
                active
                  ? 'border-accent bg-accent-100/70'
                  : 'border-divider bg-bg focus-within:border-accent hover:border-neutral-400 hover:bg-neutral-100',
              )}
            >
              <Icon
                size={18}
                strokeWidth={1.5}
                aria-hidden="true"
                className={cn('flex-none', active ? 'text-accent-700' : 'text-neutral-600')}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium text-text">{card.title}</h3>
                  {active ? (
                    <Badge variant="accent" size="sm">
                      <Trans>当前</Trans>
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-neutral-600">{card.body}</p>
              </div>
              {active ? null : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-none after:absolute after:inset-0 after:rounded-md"
                  onClick={() => choose(card.mode)}
                >
                  {card.action}<ArrowRight size={14} aria-hidden="true" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
