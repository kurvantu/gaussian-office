import * as T from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Point2D } from '../../types/floorplan';
import { meshLevels, type HumanModel } from './model';
import { canStand, checkedPath, type ActorSpec, type ModelSpec, type Navigation, type Step } from './take';

const rad = T.MathUtils.degToRad;
const playable = (clip?: T.AnimationClip) => !!clip && Number.isFinite(clip.duration) && clip.duration > 0;
const LOD_DISTANCES = [4, 8, 14];
interface JointPose {
  bone: T.Bone;
  offsets: T.Quaternion[];
}

// SkeletonUtils remaps bones correctly, but clones a palette for *each* mesh.
// Preserve the source's skin sharing within this instance, never between actors.
function cloneHuman(source: T.Group) {
  const result = clone(source),
    palettes = new Map<T.Skeleton, T.Skeleton>();
  const share = (a: T.Object3D, b: T.Object3D) => {
    if (a instanceof T.SkinnedMesh && b instanceof T.SkinnedMesh) {
      const palette = palettes.get(a.skeleton);
      if (palette) {
        b.skeleton.dispose();
        b.skeleton = palette;
      } else palettes.set(a.skeleton, b.skeleton);
    }
    a.children.forEach((c, i) => share(c, b.children[i]));
  };
  share(source, result);
  return result;
}

export class HumanActor {
  readonly root = new T.Group(); // path transform is outside the mixer's hierarchy
  private readonly skin: T.Object3D;
  private readonly mixer: T.AnimationMixer;
  private readonly levels: T.Mesh[][];
  private readonly generated: { mesh: T.Mesh; levels: T.BufferGeometry[] }[];
  private level = -1;
  private readonly clips = new Map<string, T.AnimationClip>();
  private poses = new Map<number, JointPose>();
  private routes = new Map<number, Point2D[]>();
  private index = 0;
  private waypoint = 0;
  private time = 0;
  private startYaw = 0;
  private action?: T.AnimationAction;
  private offsetBone?: T.Bone;
  private base = new T.Quaternion();
  private offset = new T.Quaternion();

  constructor(
    readonly spec: ActorSpec,
    readonly model: HumanModel,
    readonly asset: ModelSpec,
    readonly label: string,
    readonly field: string
  ) {
    this.skin = cloneHuman(model.scene); // geometry/material shared, joints/skeletons are not
    this.root.name = `Human_${spec.id}`;
    this.root.add(this.skin);
    this.mixer = new T.AnimationMixer(this.skin);
    this.levels = meshLevels(this.skin);
    // SkeletonUtils clones share geometry, not pose; each instance can select its own index buffer.
    this.generated = model.generatedLods
      ? this.levels[0].map((mesh) => ({ mesh, levels: model.generatedLods!.get(mesh.geometry)! }))
      : [];
    for (const clip of model.animations) this.clips.set(clip.name, clip);
  }

  private requireClip(name: string, field: string) {
    if (!playable(this.clips.get(name))) {
      const available = [...this.clips.values()].filter(playable).map((c) => c.name);
      const hint = available.length
        ? `Available clips: ${available.slice(0, 8).join(', ')}${available.length > 8 ? ', …' : ''}.`
        : 'This model has no playable clips.';
      throw new Error(`${field}: no playable clip “${name}” in ${this.asset.file}. ${hint}`);
    }
  }

  prepare(nav: Navigation) {
    const { spec, asset, field } = this;
    if (asset.idleClip) this.requireClip(asset.idleClip, `models.${spec.model}.idleClip`);
    if (asset.walkClip) this.requireClip(asset.walkClip, `models.${spec.model}.walkClip`);
    this.rebuildRoutes(nav);
    spec.steps.forEach((s, i) => {
      const where = `${field}.steps[${i}]`;
      if (s.op === 'walkTo' && (!asset.walkClip || !asset.walkRefMps))
        throw new Error(`${where}: supply walkClip and walkRefMps for ${asset.file}.`);
      if (s.op === 'play') this.requireClip(s.clip, `${where}.clip`);
      if (s.op === 'pose') {
        const matches: T.Bone[] = [];
        this.skin.traverse((n) => {
          if (n instanceof T.Bone && (n.userData.name ?? n.name) === s.bone) matches.push(n);
        });
        const bone = matches[0];
        let parent = bone?.parent;
        while (parent && !(parent instanceof T.Bone)) parent = parent.parent;
        if (matches.length !== 1 || !parent)
          throw new Error(`${where}.bone: “${s.bone}” must name one non-root joint in ${asset.file}.`);
        const last = s.keys.length - 1;
        if (
          s.keys[0].tSec !== 0 ||
          s.keys.some((k, j) => j > 0 && k.tSec <= s.keys[j - 1].tSec) ||
          [s.keys[0], s.keys[last]].some((k) => k.xyzDeg.some((a) => a !== 0))
        ) {
          throw new Error(
            `${where}.keys: start at time zero, increase times strictly and use neutral first and last offsets.`
          );
        }
        this.poses.set(i, {
          bone,
          offsets: s.keys.map((k) =>
            new T.Quaternion().setFromEuler(
              new T.Euler(rad(k.xyzDeg[0]), rad(k.xyzDeg[1]), rad(k.xyzDeg[2]), 'XYZ')
            )
          ),
        });
      }
    });
    this.replay();
  }

