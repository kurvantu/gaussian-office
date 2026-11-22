import * as T from 'three';

export const TRIANGLES = [20_000, 10_000, 5_000, 2_000] as const;
const LOD_RATIOS = [1, 0.5, 0.25, 0.1] as const;
export type GeometryLods = Map<T.BufferGeometry, T.BufferGeometry[]>;
const triangleCount = (g: T.BufferGeometry) => (g.index?.count ?? g.attributes.position.count) / 3;

/** End markers and other unweighted joints need not occupy slots in the GPU palette.
 * Keep the complete node hierarchy: a non-weighted parent can still move a weighted child. */
export function fitSkinPalettes(meshes: T.Mesh[]) {
  const rigs = new Map<T.Skeleton, T.SkinnedMesh[]>();
  for (const m of meshes)
    if (m instanceof T.SkinnedMesh) {
      if (!rigs.has(m.skeleton)) rigs.set(m.skeleton, []);
      rigs.get(m.skeleton)!.push(m);
    }
  if (new Set([...rigs.keys()].flatMap((r) => r.bones)).size <= 64) return;
  const allWeighted = new Set<T.Bone>(),
    seenGeometry = new Set<T.BufferGeometry>();
  for (const [rig, parts] of rigs) {
    const used = new Set<number>();
    const geometries = new Set(parts.map((m) => m.geometry));
    for (const g of geometries) {
      if (seenGeometry.has(g)) throw new Error('Export one shared skin palette per geometry.');
      seenGeometry.add(g);
      const joints = g.getAttribute('skinIndex'),
        weights = g.getAttribute('skinWeight');
      if (
        !joints ||
        !weights ||
        joints.itemSize !== 4 ||
        weights.itemSize !== 4 ||
        joints.count !== weights.count
      )
        throw new Error('Invalid four-weight skin.');
      for (let i = 0; i < weights.count; i++)
        for (let k = 0; k < 4; k++) {
          if (weights.getComponent(i, k) === 0) continue;
          const j = joints.getComponent(i, k);
          if (!rig.bones[j]) throw new Error('Skin references an unknown joint.');
          used.add(j);
          allWeighted.add(rig.bones[j]);
        }
    }
    if (!used.size || allWeighted.size > 64)
      throw new Error('A human model may use at most 64 weighted joints.');
    const slots = [...used].sort((a, b) => a - b),
      remap = new Map(slots.map((j, i) => [j, i]));
    for (const g of geometries) {
      const joints = g.getAttribute('skinIndex'),
        packed = new Uint16Array(joints.count * 4);
      for (let i = 0; i < joints.count; i++)
        for (let k = 0; k < 4; k++) packed[4 * i + k] = remap.get(joints.getComponent(i, k)) ?? 0;
      g.setAttribute('skinIndex', new T.Uint16BufferAttribute(packed, 4));
    }
    const palette = new T.Skeleton(
      slots.map((j) => rig.bones[j]),
      slots.map((j) => rig.boneInverses[j])
    );
    parts.forEach((m) => m.bind(palette, m.bindMatrix));
    rig.dispose();
  }
}

/** Build index-only LODs once, before attaching the model. Preserve the artist's vertex
 * attributes (including UVs and weights), PBR materials, bind transforms and hierarchy. */
export async function buildDetailLods(meshes: T.Mesh[], lods: GeometryLods, signal: AbortSignal) {
  const { MeshoptSimplifier } = await import('meshoptimizer/simplifier');
  if (!MeshoptSimplifier.supported) throw new Error('This device needs a model with authored LOD0–LOD3.');
  await MeshoptSimplifier.ready;
  const total = meshes.reduce((n, m) => n + triangleCount(m.geometry), 0);
  for (const { geometry: g } of meshes) {
    if (lods.has(g)) continue;
    // Yield between primitives so cancel/close/preset changes can abort a detailed import.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    signal.throwIfAborted();
    const pos = g.getAttribute('position'),
      uv = g.getAttribute('uv'),
      normal = g.getAttribute('normal');
    const positions = new Float32Array(pos.count * 3),
      attrs = new Float32Array(pos.count * 5);
    for (let i = 0; i < pos.count; i++) {
      positions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], 3 * i);
      attrs.set(
        [
          normal?.getX(i) ?? 0,
          normal?.getY(i) ?? 0,
          normal?.getZ(i) ?? 0,
          uv?.getX(i) ?? 0,
          uv?.getY(i) ?? 0,
        ],
        5 * i
      );
    }
    const indices = Uint32Array.from({ length: triangleCount(g) * 3 }, (_, i) =>
      g.index ? g.index.getX(i) : i
    );
    const levels: T.BufferGeometry[] = [];
    lods.set(g, levels);
    for (const [level, limit] of TRIANGLES.entries()) {
      const budget = Math.min(limit, Math.max(meshes.length, Math.floor(total * LOD_RATIOS[level])));
      const quota = 1 + Math.floor(((budget - meshes.length) * triangleCount(g)) / total);
      if (total <= budget || indices.length <= 3 * quota) {
        levels.push(g);
        continue;
      }
      const [reduced] = MeshoptSimplifier.simplifyWithAttributes(
        indices,
        positions,
        3,
        attrs,
        5,
        [0.2, 0.2, 0.2, 1, 1],
        null,
        quota * 3,
        1,
        ['Permissive']
      );
      if (!reduced.length) {
        levels.push(levels[level - 1] ?? g);
        continue;
      }
      const variant = new T.BufferGeometry();
      variant.attributes = { ...g.attributes };
      variant.morphAttributes = g.morphAttributes;
      variant.morphTargetsRelative = g.morphTargetsRelative;
      variant.setIndex(new T.BufferAttribute(pos.count <= 65535 ? new Uint16Array(reduced) : reduced, 1));
      levels.push(variant);
    }
  }
  for (const [level, limit] of TRIANGLES.entries()) {
    if (meshes.reduce((n, m) => n + triangleCount(lods.get(m.geometry)![level]), 0) > limit) {
      throw new Error(`Could not simplify LOD${level} to ${limit} triangles. Supply authored LODs.`);
    }
  }
}
