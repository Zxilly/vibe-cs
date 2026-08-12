// PROTOTYPE — Three ACE overlay directions, switchable with ?variant=A|B|C.
import { invoke } from '@tauri-apps/api/core';
import { ChevronLeft, ChevronRight, MonitorUp, Pause, Play, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { isDesktopShell } from '../../shared/desktop/dialog';
import './aceOverlayPrototype.css';

type Variant = 'A' | 'B' | 'C';

type KillEvent = {
  tick: number;
  victim: string;
  weapon: string;
  headshot?: boolean;
};

const variants: { key: Variant; name: string }[] = [
  { key: 'A', name: 'Broadcast crest' },
  { key: 'B', name: 'Kill ladder' },
  { key: 'C', name: 'Cinematic lower third' },
];

const startTick = 98_240;
const endTick = 99_390;
const tickRate = 64;
const player = 'm0NESY';
const killEvents: KillEvent[] = [
  { tick: 98_390, victim: 'flameZ', weapon: 'AK-47', headshot: true },
  { tick: 98_552, victim: 'apEX', weapon: 'AK-47' },
  { tick: 98_708, victim: 'mezii', weapon: 'AK-47', headshot: true },
  { tick: 98_872, victim: 'ZywOo', weapon: 'AWP' },
  { tick: 99_044, victim: 'ropz', weapon: 'AK-47', headshot: true },
];
const aceTick = killEvents.at(-1)?.tick ?? endTick;
const aceEndTick = aceTick + tickRate * 3;

function clampTick(value: number) {
  return Math.min(endTick, Math.max(startTick, Math.round(value)));
}

function useReplayClock() {
  const [tick, setTick] = useState(startTick);
  const [playing, setPlaying] = useState(true);
  const frameRef = useRef<number | null>(null);
  const previousRef = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) return undefined;
    const advance = (time: number) => {
      const previous = previousRef.current ?? time;
      previousRef.current = time;
      setTick((current) => {
        const next = current + ((time - previous) / 1_000) * tickRate;
        if (next >= endTick) {
          previousRef.current = time;
          return startTick;
        }
        return clampTick(next);
      });
      frameRef.current = requestAnimationFrame(advance);
    };
    frameRef.current = requestAnimationFrame(advance);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      previousRef.current = null;
    };
  }, [playing]);

  const replay = () => {
    previousRef.current = null;
    setTick(startTick);
    setPlaying(true);
  };

  return { tick, playing, setTick, setPlaying, replay };
}

function GamePlate({ tick, kills }: { tick: number; kills: KillEvent[] }) {
  const roundSeconds = Math.max(0, 42 - (tick - startTick) / tickRate);
  return (
    <div className="ace-game" aria-hidden="true">
      <div className="ace-game__sky" />
      <div className="ace-game__architecture ace-game__architecture--left" />
      <div className="ace-game__architecture ace-game__architecture--right" />
      <div className="ace-game__crosshair"><i /><i /></div>
      <div className="ace-game__score">
        <span>G2 <strong>12</strong></span><b>{roundSeconds.toFixed(1)}</b><span><strong>9</strong> VIT</span>
      </div>
      <div className="ace-game__feed">
        {kills.slice(-3).reverse().map((kill) => (
          <div key={kill.tick}><strong>{player}</strong><span>{kill.weapon}</span><em>{kill.headshot ? '◉ ' : ''}{kill.victim}</em></div>
        ))}
      </div>
      <div className="ace-game__player"><b>100</b><span>+</span><strong>{player}</strong><em>30 / 90</em></div>
    </div>
  );
}

function VariantA({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="ace-fx ace-fx--crest" role="status" aria-label={`${player} ACE`}>
      <div className="ace-crest__rays" />
      <div className="ace-crest__diamond"><span>5</span></div>
      <p>ROUND DOMINATION</p>
      <h1>ACE</h1>
      <strong>{player}</strong>
      <div className="ace-crest__rule"><i /><span>G2 ESPORTS</span><i /></div>
    </div>
  );
}

