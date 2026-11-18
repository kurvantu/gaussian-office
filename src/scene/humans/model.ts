import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const MAX_GLB_BYTES = 8 * 1024 * 1024;
const TRIANGLES = [20_000, 10_000, 5_000, 2_000];
export interface HumanModel {
  scene: T.Group;
  animations: T.AnimationClip[];
}

interface Envelope {
  asset?: { version: string };
  scenes?: unknown[];
  nodes?: { children?: number[] }[];
  textures?: unknown[];
  buffers?: { uri?: string }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  accessors?: { count: number; bufferView?: number; sparse?: unknown }[];
  materials?: { alphaMode?: string }[];
  cameras?: unknown[];
  extensionsUsed?: string[];
  meshes?: { primitives: { mode?: number; attributes: Record<string, number> }[] }[];
}

// Check the envelope BEFORE GLTFLoader can resolve a URL or allocate attribute arrays.
function checkEnvelope(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  if (
    bytes.byteLength < 28 ||
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.byteLength ||
    view.getUint32(16, true) !== 0x4e4f534a
  ) {
    throw new Error('Expected a binary glTF 2.0 (.glb) file.');
  }
  const doc: Envelope = JSON.parse(
    new TextDecoder().decode(new Uint8Array(bytes, 20, view.getUint32(12, true)))
  );
  if (doc.asset?.version !== '2.0' || doc.scenes?.length !== 1 || (doc.nodes?.length ?? 0) > 512) {
    throw new Error('Export one glTF 2.0 scene with at most 512 nodes.');
  }
  // Cyclic node dependencies can leave a parser promise waiting for itself.
  const nodes = doc.nodes ?? [],
    visited = new Uint8Array(nodes.length);
  function visit(i: number) {
    if (!Number.isInteger(i) || !nodes[i] || visited[i] === 1)
      throw new Error('GLB has a broken node hierarchy.');
    if (visited[i] === 2) return;
    visited[i] = 1;
    nodes[i].children?.forEach(visit);
    visited[i] = 2;
  }
  nodes.forEach((_, i) => visit(i));
  if (
    doc.buffers?.length !== 1 ||
    doc.buffers[0].uri !== undefined ||
    doc.images?.some((img) => img.uri !== undefined || img.bufferView === undefined)
  ) {
    throw new Error('Embed buffers and images in the GLB. External resources are not allowed.');
  }
  if (
    (doc.images?.length ?? 0) > 2 ||
    (doc.textures?.length ?? 0) > 2 ||
    doc.images?.some((img) => !['image/png', 'image/jpeg'].includes(img.mimeType ?? ''))
  ) {
    throw new Error('Use at most two embedded PNG or JPEG maps, each at most 1024 × 1024.');
  }
  const extension = doc.extensionsUsed?.find(
    (name) => !['KHR_materials_unlit', 'KHR_texture_transform', 'KHR_mesh_quantization'].includes(name)
  );
  if (extension)
    throw new Error(`Unsupported extension ${extension}. Export core glTF without compression or effects.`);
  if (doc.cameras?.length || doc.materials?.some((m) => m.alphaMode === 'BLEND'))
    throw new Error('Remove cameras and blended materials.');
  if (
    doc.accessors?.some(
      (a) =>
        !Number.isSafeInteger(a.count) ||
        a.count < 1 ||
        a.count > 120_000 ||
        a.bufferView === undefined ||
        a.sparse
    )
  ) {
    throw new Error('Use dense, buffer-backed accessors with at most 120,000 elements each.');
  }
  for (const mesh of doc.meshes ?? [])
    for (const p of mesh.primitives) {
      if (p.mode !== undefined && p.mode !== 4)
        throw new Error('Export triangle meshes only (no lines or particles).');
      if (Object.keys(p.attributes).some((k) => /^(JOINTS|WEIGHTS)_[1-9]/.test(k)))
        throw new Error('Limit skinning to four weights per vertex.');
    }
}

