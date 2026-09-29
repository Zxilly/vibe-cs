import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { useMapGeometry } from '../../data/mapGeometry';
import type { MapGeometry } from '../../data/mapGeometryBinary';
import { Button, Checkbox, NativeSelect, cn } from '../../design/primitives';
import type { CameraPoseDiagnostic, CameraSample, ReplayFrameRecord } from '../../shared/desktop/dto';
import { frameIndexAtTick } from '../map/replayModel';
import type { Scene3DRenderer } from './Scene3DRenderer';
import type { Scene3DMode, Scene3DState } from './types';

export function Scene3DView({ mapName, frames, tick, tickRate, selectedPlayerId, onSelectPlayer,
  cameraSamples = null, cameraAspectRatio = null, cameraDiagnostics = null, showPlayers = true, showUtilities = true, className, initialMode = 'free', readTick = null,
  onFramePresented, showControls = true, presented = true, active = true, frameStyle,
}: {
  readonly mapName: string | null;
  readonly frames: readonly ReplayFrameRecord[];
  readonly tick: number;
  readonly readTick?: (() => number) | null;
  readonly tickRate: number;
  readonly selectedPlayerId: string | null;
  readonly onSelectPlayer?: (playerId: string) => void;
  readonly cameraSamples?: readonly CameraSample[] | null;
  readonly cameraAspectRatio?: number | null;
  readonly cameraDiagnostics?: readonly CameraPoseDiagnostic[] | null;
  readonly showPlayers?: boolean;
  readonly showUtilities?: boolean;
  readonly className?: string;
  readonly initialMode?: Scene3DMode;
  readonly onFramePresented?: (tick: number) => void;
  readonly showControls?: boolean;
  readonly presented?: boolean;
  readonly active?: boolean;
  readonly frameStyle?: CSSProperties | undefined;
}) {
  const geometry = useMapGeometry(mapName);
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<Scene3DRenderer | null>(null);
  const [mode, setMode] = useState<Scene3DMode>(initialMode);
  const [cutaway, setCutaway] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const inputs = useRef<Scene3DState>({ frames, tick, readTick, tickRate, selectedPlayerId, mode, cameraSamples, cameraAspectRatio, cameraDiagnostics, showPlayers, showUtilities, cutaway });
  const map = useRef<MapGeometry | null>(geometry.isError ? null : geometry.data ?? null);
  const select = useRef(onSelectPlayer);
  const presentedCallback = useRef(onFramePresented);
  const geometryPending = useRef(mapName !== null && geometry.isPending);
  const held = useRef(!active && presented);

  useLayoutEffect(() => {
    held.current = !active && presented;
    controller.current?.setPresentationHeld(held.current);
  }, [active, presented]);

  useLayoutEffect(() => {
    select.current = onSelectPlayer;
    presentedCallback.current = onFramePresented;
    geometryPending.current = mapName !== null && geometry.isPending;
    inputs.current = { frames, tick, readTick, tickRate, selectedPlayerId, mode, cameraSamples, cameraAspectRatio, cameraDiagnostics, showPlayers, showUtilities, cutaway };
    controller.current?.setState(inputs.current);
  }, [frames, tick, readTick, tickRate, selectedPlayerId, mode, cameraSamples, cameraAspectRatio, cameraDiagnostics, showPlayers, showUtilities, cutaway, onSelectPlayer, onFramePresented, mapName, geometry.isPending]);
  useLayoutEffect(() => {
    map.current = geometry.isError ? null : geometry.data ?? null;
    controller.current?.setGeometry(map.current);
  }, [geometry.data, geometry.isError]);

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return undefined;
    let disposed = false;
    let instance: Scene3DRenderer | null = null;
    setRendererReady(false);
    setRendererError(null);
    // This is the only value import of the renderer/Three graph in the UI.
    void import('./Scene3DRenderer').then(({ Scene3DRenderer: Renderer }) => {
      if (disposed) return;
      instance = new Renderer(element, (playerId) => select.current?.(playerId), () => {
        if (!disposed) setRendererError(t`3D 渲染已中断，请重新加载视图。`);
      }, (presentedTick) => {
        if (!disposed && !geometryPending.current) presentedCallback.current?.(presentedTick);
      });
      instance.setState(inputs.current);
      instance.setGeometry(map.current);
      instance.setPresentationHeld(held.current);
      controller.current = instance;
      setRendererReady(true);
    }).catch(() => {
      instance?.dispose();
      if (controller.current === instance) controller.current = null;
      instance = null;
      if (!disposed) setRendererError(t`无法启动 3D 渲染。请检查显卡驱动或重新加载视图。`);
    });
    return () => {
      disposed = true;
      instance?.dispose();
      if (controller.current === instance) controller.current = null;
    };
  }, [attempt]);

  const hasTarget = frames[frameIndexAtTick(frames, tick)]?.players.some((player) => player.id === selectedPlayerId) === true;
  const hasCamera = cameraSamples !== null && cameraSamples.length > 0;
  return (
    <section className={cn('flex min-h-0 min-w-0 flex-col text-on-media', presented ? 'bg-media' : 'bg-transparent', className)} aria-label={t`3D 回放`} aria-hidden={!presented && !active}>
      {showControls && <div className="flex flex-wrap items-center gap-2 border-b border-media-divider bg-surface-chrome px-3 py-2 text-text">
        <h3 className="mr-auto text-xs font-semibold"><Trans>3D 视图</Trans></h3>
        <NativeSelect size="sm" className="w-auto min-w-0 flex-1" aria-label={t`3D 视角`} value={mode} onChange={(event) => setMode(event.currentTarget.value as Scene3DMode)}>
          <option value="free"><Trans>自由视角</Trans></option>
          <option value="follow" disabled={!hasTarget}><Trans>跟随选手</Trans></option>
          <option value="camera" disabled={!hasTarget && !hasCamera}>{hasCamera ? t`机位视角` : t`第一人称视角`}</option>
        </NativeSelect>
        {mode !== 'camera' && <Button size="sm" variant="ghost" disabled={!rendererReady} onClick={() => controller.current?.resetView()}><Trans>复位视角</Trans></Button>}
      </div>}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <canvas key={attempt} ref={canvas} className={cn('absolute inset-0 size-full touch-none object-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent', !presented && 'pointer-events-none opacity-0')}
          style={{ ...frameStyle, ...(!presented ? { opacity: 0 } : {}) }}
          aria-hidden={!presented} tabIndex={mode === 'camera' || !presented ? -1 : 0} role={mode === 'camera' ? 'img' : 'application'}
          aria-label={mode === 'camera' ? hasCamera ? t`机位视角` : t`第一人称视角` : t`3D 地图：拖动旋转，右键平移，滚轮缩放；方向键可平移。`} data-scene3d-canvas />
        {active && (rendererError !== null ? (
          <div className="absolute inset-x-3 top-1/2 flex -translate-y-1/2 flex-col items-center justify-center gap-3 rounded bg-media/90 p-4 text-center text-sm">
            <p role="alert">{rendererError}</p>
            <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}><Trans>重新加载 3D</Trans></Button>
          </div>
        ) : !rendererReady ? <p role="status" className="absolute inset-0 grid place-items-center text-sm"><Trans>正在启动 3D 视图…</Trans></p> : null)}
        {active && rendererReady && mode === 'camera' && !hasTarget && !hasCamera && <p role="status" className="absolute inset-x-3 top-1/2 -translate-y-1/2 rounded bg-media/90 p-4 text-center text-sm"><Trans>当前时刻缺少选手位置，无法预演第一人称画面。</Trans></p>}
        {presented && !showControls && rendererReady && (geometry.isError || (mapName === null)) && <p className="absolute bottom-2 left-2 right-2 rounded bg-surface-chrome px-2 py-1 text-xs text-text"><Trans>地图几何不可用，当前仅显示选手与机位。</Trans></p>}
      </div>
      {showControls && <div className="flex flex-col gap-1 border-t border-media-divider px-3 py-2 text-xs leading-5 text-on-media-muted">
        {frames.length === 0 && <p role="status"><Trans>没有可用的选手位置数据。</Trans></p>}
        {mode !== 'camera' && (
          <Checkbox size="sm" checked={cutaway} disabled={!hasTarget} onChange={setCutaway}><Trans>隐藏选手头顶上方的地图几何</Trans></Checkbox>
        )}
        {geometry.isFetching && mapName !== null ? <p role="status"><Trans>正在准备本机地图几何…</Trans></p> : geometry.data === undefined || geometry.isError ? (
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1"><Trans>地图几何不可用，当前仅显示选手与机位。</Trans></p>
            {mapName !== null && <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => void geometry.refetch()}><Trans>重试</Trans></button>}
          </div>
        ) : null}
        {geometry.isError && <details><summary className="cursor-pointer"><Trans>查看原因</Trans></summary><p className="break-words">{dataErrorMessage(geometry.error)}</p></details>}
        <p><Trans>胶囊体与道具范围为示意；成片画面仍由 CS2 录制。</Trans></p>
        {hasCamera && mode !== 'camera' && <p><Trans>视锥表示当前机位朝向；红色路径表示采样发现的镜头问题。</Trans></p>}
      </div>}
    </section>
  );
}
