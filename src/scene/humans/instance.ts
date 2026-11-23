import * as T from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { meshLevels, type HumanModel } from './model';

const LOD_DISTANCES = [4, 8, 14];
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

/** A live skin owns its bones, mixer and LOD choice, never the prepared model's geometry or maps. */
export class HumanInstance {
  readonly root = new T.Group();
  protected readonly skin: T.Object3D;
  protected readonly mixer: T.AnimationMixer;
  protected readonly clips = new Map<string, T.AnimationClip>();
  private readonly levels: T.Mesh[][];
  private readonly generated: { mesh: T.Mesh; levels: T.BufferGeometry[] }[];
  private level = -1;

  constructor(readonly model: HumanModel, name: string) {
    this.skin = cloneHuman(model.scene);
    this.root.name = name;
    this.root.add(this.skin);
    this.mixer = new T.AnimationMixer(this.skin);
    this.levels = meshLevels(this.skin);
    // SkeletonUtils clones share geometry, not pose; each instance can select its own index buffer.
    this.generated = model.generatedLods
      ? this.levels[0].map((mesh) => ({ mesh, levels: model.generatedLods!.get(mesh.geometry)! }))
      : [];
    for (const clip of model.animations) this.clips.set(clip.name, clip);
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