function VariantB({ kills, active }: { kills: KillEvent[]; active: boolean }) {
  return (
    <div className={`ace-fx ace-fx--ladder${active ? ' is-ace' : ''}`}>
      <header><span>ROUND 22</span><strong>{active ? 'SQUAD WIPE' : 'MULTI KILL'}</strong></header>
      <ol>
        {killEvents.map((kill, index) => {
          const complete = kills.some((candidate) => candidate.tick === kill.tick);
          return <li className={complete ? 'is-complete' : ''} key={kill.tick}><i>{index + 1}</i><span>{complete ? kill.victim : '—'}</span><b>{complete ? 'ELIMINATED' : 'PENDING'}</b></li>;
        })}
      </ol>
      <footer><span>{player}</span><strong>{active ? 'ACE' : `${kills.length} / 5`}</strong></footer>
    </div>
  );
}

function VariantC({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="ace-fx ace-fx--cinematic" role="status" aria-label={`${player} ACE`}>
      <div className="ace-cinematic__number">05</div>
      <div className="ace-cinematic__copy"><span>ALL FIVE ELIMINATED</span><h1>{player}</h1><p>CLUTCHES THE ROUND · G2 ESPORTS</p></div>
      <div className="ace-cinematic__word">ACE</div>
      <div className="ace-cinematic__pips">{killEvents.map((kill) => <i key={kill.tick} />)}</div>
    </div>
  );
}

function PrototypeSwitcher({ current, onChange }: { current: Variant; onChange: (variant: Variant) => void }) {
  const currentIndex = variants.findIndex((variant) => variant.key === current);
  const cycle = (direction: -1 | 1) => {
    const next = (currentIndex + direction + variants.length) % variants.length;
    onChange((variants[next] ?? variants[0]!).key);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') cycle(-1);
      if (event.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (!import.meta.env.DEV) return null;
  const selection = variants[currentIndex] ?? variants[0]!;
  return (
    <nav className="prototype-switcher" aria-label="ACE overlay prototype variants">
      <button type="button" onClick={() => cycle(-1)} aria-label="Previous variant"><ChevronLeft size={18} /></button>
      <span><b>{selection.key}</b>{selection.name}</span>
      <button type="button" onClick={() => cycle(1)} aria-label="Next variant"><ChevronRight size={18} /></button>
    </nav>
  );
}

export function AceOverlayPrototypePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('variant')?.toUpperCase();
  const variant: Variant = requested === 'B' || requested === 'C' ? requested : 'A';
  const overlayMode = searchParams.get('mode') === 'overlay';
  const { tick, playing, setTick, setPlaying, replay } = useReplayClock();
  const kills = useMemo(() => killEvents.filter((kill) => kill.tick <= tick), [tick]);
  const aceActive = tick >= aceTick && tick <= aceEndTick;
  const lastKill = kills.at(-1);

  const changeVariant = (next: Variant) => {
    const params = new URLSearchParams(searchParams);
    params.set('variant', next);
    setSearchParams(params, { replace: true });
  };

  useEffect(() => {
    if (!overlayMode) return undefined;
    document.documentElement.dataset.aceOverlay = 'true';
    return () => { delete document.documentElement.dataset.aceOverlay; };
  }, [overlayMode]);

  const toggleDesktopOverlay = async () => {
    await invoke<boolean>('toggle_ace_overlay_prototype', { variant });
  };

  return (
    <main className={`ace-prototype ace-prototype--${variant.toLowerCase()}${overlayMode ? ' is-window-overlay' : ''}`}>
      <GamePlate tick={tick} kills={kills} />
      {variant === 'A' ? <VariantA active={aceActive} /> : null}
      {variant === 'B' ? <VariantB active={aceActive} kills={kills} /> : null}
      {variant === 'C' ? <VariantC active={aceActive} /> : null}

      <aside className="ace-state">
        <span>PROTOTYPE · DEMO TICK SYNC</span>
        <code>{JSON.stringify({ tick, round: 22, player, kills: kills.length, lastVictim: lastKill?.victim ?? null, aceActive })}</code>
      </aside>

      <section className="ace-transport" aria-label="Replay controls">
        <button type="button" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
        <input type="range" min={startTick} max={endTick} value={tick} onChange={(event) => { setPlaying(false); setTick(clampTick(Number(event.target.value))); }} aria-label="Demo tick" />
        <output>tick {tick}</output>
        <button type="button" onClick={replay} aria-label="Replay ACE"><RotateCcw size={16} /></button>
        {isDesktopShell() && import.meta.env.DEV ? <button className="ace-transport__window" type="button" onClick={() => void toggleDesktopOverlay()} aria-label="Toggle transparent desktop overlay"><MonitorUp size={16} /></button> : null}
      </section>

      <PrototypeSwitcher current={variant} onChange={changeVariant} />
    </main>
  );
}
