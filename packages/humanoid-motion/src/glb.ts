// Node-only adapter for tooling and the CLI. The browser/Three public entry does not import node:buffer or GLTFLoader.
import { Buffer } from 'node:buffer';
import { LoadingManager, MeshBasicMaterial, PropertyBinding } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bindHumanoid, createHumanoidClips, WALK_REF_MPS, CLIPS, type BoneMap } from './index.js';
import { readEnvelope } from './envelope.js';

export const MAX_INPUT = 64 * 1024 * 1024;
export async function prepareGlb(source: Buffer, profile?: BoneMap) {
  if (source.length > MAX_INPUT) throw new Error('Offline input exceeds 64 MiB.');
  const bytes = Uint8Array.from(source).buffer;
  const { doc, binStart } = readEnvelope(bytes, 2048, 1_000_000);
  const manager = new LoadingManager();
  manager.setURLModifier(() => {
    throw new Error('External resources are not allowed.');
  });
  // Inspect the real skins, weights and rest hierarchy with the same loader as the viewer.
  // A stand-in material is enough: never decode or re-encode a source image in the CLI.
  const loader = new GLTFLoader(manager).register(() => ({
    name: 'MotionInspectionMaterial',
    loadMaterial: async () => new MeshBasicMaterial(),
  }));
  const gltf = await loader.parseAsync(bytes, '');
  const rig = bindHumanoid(gltf.scene, profile);
  const roles = Object.fromEntries(Object.entries(rig.joints).map(([role, b]) => [role, b.sourceName]));
  const targetIndices = new Map<string, number>();
  for (const j of Object.values(rig.joints)) {
    const target = gltf.scene.getObjectByName(j.name),
      node = target && gltf.parser.associations.get(target)?.nodes;
    if (node === undefined || doc.nodes?.[node].matrix)
      throw new Error(`Joint “${j.sourceName}” needs an animatable glTF TRS node.`);
    targetIndices.set(j.name, node);
  }
  const embeddedClips = gltf.animations.map((c) => c.name);
  const conflicts = Object.values(CLIPS).filter((name) => embeddedClips.includes(name));
  return {
    roles,
    embeddedClips,
    conflicts,
    walkRefMps: WALK_REF_MPS,
    bake(): Buffer {
      const clips = createHumanoidClips(rig, gltf.animations);
      // Original data is immutable. Append float accessors AFTER the original padded BIN;
      // meshes, images, inverse bind matrices and any pre-existing samplers keep their offsets.
      const chunks = [source.subarray(binStart)],
        bufferViews = [...doc.bufferViews],
        accessors = [...doc.accessors];
      let offset = chunks[0].length;
      function append(array: Float32Array, type: 'SCALAR' | 'VEC3' | 'VEC4', width: number) {
        const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
        const bufferView = bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }) - 1;
        chunks.push(bytes);
        offset += bytes.length;
        const bounds = type === 'SCALAR' ? { min: [array[0]], max: [array[array.length - 1]] } : {};
        return (
          accessors.push({ bufferView, componentType: 5126, type, count: array.length / width, ...bounds }) -
          1
        );
      }
      const added = clips.map((clip) => {
        const channels = [],
          samplers = [];
        for (const track of clip.tracks) {
          const { nodeName, propertyName } = PropertyBinding.parseTrackName(track.name);
          const node = targetIndices.get(nodeName);
          if (node === undefined) throw new Error(`Unbound animation track: ${track.name}`);
          const rotation = propertyName === 'quaternion';
          if (!rotation && propertyName !== 'position') throw new Error(`Unsupported track: ${track.name}`);
          const input = append(track.times, 'SCALAR', 1),
            output = append(track.values, rotation ? 'VEC4' : 'VEC3', track.getValueSize());
          const sampler = samplers.push({ input, output, interpolation: 'LINEAR' }) - 1;
          channels.push({ sampler, target: { node, path: rotation ? 'rotation' : 'translation' } });
        }
        return { name: clip.name, channels, samplers };
      });
      const json = Buffer.from(
        JSON.stringify({
          ...doc,
          accessors,
          bufferViews,
          buffers: [{ ...doc.buffers[0], byteLength: offset }],
          animations: [...(doc.animations ?? []), ...added],
        })
      );
      const padded = Math.ceil(json.length / 4) * 4,
        header = Buffer.from(source.subarray(0, 20)),
        binHeader = Buffer.from(source.subarray(binStart - 8, binStart));
      header.writeUInt32LE(28 + padded + offset, 8);
      header.writeUInt32LE(padded, 12);
      binHeader.writeUInt32LE(offset);
      return Buffer.concat([header, json, Buffer.alloc(padded - json.length, 32), binHeader, ...chunks]);
    },
  };
}