/** Each LOD may be a named mesh or a parent of its primitives. */
export function meshLevels(scene: T.Object3D): T.Mesh[][] {
  const levels: T.Mesh[][] = [[], [], [], []],
    plain: T.Mesh[] = [];
  scene.traverse((node) => {
    if (!(node instanceof T.Mesh)) return;
    let parent: T.Object3D | null = node;
    while (parent) {
      const match = /(?:^|[_.-])LOD([0-3])$/i.exec(parent.name);
      if (match) {
        levels[Number(match[1])].push(node);
        return;
      }
      parent = parent.parent;
    }
    plain.push(node);
  });
  if (levels.every((l) => l.length === 0) && plain.length) return [plain];
  if (plain.length || levels.some((l) => l.length === 0))
    throw new Error('Supply meshes under all four LOD0–LOD3 nodes, or one low-poly model.');
  return levels;
}

function checkSurface(mesh: T.Mesh) {
  const g = mesh.geometry,
    pos = g.getAttribute('position'),
    index = g.index;
  if (!pos || pos.itemSize !== 3) throw new Error('Mesh is missing positions.');
  const atlasUVs = new Set<T.BufferAttribute | T.InterleavedBufferAttribute>();
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of mats)
    for (const value of Object.values(mat)) {
      if (!(value instanceof T.Texture)) continue;
      if (!value.image?.width || !value.image.height || value.image.width > 1024 || value.image.height > 1024)
        throw new Error('World maps must be at most 1024 × 1024.');
      value.generateMipmaps = true;
      value.minFilter = T.LinearMipmapLinearFilter;
      const uv = g.getAttribute(value.channel ? `uv${value.channel}` : 'uv');
      if (!uv || uv.count !== pos.count) throw new Error('Textured meshes need a UV for every vertex.');
      atlasUVs.add(uv);
      for (let i = 0; i < uv.count; i++) {
        if (![uv.getX(i), uv.getY(i)].every((v) => Number.isFinite(v) && v >= -0.0001 && v <= 1.0001))
          throw new Error('Atlas UVs must be finite and inside [0,1].');
      }
    }
  // Weld UV/normal seams for the topology audit. Open hems are OK; edges
  // shared by three faces and disjoint fans meeting at one vertex are not.
  const unique = new Map<string, number>(),
    weld: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const xyz = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    if (!xyz.every(Number.isFinite)) throw new Error('Mesh contains a non-finite position.');
    const key = xyz.join(',');
    if (!unique.has(key)) unique.set(key, unique.size);
    weld.push(unique.get(key)!);
  }
  const n = index?.count ?? pos.count;
  if (n < 3 || n % 3 !== 0) throw new Error('Mesh contains an incomplete triangle.');
  const vertices = new Uint32Array(n),
    parents = new Uint32Array(n);
  const edges = new Map<number, number>(); // first directed edge (corner index), -1 once paired
  const next = (c: number) => (c % 3 === 2 ? c - 2 : c + 1);
  const fan = (c: number) => {
    while (parents[c] !== c) {
      parents[c] = parents[parents[c]];
      c = parents[c];
    }
    return c;
  };
  const origin = new T.Vector3(),
    ab = new T.Vector3(),
    ac = new T.Vector3();
  for (let i = 0; i < n; i += 3) {
    const ids = [0, 1, 2].map((k) => (index ? index.getX(i + k) : i + k));
    if (ids.some((v) => weld[v] === undefined)) throw new Error('Triangle index is outside the mesh.');
    const [a, b, c] = ids;
    origin.fromBufferAttribute(pos, a);
    ab.fromBufferAttribute(pos, b).sub(origin);
    ac.fromBufferAttribute(pos, c).sub(origin);
    if (ab.cross(ac).lengthSq() === 0) throw new Error('Mesh contains a degenerate triangle.');
    for (const uv of atlasUVs) {
      const area =
        (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a)) -
        (uv.getY(b) - uv.getY(a)) * (uv.getX(c) - uv.getX(a));
      if (area === 0) throw new Error('A textured triangle has collapsed UVs.');
    }
    ids.forEach((v, k) => {
      parents[i + k] = i + k;
      vertices[i + k] = weld[v];
    });
    for (let h = i; h < i + 3; h++) {
      const u = vertices[h],
        v = vertices[next(h)],
        key = Math.min(u, v) * pos.count + Math.max(u, v);
      const twin = edges.get(key);
      if (twin === undefined) {
        edges.set(key, h);
        continue;
      }
      if (twin < 0) throw new Error('Mesh contains a non-manifold edge.');
      if (vertices[twin] === u) throw new Error('Adjacent triangles have inconsistent winding.');
      parents[fan(h)] = fan(next(twin));
      parents[fan(next(h))] = fan(twin);
      edges.set(key, -1);
    }
  }
  const firstFan = new Int32Array(unique.size).fill(-1);
  for (let i = 0; i < n; i++) {
    const v = vertices[i],
      f = fan(i);
    if (firstFan[v] >= 0 && firstFan[v] !== f) throw new Error('Mesh contains a non-manifold vertex.');
    firstFan[v] = f;
  }
}