  rebuildRoutes(nav: Navigation): boolean {
    if (!canStand(this.spec.spawn, nav))
      throw new Error(`${this.field}.spawn: mark is blocked or outside the floor.`);
    let from: Point2D = this.spec.spawn,
      changed = false;
    const routes = new Map<number, Point2D[]>();
    this.spec.steps.forEach((s, i) => {
      if (s.op !== 'walkTo') return;
      const next = checkedPath(from, s, nav, `${this.field}.steps[${i}]`),
        old = this.routes.get(i);
      if (!old || next.length !== old.length || next.some((p, j) => p.x !== old[j].x || p.z !== old[j].z))
        changed = true;
      routes.set(i, next);
      from = s;
    });
    this.routes = routes;
    return changed;
  }

  private clearOffset() {
    this.offsetBone?.quaternion.copy(this.base);
    this.offsetBone = undefined;
  }

  private enter() {
    this.clearOffset();
    const s = this.spec.steps[this.index];
    this.time = this.waypoint = 0;
    this.startYaw = this.root.rotation.y;
    const name = s?.op === 'walkTo' ? this.asset.walkClip : s?.op === 'play' ? s.clip : this.asset.idleClip;
    const clip = name ? this.clips.get(name) : undefined;
    const once = s?.op === 'play',
      rate = s?.op === 'walkTo' ? s.speedMps / this.asset.walkRefMps! : 1;
    if (this.action && this.action.getClip() === clip && !once && this.action.loop === T.LoopRepeat) {
      this.action.timeScale = rate;
      return;
    }
    this.action?.stop();
    this.action = clip ? this.mixer.clipAction(clip).reset() : undefined;
    if (this.action) {
      this.action.setLoop(once ? T.LoopOnce : T.LoopRepeat, once ? 1 : Infinity);
      this.action.clampWhenFinished = once;
      this.action.timeScale = rate;
      this.action.play();
      this.mixer.update(0);
    }
  }

  replay() {
    this.clearOffset();
    this.mixer.stopAllAction();
    this.action = undefined;
    const { x, z, yawDeg } = this.spec.spawn;
    this.root.position.set(x, 0, z);
    this.root.rotation.y = rad(yawDeg);
    this.index = 0;
    this.enter();
  }

  private pose(s: Extract<Step, { op: 'pose' }>) {
    const { bone, offsets } = this.poses.get(this.index)!;
    let i = 1;
    while (i < s.keys.length - 1 && this.time > s.keys[i].tSec) i++;
    const a = s.keys[i - 1].tSec,
      b = s.keys[i].tSec;
    this.base.copy(bone.quaternion);
    this.offsetBone = bone;
    this.offset.slerpQuaternions(offsets[i - 1], offsets[i], (this.time - a) / (b - a));
    bone.quaternion.multiply(this.offset); // relative to *this frame's* clean idle/rest pose
  }

  update(dt: number) {
    while (dt > 0) {
      this.clearOffset();
      const s = this.spec.steps[this.index];
      if (!s) {
        this.mixer.update(dt);
        return;
      }
      if (s.op === 'walkTo') {
        const route = this.routes.get(this.index)!,
          p = this.root.position;
        while (dt > 0 && this.waypoint < route.length) {
          const wp = route[this.waypoint],
            dx = wp.x - p.x,
            dz = wp.z - p.z;
          const dist = Math.hypot(dx, dz),
            seconds = dist / s.speedMps,
            used = Math.min(dt, seconds);
          if (dist > 0) this.root.rotation.y = Math.atan2(dx, dz);
          if (used === seconds) {
            p.x = wp.x;
            p.z = wp.z;
            this.waypoint++;
          } else {
            p.x += (dx * used) / seconds;
            p.z += (dz * used) / seconds;
          }
          this.mixer.update(used);
          dt -= used;
        }
        if (this.waypoint < route.length) return;
      } else {
        const duration =
          s.op === 'play'
            ? this.clips.get(s.clip)!.duration
            : s.op === 'pose'
              ? s.keys[s.keys.length - 1].tSec
              : s.durationSec;
        const used = Math.min(duration - this.time, dt);
        this.time += used;
        dt -= used;
        this.mixer.update(used);
        if (s.op === 'turnTo') {
          const diff = rad(s.yawDeg) - this.startYaw;
          this.root.rotation.y =
            this.startYaw + (Math.atan2(Math.sin(diff), Math.cos(diff)) * this.time) / duration;
        }
        if (s.op === 'pose') this.pose(s);
        if (this.time < duration) return;
      }
      this.index++;
      this.enter();
    }
  }

  updateLod(distance: number, mobile: boolean) {
    const count = this.generated.length ? this.generated[0].levels.length : this.levels.length;
    let level = Math.max(0, this.level);
    while (level < count - 1 && distance > LOD_DISTANCES[level] * 1.1) level++;
    while (level > 0 && distance < LOD_DISTANCES[level - 1] * 0.9) level--;
    if (mobile && count > 1) level = Math.max(1, level);
    if (level === this.level) return;
    this.level = level;
    if (this.generated.length) {
      this.generated.forEach(({ mesh, levels }) => {
        mesh.geometry = levels[level];
      });
      return;
    }
    this.levels.forEach((meshes, i) =>
      meshes.forEach((m) => {
        m.visible = i === level;
      })
    );
  }

  dispose() {
    this.clearOffset();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.skin);
    this.root.removeFromParent();
    const palettes = new Set<T.Skeleton>();
    this.skin.traverse((n) => {
      if (n instanceof T.SkinnedMesh) palettes.add(n.skeleton);
    });
    palettes.forEach((p) => p.dispose());
  }
}
