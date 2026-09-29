import type { CameraPoseDiagnostic, CameraSample, ReplayFrameRecord } from '../../shared/desktop/dto';

export type Scene3DMode = 'free' | 'follow' | 'camera';

/** The owner supplies time. Rendering may sample it, but never advance it. */
export interface Scene3DState {
  readonly frames: readonly ReplayFrameRecord[];
  readonly tick: number;
  readonly readTick: (() => number) | null;
  readonly tickRate: number;
  readonly selectedPlayerId: string | null;
  readonly mode: Scene3DMode;
  readonly cameraSamples: readonly CameraSample[] | null;
  readonly cameraAspectRatio: number | null;
  readonly cameraDiagnostics: readonly CameraPoseDiagnostic[] | null;
  readonly showPlayers: boolean;
  readonly showUtilities: boolean;
  readonly cutaway: boolean;
}
