import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildDetailLods, fitSkinPalettes, TRIANGLES, type GeometryLods } from './detail';
import { planImages, useImageBudget, type EmbeddedMaps } from './imageBudget';
import { library } from './library';

export const MAX_GLB_BYTES = 8 * 1024 * 1024;
export interface HumanModel {
  scene: T.Group;
  animations: T.AnimationClip[];
  generatedLods?: GeometryLods;
}

interface Envelope extends EmbeddedMaps {
  asset?: { version: string };
  scenes?: { nodes?: number[] }[];
  nodes?: { name?: string; children?: number[]; mesh?: number; skin?: number }[];
  buffers?: { uri?: string }[];
  accessors?: { count: number; bufferView?: number; sparse?: unknown }[];
  materials?: { alphaMode?: string }[];
  cameras?: unknown[];
  extensionsUsed?: string[];
  meshes?: { primitives: { mode?: number; attributes: Record<string, number> }[] }[];
}

// Check the envelope BEFORE GLTFLoader can resolve a URL or allocate attribute arrays.
function checkEnvelope(bytes: ArrayBuffer, file: string, mobile: boolean) {
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
  const binStart = 28 + view.getUint32(12, true);
  if (
    binStart > bytes.byteLength ||
    view.getUint32(binStart - 4, true) !== 0x004e4942 ||
    view.getUint32(binStart - 8, true) !== bytes.byteLength - binStart
  ) {
    throw new Error('Invalid binary GLB chunk.');
  }
  const images = planImages(bytes, binStart, doc, mobile);
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
  // The supplied Blender scene contains two coincident full people. Select the dressed
  // armature, not the separate black humanBody reference, BEFORE GLTFLoader decodes it.
  // Never discard arbitrary secondary roots from other imported scenes.
  const roots = doc.scenes[0].nodes ?? [];
  let displayRoot: number | undefined;
  if (file === library.visitor.file && roots.length === 2) {
    const reference = roots.find((i) => nodes[i]?.name === 'Sketchfab_model.001');
    if (reference !== undefined) {
      const parts: number[] = [];
      const seen = new Set<number>();
      const collect = (i: number) => {
        if (seen.has(i)) return;
        seen.add(i);
        if (nodes[i].mesh !== undefined) parts.push(i);
        nodes[i].children?.forEach(collect);
      };
      collect(reference);
      if (
        parts.length === 1 &&
        nodes[parts[0]].name === 'humanBody_0' &&
        nodes[parts[0]].skin === undefined
      ) {
        displayRoot = roots.find((i) => nodes[i]?.name === 'Sketchfab_model');
      }
    }
  }
  return { images, displayRoot };
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
    throw new Error(
      'Supply meshes under all four LOD0–LOD3 nodes, or leave the source meshes unlabelled to generate LODs.'
    );
  return levels;
}

class TopologyError extends Error {}

function checkSurface(mesh: T.Mesh, joinSeams = true) {
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
    const key = joinSeams ? xyz.join(',') : String(i);
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
      if (twin < 0) throw new TopologyError('Mesh contains a non-manifold edge.');
      if (vertices[twin] === u) throw new TopologyError('Adjacent triangles have inconsistent winding.');
      parents[fan(h)] = fan(next(twin));
      parents[fan(next(h))] = fan(twin);
      edges.set(key, -1);
    }
  }
  const firstFan = new Int32Array(unique.size).fill(-1);
  for (let i = 0; i < n; i++) {
    const v = vertices[i],
      f = fan(i);
    if (firstFan[v] >= 0 && firstFan[v] !== f)
      throw new TopologyError('Mesh contains a non-manifold vertex.');
    firstFan[v] = f;
  }
}

async function inspect(model: HumanModel, signal: AbortSignal) {
  const levels = meshLevels(model.scene);
  model.scene.traverse((node) => {
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
  let generate = false;
  for (const [i, meshes] of levels.entries()) {
    const plain = levels.length === 1;
    const limit = plain ? 32_000 : TRIANGLES[i];
    const tris = meshes.reduce(
      (n, m) => n + (m.geometry.index ?? m.geometry.attributes.position).count / 3,
      0
    );
    if (tris > limit)
      throw new Error(
        `${plain ? 'Single-level source' : `LOD${i}`} exceeds ${limit.toLocaleString()} triangles.`
      );
    if (meshes.length > 12 || meshes.some((m) => Array.isArray(m.material)))
      throw new Error('Allow at most 12 visible primitives per LOD.');
    for (const m of meshes) {
      try {
        checkSurface(m);
      } catch (e) {
        // UV seam welding repairs split fans, but coincident indexed sheets (e.g. hair)
        // are not necessarily joined. Require manifold topology in one interpretation.
        if (!(e instanceof TopologyError) || !m.geometry.index) throw e;
        checkSurface(m, false);
      }
    }
    generate ||= plain && tris > TRIANGLES[3];
  }
  fitSkinPalettes(levels.flat());
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
  if (generate) {
    model.generatedLods = new Map();
    await buildDetailLods(levels[0], model.generatedLods, signal);
  }
}

/** Own only imported assets. Mesh instances share these resources until the last user is gone. */
export function disposeModel(model: HumanModel) {
  const resources = new Set<T.Material | T.BufferGeometry | T.Texture | T.Skeleton>();
  model.generatedLods?.forEach((levels) => levels.forEach((g) => resources.add(g)));
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

export async function loadModel(file: File, signal: AbortSignal, mobile = false): Promise<HumanModel> {
  if (!/\.glb$/i.test(file.name) || file.size > MAX_GLB_BYTES)
    throw new Error(`${file.name}: choose a .glb of at most 8 MiB.`);
  const urls = new Set<string>();
  let model: HumanModel | undefined,
    imageError = false;
  try {
    const bytes = await file.arrayBuffer();
    signal.throwIfAborted();
    const { images, displayRoot } = checkEnvelope(bytes, file.name, mobile);
    const manager = new T.LoadingManager();
    manager.setURLModifier((url) => {
      if (!url.startsWith('blob:')) throw new Error('External resources are not allowed.');
      urls.add(url);
      return url;
    });
    manager.onError = () => {
      imageError = true;
    };
    const loader = new GLTFLoader(manager);
    useImageBudget(loader, images);
    if (displayRoot !== undefined)
      loader.register((parser) => ({
        name: 'PlanWalkVisitorRoot',
        beforeRoot() {
          parser.json.scenes[0].nodes = [displayRoot];
          return null;
        },
      }));
    const gltf = await loader.parseAsync(bytes, '');
    model = { scene: gltf.scene, animations: gltf.animations };
    signal.throwIfAborted();
    if (imageError) throw new Error('Could not decode an embedded texture.');
    await inspect(model, signal);
    signal.throwIfAborted();
    return model;
  } catch (error) {
    if (model) disposeModel(model);
    signal.throwIfAborted();
    throw new Error(`${file.name}: ${error instanceof Error ? error.message : 'Could not read model.'}`);
  } finally {
    urls.forEach((url) => URL.revokeObjectURL(url));
  }
}
