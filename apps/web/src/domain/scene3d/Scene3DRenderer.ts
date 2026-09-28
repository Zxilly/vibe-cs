/** Loaded only by the mounted 3D viewport. No React or independent playback clock. */
import {
  AmbientLight, Box3, BufferAttribute, BufferGeometry, CapsuleGeometry, CircleGeometry,
  Color, DirectionalLight, DoubleSide, Group, Line, LineBasicMaterial, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera, Plane, Raycaster, Scene,
  Sphere, SphereGeometry, TorusGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { MapGeometry } from '../../data/mapGeometryBinary';
import type { ReplayFrameRecord, ReplayPlayerRecord } from '../../shared/desktop/dto';
import { interpolateReplayFrame, projectileTrails } from '../map/replayModel';
import { cameraSampleAtTick, cameraView, cutawayHeight, playerDirection, sourcePoint, verticalFov } from './sceneMath';
import type { Scene3DState } from './types';

const MAX_TRAIL_POINTS = 128;
const BODY_RADIUS = 12;
const BODY_HEIGHT = 64;

interface Actor {
  readonly group: Group;
  readonly body: Mesh<CapsuleGeometry, MeshBasicMaterial>;
  readonly heading: Line<BufferGeometry, LineBasicMaterial>;
  readonly ring: Mesh<TorusGeometry, MeshBasicMaterial>;
}

interface Utility {
  readonly mesh: Mesh<SphereGeometry | CircleGeometry, MeshBasicMaterial>;
  readonly phase: string;
}

export class Scene3DRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(55, 1, 2, 50_000);
  private readonly controls: OrbitControls;
  private readonly solid = new MeshLambertMaterial({ flatShading: true, side: DoubleSide });
  private readonly bodyA = new MeshBasicMaterial();
  private readonly bodyB = new MeshBasicMaterial();
  private readonly marker = new MeshBasicMaterial();
  private readonly flying = new MeshBasicMaterial();
  private readonly smoke = new MeshBasicMaterial({ transparent: true, opacity: 0.2, depthWrite: false });
  private readonly fire = new MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false, side: DoubleSide });
  private readonly headingMaterial = new LineBasicMaterial({ transparent: true, opacity: 0.8 });
  private readonly trailMaterial = new LineBasicMaterial({ transparent: true, opacity: 0.8 });
  private readonly pathMaterial = new LineBasicMaterial();
  private readonly ambient = new AmbientLight(undefined, 1.5);
  private readonly light = new DirectionalLight(undefined, 2.2);
  private readonly capsule = new CapsuleGeometry(BODY_RADIUS, BODY_HEIGHT - BODY_RADIUS * 2, 4, 8);
  private readonly ringGeometry = new TorusGeometry(18, 1.8, 4, 24);
  private readonly sphere = new SphereGeometry(1, 16, 10);
  private readonly disc = new CircleGeometry(1, 32);
  private readonly actors = new Map<string, Actor>();
  private readonly utilities = new Map<string, Utility>();
  private readonly trails = new Map<string, Line<BufferGeometry, LineBasicMaterial>>();
  private readonly cutPlane = new Plane(new Vector3(0, -1, 0), 0);
  private readonly ray = new Raycaster();
  private readonly mouse = new Vector2();
  private readonly position = new Vector3();
  private readonly direction = new Vector3();
  private readonly following = new Vector3();
  private readonly mapBounds = new Box3();
  private readonly resizeObserver: ResizeObserver;
  private readonly visibilityObserver: IntersectionObserver;
  private readonly themeObserver: MutationObserver;
  private readonly darkMode = matchMedia('(prefers-color-scheme: dark)');
  private mapMesh: Mesh<BufferGeometry, MeshLambertMaterial> | null = null;
  private path: Line<BufferGeometry, LineBasicMaterial> | null = null;
  private state: Scene3DState | null = null;
  private frame: ReplayFrameRecord | null = null;
  private lastTick = NaN;
  private followedPlayer: string | null = null;
  private framed = false;
  private width = 0;
  private height = 0;
  private raf = 0;
  private stopped = false;
  private dirty = true;
  private visible = true;
  private pointerStart: [number, number] | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onSelect: (playerId: string) => void,
    private readonly onContextLost: () => void,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.localClippingEnabled = true;
    this.light.position.set(0.4, 1, 0.6);
    this.scene.add(this.ambient, this.light);
    this.camera.position.set(800, 1_000, 800);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 24;
    this.controls.maxDistance = 30_000;
    this.controls.listenToKeyEvents(canvas);
    this.controls.addEventListener('change', this.invalidate);
    this.resizeObserver = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      this.width = Math.max(0, Math.floor(entry.contentRect.width));
      this.height = Math.max(0, Math.floor(entry.contentRect.height));
      if (this.width === 0 || this.height === 0) return;
      this.renderer.setSize(this.width, this.height, false);
      this.dirty = true;
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
    });
    this.resizeObserver.observe(canvas);
    this.visibilityObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry?.isIntersecting === true;
      if (this.visible) this.dirty = true;
    });
    this.visibilityObserver.observe(canvas);
    this.themeObserver = new MutationObserver(() => this.theme());
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    this.darkMode.addEventListener('change', this.theme);
    this.theme();
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('webglcontextlost', this.contextLost);
    this.raf = requestAnimationFrame(this.draw);
  }

  setState(state: Scene3DState): void {
    const previous = this.state;
    this.state = state;
    if (previous?.frames !== state.frames || previous.mode !== state.mode || previous.selectedPlayerId !== state.selectedPlayerId
      || previous.cutaway !== state.cutaway || previous.showPlayers !== state.showPlayers || previous.showUtilities !== state.showUtilities
      || previous.cameraSamples !== state.cameraSamples) this.dirty = true;
    if (previous?.frames !== state.frames) this.framed = false;
    if (previous?.cameraSamples !== state.cameraSamples) {
      if (this.path !== null) { this.scene.remove(this.path); this.path.geometry.dispose(); this.path = null; }
      if (state.cameraSamples !== null && state.cameraSamples.length > 1) {
        const points = state.cameraSamples.flatMap((pose) => sourcePoint([pose.position.x, pose.position.y, pose.position.z]));
        const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
        this.path = new Line(geometry, this.pathMaterial);
        this.scene.add(this.path);
      }
    }
    if (previous?.mode !== state.mode || previous.selectedPlayerId !== state.selectedPlayerId) {
      this.lastTick = NaN;
      this.followedPlayer = null;
      if (previous?.mode === 'camera') { this.camera.up.set(0, 1, 0); this.framed = false; }
      this.camera.fov = 55;
      this.camera.updateProjectionMatrix();
    }
    if (previous?.frames !== state.frames || previous.showPlayers !== state.showPlayers || previous.showUtilities !== state.showUtilities) this.lastTick = NaN;
  }

  setGeometry(map: MapGeometry | null): void {
    this.dirty = true;
    this.lastTick = NaN;
    if (this.mapMesh !== null) { this.scene.remove(this.mapMesh); this.mapMesh.geometry.dispose(); this.mapMesh = null; }
    this.mapBounds.makeEmpty();
    if (map === null) return;
    // Reuse the decoder's arrays. Flat shading derives face normals in the
    // fragment shader, so the multi-million-vertex maps need no normal buffer.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(map.positions, 3));
    geometry.setIndex(new BufferAttribute(map.indices, 1));
    geometry.computeBoundingBox();
    geometry.boundingSphere = geometry.boundingBox!.getBoundingSphere(new Sphere());
    const mesh = new Mesh(geometry, this.solid);
    mesh.rotation.x = -Math.PI / 2;
    mesh.updateMatrixWorld(true);
    this.mapBounds.copy(geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    this.mapMesh = mesh;
    this.scene.add(mesh);
  }

  resetView(): void {
    this.dirty = true;
    const player = this.selectedPlayer();
    if (player !== undefined) this.controls.target.fromArray(sourcePoint(player.position)).add(new Vector3(0, 32, 0));
    else if (this.state?.cameraSamples?.[0] !== undefined) {
      const first = this.state.cameraSamples[0];
      this.controls.target.fromArray(sourcePoint([first.position.x, first.position.y, first.position.z]));
    }
    else if (!this.mapBounds.isEmpty()) this.mapBounds.getCenter(this.controls.target);
    else this.controls.target.set(0, 0, 0);
    this.camera.position.copy(this.controls.target).add(new Vector3(650, 850, 650));
    this.camera.up.set(0, 1, 0);
    this.controls.update();
    this.followedPlayer = null;
    this.framed = true;
  }

  private selectedPlayer(): ReplayPlayerRecord | undefined {
    return this.frame?.players.find((player) => player.id === this.state?.selectedPlayerId);
  }

  private readonly theme = (): void => {
    this.dirty = true;
    const styles = getComputedStyle(this.canvas);
    const color = (name: string) => new Color(styles.getPropertyValue(name).trim());
    this.scene.background = color('--color-media');
    this.ambient.color.copy(color('--color-on-media'));
    this.light.color.copy(color('--color-on-media'));
    this.solid.color.copy(color('--color-neutral-600'));
    this.bodyA.color.copy(color('--color-accent'));
    this.bodyB.color.copy(color('--color-team-b'));
    this.marker.color.copy(color('--color-on-media'));
    this.flying.color.copy(color('--color-on-media'));
    this.smoke.color.copy(color('--color-neutral-400'));
    this.fire.color.copy(color('--color-warn'));
    this.headingMaterial.color.copy(color('--color-on-media'));
    this.trailMaterial.color.copy(color('--color-warn'));
    this.pathMaterial.color.copy(color('--color-accent-400'));
  };

  private actor(id: string): Actor {
    const existing = this.actors.get(id);
    if (existing !== undefined) return existing;
    const group = new Group();
    const body = new Mesh(this.capsule, this.bodyA);
    body.position.y = BODY_HEIGHT / 2;
    body.userData['playerId'] = id;
    const heading = new Line(new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(6), 3)), this.headingMaterial);
    const ring = new Mesh(this.ringGeometry, this.marker);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2;
    group.add(body, heading, ring);
    this.scene.add(group);
    const actor = { group, body, heading, ring };
    this.actors.set(id, actor);
    return actor;
  }

  private updateActors(state: Scene3DState): void {
    for (const actor of this.actors.values()) actor.group.visible = false;
    for (const player of this.frame?.players ?? []) {
      const actor = this.actor(player.id);
      actor.group.visible = state.showPlayers && player.alive
        && !(state.mode === 'camera' && state.cameraSamples === null && player.id === state.selectedPlayerId);
      actor.group.position.fromArray(sourcePoint(player.position));
      actor.body.material = player.team === 'B' || player.team === 'T' ? this.bodyB : this.bodyA;
      const height = player.input?.crouch === true ? 48 : BODY_HEIGHT;
      actor.body.scale.y = height / BODY_HEIGHT;
      actor.body.position.y = height / 2;
      actor.ring.visible = player.id === state.selectedPlayerId;
      const direction = playerDirection(player.yaw, player.pitch);
      const points = actor.heading.geometry.getAttribute('position') as BufferAttribute;
      points.setXYZ(0, 0, height, 0);
      points.setXYZ(1, direction[0] * 96, height + direction[1] * 96, direction[2] * 96);
      points.needsUpdate = true;
      actor.heading.geometry.computeBoundingSphere();
    }
  }

  private updateUtilities(state: Scene3DState, tick: number): void {
    const live = new Set<string>();
    const visible = state.showUtilities && this.mapMesh !== null;
    for (const projectile of visible ? this.frame?.projectiles ?? [] : []) {
      if (!projectile.active) continue;
      live.add(projectile.id);
      let utility = this.utilities.get(projectile.id);
      if (utility !== undefined && utility.phase !== projectile.phase) {
        this.scene.remove(utility.mesh); this.utilities.delete(projectile.id); utility = undefined;
      }
      const burning = projectile.kind === 'molotov' || projectile.kind === 'incendiary' || projectile.kind.startsWith('inferno');
      if (utility === undefined) {
        const effect = projectile.phase !== 'flying';
        const mesh = new Mesh(effect && burning ? this.disc : this.sphere, effect ? burning ? this.fire : this.smoke : this.flying);
        if (effect && burning) mesh.rotation.x = -Math.PI / 2;
        utility = { mesh, phase: projectile.phase };
        this.utilities.set(projectile.id, utility);
        this.scene.add(mesh);
      }
      utility.mesh.position.fromArray(sourcePoint(projectile.position));
      const radius = projectile.phase === 'flying' ? 4 : projectile.radius ?? 144;
      utility.mesh.scale.setScalar(radius);
      if (projectile.phase !== 'flying') utility.mesh.position.y += burning ? 2 : radius * 0.4;
    }
    for (const [id, utility] of this.utilities) if (!live.has(id)) { this.scene.remove(utility.mesh); this.utilities.delete(id); }
    const activeTrails = new Set<string>();
    for (const trail of visible ? projectileTrails(state.frames, tick, state.tickRate) : []) {
      if (trail.points.length < 2) continue;
      activeTrails.add(trail.id);
      let line = this.trails.get(trail.id);
      if (line === undefined) {
        const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(MAX_TRAIL_POINTS * 3), 3));
        line = new Line(geometry, this.trailMaterial);
        this.trails.set(trail.id, line); this.scene.add(line);
      }
      const positions = line.geometry.getAttribute('position') as BufferAttribute;
      const count = Math.min(MAX_TRAIL_POINTS, trail.points.length);
      for (let index = 0; index < count; index += 1) {
        const point = trail.points[Math.round(index * (trail.points.length - 1) / (count - 1))]!;
        positions.setXYZ(index, point.x, point.z, -point.y);
      }
      positions.needsUpdate = true;
      line.geometry.setDrawRange(0, count);
      line.geometry.computeBoundingSphere();
    }
    for (const [id, line] of this.trails) if (!activeTrails.has(id)) { this.scene.remove(line); line.geometry.dispose(); this.trails.delete(id); }
  }

  private updateCamera(state: Scene3DState, tick: number): void {
    this.controls.enabled = state.mode !== 'camera';
    if (this.path !== null) this.path.visible = state.mode !== 'camera';
    const player = this.selectedPlayer();
    if (state.mode === 'camera') {
      const sample = cameraSampleAtTick(state.cameraSamples ?? [], tick);
      if (sample !== null) {
        const view = cameraView(sample);
        this.camera.position.fromArray(view.position);
        this.camera.up.fromArray(view.up);
        this.direction.fromArray(view.forward);
        this.camera.fov = view.fov;
      } else if (player !== undefined) {
        this.camera.position.fromArray(sourcePoint(player.position));
        this.camera.position.y += player.input?.crouch === true ? 46 : 64;
        this.camera.up.set(0, 1, 0);
        this.direction.fromArray(playerDirection(player.yaw, player.pitch));
        this.camera.fov = verticalFov(90);
      } else return;
      this.camera.lookAt(this.position.copy(this.camera.position).add(this.direction));
      this.camera.updateProjectionMatrix();
    } else if (state.mode === 'follow' && player !== undefined) {
      this.position.fromArray(sourcePoint(player.position)).add(new Vector3(0, 48, 0));
      if (this.followedPlayer !== player.id) {
        this.direction.fromArray(playerDirection(player.yaw, 0)).multiplyScalar(-260);
        this.camera.position.copy(this.position).add(this.direction);
        this.camera.position.y += 160;
      } else this.camera.position.add(this.direction.copy(this.position).sub(this.following));
      this.controls.target.copy(this.position);
      this.following.copy(this.position);
      this.followedPlayer = player.id;
    }
    if (state.mode !== 'camera') this.controls.update();
    this.cutPlane.constant = cutawayHeight(player?.position[2] ?? 0, player?.input?.crouch === true ? 48 : BODY_HEIGHT);
    this.solid.clippingPlanes = state.cutaway && state.mode !== 'camera' && player !== undefined ? [this.cutPlane] : null;
  }

  private readonly draw = (): void => {
    if (this.stopped) return;
    this.raf = requestAnimationFrame(this.draw);
    const state = this.state;
    if (state === null || this.width === 0 || this.height === 0 || !this.visible || document.hidden) return;
    const tick = state.readTick?.() ?? state.tick;
    if (tick !== this.lastTick) {
      this.dirty = true;
      this.lastTick = tick;
      this.frame = interpolateReplayFrame(state.frames, tick, state.tickRate);
      this.updateActors(state);
      this.updateUtilities(state, tick);
    }
    if (!this.framed && (this.frame !== null || this.path !== null || this.mapMesh !== null)) this.resetView();
    this.updateCamera(state, tick);
    if (this.dirty) {
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
  };

  private readonly invalidate = (): void => { this.dirty = true; };

  private readonly pointerDown = (event: PointerEvent): void => { this.pointerStart = [event.clientX, event.clientY]; };
  private readonly pointerUp = (event: PointerEvent): void => {
    const start = this.pointerStart;
    this.pointerStart = null;
    if (event.button !== 0 || start === null || Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 4) return;
    const box = this.canvas.getBoundingClientRect();
    this.mouse.set((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1);
    this.ray.setFromCamera(this.mouse, this.camera);
    const bodies = [...this.actors.values()].filter((actor) => actor.group.visible).map((actor) => actor.body);
    const hit = this.ray.intersectObjects(bodies, false)[0];
    if (hit !== undefined) this.onSelect(String(hit.object.userData['playerId']));
  };

  private readonly contextLost = (event: Event): void => { event.preventDefault(); this.stopped = true; cancelAnimationFrame(this.raf); this.onContextLost(); };

  dispose(): void {
    this.stopped = true; cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect(); this.visibilityObserver.disconnect(); this.themeObserver.disconnect();
    this.darkMode.removeEventListener('change', this.theme);
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    this.canvas.removeEventListener('pointerup', this.pointerUp);
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.controls.removeEventListener('change', this.invalidate);
    this.controls.dispose();
    this.mapMesh?.geometry.dispose(); this.path?.geometry.dispose();
    for (const actor of this.actors.values()) actor.heading.geometry.dispose();
    for (const trail of this.trails.values()) trail.geometry.dispose();
    for (const geometry of [this.capsule, this.ringGeometry, this.sphere, this.disc]) geometry.dispose();
    for (const material of [this.solid, this.bodyA, this.bodyB, this.marker, this.flying, this.smoke, this.fire, this.headingMaterial, this.trailMaterial, this.pathMaterial]) material.dispose();
    this.scene.clear(); this.actors.clear(); this.utilities.clear(); this.trails.clear();
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }
}
