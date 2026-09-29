import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Object3D, PerspectiveCamera, Scene } from 'three';

import type { CameraSample, ReplayFrameRecord } from '../../shared/desktop/dto';
import { Scene3DRenderer } from './Scene3DRenderer';
import type { Scene3DState } from './types';

// Keep the real scene graph, camera projection and OrbitControls. Only the GPU
// boundary is replaced; the browser acceptance separately exercises WebGL.
const gpu = vi.hoisted(() => ({ render: vi.fn(), viewport: vi.fn(), dispose: vi.fn(), lose: vi.fn() }));
vi.mock('three', async (original) => ({
  ...await original<typeof import('three')>(),
  WebGLRenderer: class {
    setPixelRatio() {}
    setSize() {}
    setViewport = gpu.viewport;
    setScissor() {}
    setScissorTest() {}
    setClearColor() {}
    clear() {}
    render = gpu.render;
    dispose = gpu.dispose;
    forceContextLoss = gpu.lose;
  },
}));

const frames: ReplayFrameRecord[] = [{ tick: 100, players: [{
  id: 'target', name: 'Target', team: 'A', position: [0, 0, 0], yaw: 0, pitch: 0,
  health: 100, armor: 100, alive: true, weapon: '', input: null,
}], projectiles: [], bomb: null }];
const pose: CameraSample = { tick: 100, timeSeconds: 0, position: { x: -32, y: 0, z: 64 }, quaternion: [0, 0, 0, 1], fov: 90 };
const state: Scene3DState = { frames, tick: 100, readTick: null, tickRate: 64, selectedPlayerId: 'target',
  mode: 'camera', cameraSamples: [pose], cameraAspectRatio: 16 / 9, cameraDiagnostics: null,
  showPlayers: true, showUtilities: true, cutaway: false };
const controllers: Scene3DRenderer[] = [];
const callbacks = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

beforeEach(() => {
  vi.clearAllMocks();
  callbacks.clear();
  nextFrame = 0;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: (entries: unknown[]) => void) {}
    observe() { this.callback([{ contentRect: { width: 800, height: 600 } }]); }
    disconnect() {}
  });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: unknown[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
});
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function create(presented = vi.fn()) {
  const canvas = document.createElement('canvas');
  for (const name of ['media', 'on-media', 'neutral-600', 'accent', 'team-b', 'neutral-400', 'warn', 'accent-400', 'fail-text']) {
    canvas.style.setProperty(`--color-${name}`, '#808080');
  }
  document.body.append(canvas);
  const controller = new Scene3DRenderer(canvas, vi.fn(), vi.fn(), presented);
  controllers.push(controller);
  controller.setState(state);
  return controller;
}

function frame() {
  const [id, callback] = callbacks.entries().next().value!;
  callbacks.delete(id);
  callback(id * 16);
}

it('hides the observed player when a generated view becomes POV at the same paused tick', () => {
  const controller = create();
  frame();
  const scene = gpu.render.mock.lastCall![0] as Scene;
  let body: Object3D | undefined;
  scene.traverse((object) => { if (object.userData['playerId'] === 'target') body = object; });
  expect(body?.parent?.visible).toBe(true);
  controller.setState({ ...state, cameraSamples: null });
  frame();
  expect(body?.parent?.visible).toBe(false);
});

it('changes the real projection and restores a full viewport outside camera mode', () => {
  const controller = create();
  frame();
  const camera = gpu.render.mock.lastCall![1] as PerspectiveCamera;
  expect(camera.aspect).toBeCloseTo(16 / 9);
  expect(gpu.viewport).toHaveBeenLastCalledWith(0, 75, 800, 450);
  controller.setState({ ...state, mode: 'free' });
  frame();
  expect(camera.aspect).toBeCloseTo(4 / 3);
  expect(gpu.viewport).toHaveBeenLastCalledWith(0, 0, 800, 600);
});

it('coalesces owner time changes before drawing and reports readiness only after submission', () => {
  let tick = 100;
  const presented = vi.fn();
  const controller = create(presented);
  controller.setState({ ...state, readTick: () => tick });
  tick = 110;
  tick = 120;
  expect(presented).not.toHaveBeenCalled();
  frame();
  expect(presented).toHaveBeenCalledExactlyOnceWith(120);
  expect(gpu.render).toHaveBeenCalledTimes(1);
  frame();
  expect(gpu.render).toHaveBeenCalledTimes(1);
});