function inspect(model: HumanModel) {
  const levels = meshLevels(model.scene);
  const bones = new Set<T.Bone>();
  model.scene.traverse((node) => {
    if (node instanceof T.Bone) bones.add(node);
    if (
      node instanceof T.Light ||
      node instanceof T.Camera ||
      node instanceof T.InstancedMesh ||
      node instanceof T.Points ||
      node instanceof T.Line
    ) {
      throw new Error('Only ordinary or skinned triangle meshes may be inserted.');
    }
  });
  if (bones.size > 64) throw new Error('A human rig may have at most 64 bones.');
  for (const [i, meshes] of levels.entries()) {
    const limit = levels.length === 1 ? TRIANGLES[3] : TRIANGLES[i];
    const tris = meshes.reduce(
      (sum, m) => sum + (m.geometry.index ?? m.geometry.attributes.position).count / 3,
      0
    );
    if (tris > limit)
      throw new Error(
        levels.length === 1
          ? 'Above 2,000 triangles: supply LOD0–LOD3.'
          : `LOD${i} exceeds ${limit.toLocaleString()} triangles.`
      );
    if (meshes.length > 2 || meshes.some((m) => Array.isArray(m.material)))
      throw new Error('Allow at most two visible primitives per LOD.');
    meshes.forEach(checkSurface);
  }
  model.scene.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(model.scene, true);
  const height = box.max.y - box.min.y;
  if (
    !(
      height >= 0.6 &&
      height <= 2.5 &&
      Math.abs(box.min.y) <= 0.08 &&
      box.distanceToPoint(new T.Vector3()) <= 0.12
    )
  ) {
    throw new Error(
      'Export in metres, Y up, 0.6–2.5 m tall, with the origin between the feet (floor Y = 0 ± 8 cm).'
    );
  }
}

/** Own only imported assets. Mesh instances share these resources until the last user is gone. */
export function disposeModel(model: HumanModel) {
  const resources = new Set<T.Material | T.BufferGeometry | T.Texture | T.Skeleton>();
  const images = new Set<ImageBitmap>();
  model.scene.traverse((node) => {
    if (!(node instanceof T.Mesh)) return;
    resources.add(node.geometry);
    if (node instanceof T.SkinnedMesh) resources.add(node.skeleton);
    for (const mat of Array.isArray(node.material) ? node.material : [node.material]) {
      resources.add(mat);
      for (const value of Object.values(mat))
        if (value instanceof T.Texture) {
          resources.add(value);
          if (value.image?.close) images.add(value.image);
        }
    }
  });
  resources.forEach((r) => r.dispose());
  images.forEach((img) => img.close());
}

export async function loadModel(file: File, signal: AbortSignal): Promise<HumanModel> {
  if (!/\.glb$/i.test(file.name) || file.size > MAX_GLB_BYTES)
    throw new Error(`${file.name}: choose a .glb of at most 8 MiB.`);
  const urls = new Set<string>();
  let model: HumanModel | undefined,
    imageError = false;
  try {
    const bytes = await file.arrayBuffer();
    signal.throwIfAborted();
    checkEnvelope(bytes);
    const manager = new T.LoadingManager();
    manager.setURLModifier((url) => {
      if (!url.startsWith('blob:')) throw new Error('External resources are not allowed.');
      urls.add(url);
      return url;
    });
    manager.onError = () => {
      imageError = true;
    };
    const gltf = await new GLTFLoader(manager).parseAsync(bytes, '');
    model = { scene: gltf.scene, animations: gltf.animations };
    signal.throwIfAborted();
    if (imageError) throw new Error('Could not decode an embedded texture.');
    inspect(model);
    return model;
  } catch (error) {
    if (model) disposeModel(model);
    signal.throwIfAborted();
    throw new Error(`${file.name}: ${error instanceof Error ? error.message : 'Could not read model.'}`);
  } finally {
    urls.forEach((url) => URL.revokeObjectURL(url));
  }
}
