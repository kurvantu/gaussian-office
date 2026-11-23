// Bake the same PlanWalk takes into a portable GLB, without re-encoding the artist's
// meshes or maps. Run with npm run export:rigged-visitor (Node 22.12+).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as T from 'three';
import { authorRigClips, RIG_FILE } from '../src/scene/humans/rigMotion.ts';

const source = await readFile(new URL(`../data/humans/${RIG_FILE}`, import.meta.url));
const jsonEnd = 20 + source.readUInt32LE(12);
const doc = JSON.parse(source.subarray(20, jsonEnd).toString());
const bin = source.subarray(jsonEnd + 8);
if (doc.skins?.length !== 1 || doc.buffers?.length !== 1 || doc.animations?.length)
  throw new Error('Expected the original, single-skin, clipless man-rig.glb.');

// Only the rest hierarchy is needed to author tracks; no browser or texture decoder.
const jointIndices = new Set(doc.skins[0].joints);
const nodes = doc.nodes.map((n, i) => {
  const o = jointIndices.has(i) ? new T.Bone() : new T.Object3D();
  o.name = n.name;
  if (n.matrix) new T.Matrix4().fromArray(n.matrix).decompose(o.position, o.quaternion, o.scale);
  else {
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
  }
  return o;
});
doc.nodes.forEach((n, i) => n.children?.forEach((c) => nodes[i].add(nodes[c])));
const root = new T.Group();
doc.scenes[doc.scene ?? 0].nodes.forEach((i) => root.add(nodes[i]));
const clips = authorRigClips(root);
if (!clips) throw new Error('The expected visitor joints were not found.');

// Append aligned float accessors after the original BIN chunk. Existing buffer view
// offsets, inverse bind matrices, vertex weights, materials and images stay intact.
const chunks = [bin];
let offset = bin.length;
function append(array, type, width) {
  const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const bufferView = doc.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }) - 1;
  chunks.push(bytes);
  offset += bytes.length;
  const bounds = type === 'SCALAR' ? { min: [array[0]], max: [array.at(-1)] } : {};
  return (
    doc.accessors.push({ bufferView, componentType: 5126, type, count: array.length / width, ...bounds }) - 1
  );
}
doc.animations = clips.map((clip) => {
  const channels = [],
    samplers = [];
  for (const track of clip.tracks) {
    const { nodeName, propertyName } = T.PropertyBinding.parseTrackName(track.name);
    const node = nodes.findIndex((n) => n.name === nodeName);
    if (!jointIndices.has(node)) throw new Error(`Unbound animation track: ${track.name}`);
    const rotation = propertyName === 'quaternion';
    if (!rotation && propertyName !== 'position') throw new Error(`Unsupported track: ${track.name}`);
    const input = append(track.times, 'SCALAR', 1);
    const output = append(track.values, rotation ? 'VEC4' : 'VEC3', track.getValueSize());
    const sampler = samplers.push({ input, output, interpolation: 'LINEAR' }) - 1;
    channels.push({ sampler, target: { node, path: rotation ? 'rotation' : 'translation' } });
  }
  return { name: clip.name, channels, samplers };
});
doc.buffers[0].byteLength = offset;
const json = Buffer.from(JSON.stringify(doc));
const padded = Math.ceil(json.length / 4) * 4;
const header = Buffer.from(source.subarray(0, 20)),
  binHeader = Buffer.from(source.subarray(jsonEnd, jsonEnd + 8));
header.writeUInt32LE(28 + padded + offset, 8);
header.writeUInt32LE(padded, 12);
binHeader.writeUInt32LE(offset);
const dir = new URL('../exports/', import.meta.url);
await mkdir(dir, { recursive: true });
await writeFile(
  new URL('man-rig-animated.glb', dir),
  Buffer.concat([header, json, Buffer.alloc(padded - json.length, 0x20), binHeader, ...chunks])
);
console.log(`exports/man-rig-animated.glb — ${clips.map((c) => `${c.name} (${c.duration}s)`).join(', ')}`);
