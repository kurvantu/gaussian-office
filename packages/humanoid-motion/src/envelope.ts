// Structural preflight shared by the studio and the offline adapter. No image decode,
// URL resolution or Three allocations here. This is not a general glTF conformance validator.
export interface GlbDocument {
  asset: { version: string };
  scenes: { nodes?: number[] }[];
  nodes?: { name?: string; children?: number[]; mesh?: number; skin?: number; matrix?: number[] }[];
  buffers: { byteLength: number; uri?: string }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number }[];
  accessors: {
    count: number;
    bufferView?: number;
    sparse?: unknown;
    componentType: number;
    type: string;
    min?: number[];
    max?: number[];
  }[];
  materials?: { alphaMode?: string }[];
  cameras?: unknown[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  textures?: { source: number }[];
  meshes?: { primitives: { mode?: number; attributes: Record<string, number> }[] }[];
  skins?: { joints: number[] }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  animations?: { name?: string }[];
}

/** Only the first 20 bytes are needed to locate the JSON (e.g. for local clip-name hints). */
export function glbJsonLength(view: DataView, fileSize: number) {
  if (
    view.byteLength < 20 ||
    fileSize < 28 ||
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== fileSize ||
    view.getUint32(16, true) !== 0x4e4f534a
  )
    throw new Error('Expected a binary glTF 2.0 (.glb) file.');
  const length = view.getUint32(12, true);
  if (length % 4 || 28 + length > fileSize) throw new Error('Invalid binary GLB chunk.');
  return length;
}

export function readEnvelope(bytes: ArrayBuffer, maxNodes: number, maxElements: number) {
  const view = new DataView(bytes),
    jsonLength = glbJsonLength(view, bytes.byteLength),
    binStart = 28 + jsonLength;
  if (
    view.getUint32(binStart - 4, true) !== 0x004e4942 ||
    view.getUint32(binStart - 8, true) !== bytes.byteLength - binStart ||
    (bytes.byteLength - binStart) % 4
  )
    throw new Error('Invalid binary GLB chunk.');
  const doc: GlbDocument = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)));
  const nodes = doc.nodes ?? [];
  if (
    doc.asset?.version !== '2.0' ||
    doc.scenes?.length !== 1 ||
    !Array.isArray(nodes) ||
    nodes.length > maxNodes
  )
    throw new Error(`Export one glTF 2.0 scene with at most ${maxNodes} nodes.`);
  if (
    doc.buffers?.length !== 1 ||
    doc.buffers[0].uri !== undefined ||
    doc.images?.some((img) => img.uri !== undefined || img.bufferView === undefined)
  )
    throw new Error('Embed buffers and images in the GLB. External resources are not allowed.');
  const length = doc.buffers[0].byteLength;
  if (
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    bytes.byteLength - binStart !== Math.ceil(length / 4) * 4 ||
    !Array.isArray(doc.bufferViews) ||
    doc.bufferViews.some(
      (v) =>
        v.buffer !== 0 ||
        !Number.isSafeInteger(v.byteOffset ?? 0) ||
        (v.byteOffset ?? 0) < 0 ||
        !Number.isSafeInteger(v.byteLength) ||
        v.byteLength <= 0 ||
        (v.byteOffset ?? 0) + v.byteLength > length
    )
  )
    throw new Error('Invalid embedded buffer view.');
  const visited = new Uint8Array(nodes.length),
    parents = new Set<number>();
  function visit(i: number) {
    if (!Number.isInteger(i) || !nodes[i] || visited[i] === 1)
      throw new Error('GLB has a broken node hierarchy.');
    if (visited[i] === 2) return;
    visited[i] = 1;
    for (const c of nodes[i].children ?? []) {
      if (parents.has(c)) throw new Error('GLB nodes must have a single parent.');
      parents.add(c);
      visit(c);
    }
    visited[i] = 2;
  }
  nodes.forEach((_, i) => visit(i));
  for (const i of doc.scenes[0].nodes ?? []) {
    visit(i);
    if (parents.has(i)) throw new Error('Invalid GLB scene root.');
  }
  const ext = [...(doc.extensionsUsed ?? []), ...(doc.extensionsRequired ?? [])].find(
    (x) => !['KHR_materials_unlit', 'KHR_texture_transform', 'KHR_mesh_quantization'].includes(x)
  );
  if (ext) throw new Error(`Unsupported extension ${ext}. Export core glTF without compression or effects.`);
  if (
    !Array.isArray(doc.accessors) ||
    doc.accessors.some(
      (a) =>
        !Number.isSafeInteger(a.count) ||
        a.count < 1 ||
        a.count > maxElements ||
        a.bufferView === undefined ||
        !doc.bufferViews[a.bufferView] ||
        a.sparse
    )
  )
    throw new Error(
      `Use dense, buffer-backed accessors with at most ${maxElements.toLocaleString('en-US')} elements each.`
    );
  for (const mesh of doc.meshes ?? [])
    for (const p of mesh.primitives) {
      if (p.mode !== undefined && p.mode !== 4)
        throw new Error('Export triangle meshes only (no lines or particles).');
      if (Object.keys(p.attributes).some((k) => /^(JOINTS|WEIGHTS)_[1-9]/.test(k)))
        throw new Error('Limit skinning to four weights per vertex.');
    }
  return { doc, binStart };
}
