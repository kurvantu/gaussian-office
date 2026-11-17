import * as THREE from 'three';
import { ExtSplats, SplatMesh, SplatSkinning, SplatSkinningMode } from '@sparkjsdev/spark';
import type { FloorplanData, LightingPreset, Point2D } from '../types/floorplan';

export type RenderMethod = 'gaussian' | 'triangles';
export type SplatQuality = 'balanced' | 'fine';

export interface GaussianRepresentation {
  mesh: SplatMesh;
  count: number;
  ready: Promise<void>;
  update: () => void;
  setEnabled: (enabled: boolean) => void;
  setLighting: (preset: LightingPreset) => void;
  dispose: () => void;
}

interface TexturePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const texturePixels = new WeakMap<THREE.Texture, TexturePixels | null>();

function readTexture(texture: THREE.Texture): TexturePixels | null {
  if (texturePixels.has(texture)) return texturePixels.get(texture)!;
  let result: TexturePixels | null = null;
  const image = texture.image;
  if (image instanceof HTMLCanvasElement) {
    const context = image.getContext('2d');
    if (context) result = context.getImageData(0, 0, image.width, image.height);
  }
  texture.updateMatrix();
  texturePixels.set(texture, result);
  return result;
}

function insidePolygon(x: number, z: number, polygon: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Bake the editable surfaces into oriented, anisotropic Gaussians, not point sprites. */
export function createGaussianRepresentation(
  source: THREE.Group,
  kind: 'architecture' | 'guide',
  quality: SplatQuality,
  floorplan?: FloorplanData,
): GaussianRepresentation {
  source.updateWorldMatrix(true, true);
  const spacing = kind === 'guide'
    ? quality === 'fine' ? 0.0045 : 0.0065
    : quality === 'fine' ? 0.065 : 0.10;
  const packed = new ExtSplats();
  const sourceMeshes: THREE.Mesh[] = [];
  const bones: THREE.Object3D[] = [];
  const boneIds = new Map<THREE.Object3D, number>();
  const boneRanges: { start: number; end: number; bone: number }[] = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const worldNormal = new THREE.Vector3();
  const na = new THREE.Vector3();
  const nb = new THREE.Vector3();
  const nc = new THREE.Vector3();
  const center = new THREE.Vector3();
  const worldPoint = new THREE.Vector3();
  const scales = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const color = new THREE.Color();
  const sampledColor = new THREE.Color();
  const uv = new THREE.Vector2();
  const forward = new THREE.Vector3(0, 0, 1);
  const keyLight = new THREE.Vector3(0.45, 0.82, 0.35).normalize();
  const meshToBone = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const worldNormalMatrix = new THREE.Matrix3();

  const obstacles = floorplan?.furniture.filter((f) => f.type !== 'rug').map((f) => ({
    x: f.x, z: f.z, cos: Math.cos(f.rotation), sin: Math.sin(f.rotation),
    hx: f.width * 0.5, hz: f.depth * 0.5,
  })) ?? [];

  source.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object.userData.keepRaster) return;
    sourceMeshes.push(object);
    if (object.userData.gaussianOmit) return;

    const geometry = object.geometry as THREE.BufferGeometry;
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const uvs = geometry.getAttribute('uv');
    const indices = geometry.index;
    if (!positions) return;

    let bone = object.parent ?? source;
    if (kind === 'architecture') {
      while (bone.parent && bone.parent !== source && bone !== source) bone = bone.parent;
      if (!(bone instanceof THREE.Group)) bone = source;
    }
    let boneIndex = boneIds.get(bone);
    if (boneIndex === undefined) {
      boneIndex = bones.length;
      if (boneIndex >= 256) throw new Error('The Gaussian skeleton exceeds Spark\'s 256-bone limit.');
      boneIds.set(bone, boneIndex);
      bones.push(bone);
    }

    // Samples stay in each joint's local frame. Only its bone matrix changes at runtime.
    meshToBone.copy(bone.matrixWorld).invert().multiply(object.matrixWorld);
    normalMatrix.getNormalMatrix(meshToBone);
    worldNormalMatrix.getNormalMatrix(bone.matrixWorld);
    const firstSplat = packed.numSplats;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const triangleCount = (indices?.count ?? positions.count) / 3;
    const floorMask = object.userData.gaussianFloorMask as Point2D[][] | undefined;
    let sampleSpacing = spacing;
    if (kind === 'guide') {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const size = geometry.boundingBox!.clone().applyMatrix4(meshToBone).getSize(new THREE.Vector3());
      const surfaceEstimate = 2 * (size.x * size.y + size.y * size.z + size.z * size.x);
      sampleSpacing = Math.min(spacing, Math.sqrt(surfaceEstimate / 80));
    }

    for (let triangle = 0; triangle < triangleCount; triangle++) {
      const vertexOffset = triangle * 3;
      let ia = indices ? indices.getX(vertexOffset) : vertexOffset;
      let ib = indices ? indices.getX(vertexOffset + 1) : vertexOffset + 1;
      let ic = indices ? indices.getX(vertexOffset + 2) : vertexOffset + 2;
      a.fromBufferAttribute(positions, ia).applyMatrix4(meshToBone);
      b.fromBufferAttribute(positions, ib).applyMatrix4(meshToBone);
      c.fromBufferAttribute(positions, ic).applyMatrix4(meshToBone);

      // Scan across the longest edge so thin trims never allocate a huge square sample grid.
      const ab2 = a.distanceToSquared(b);
      const bc2 = b.distanceToSquared(c);
      const ca2 = c.distanceToSquared(a);
      if (bc2 > ab2 && bc2 >= ca2) {
        const t = ia; ia = ib; ib = ic; ic = t;
      } else if (ca2 > ab2 && ca2 > bc2) {
        const t = ic; ic = ib; ib = ia; ia = t;
      }
      a.fromBufferAttribute(positions, ia).applyMatrix4(meshToBone);
      b.fromBufferAttribute(positions, ib).applyMatrix4(meshToBone);
      c.fromBufferAttribute(positions, ic).applyMatrix4(meshToBone);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      faceNormal.crossVectors(ab, ac);
      const doubleArea = faceNormal.length();
      const base = ab.length();
      if (doubleArea < 1e-11 || base < 1e-8) continue;
      // Area-weighted thinning avoids one expensive Gaussian per tiny source triangle.
      // Small anatomical features retain a minimum sampling density of their own.
      if (kind === 'guide') {
        const coverage = doubleArea * 0.5 / (sampleSpacing * sampleSpacing);
        const threshold = (Math.imul(triangle + 1, 1597334677) >>> 0) / 4294967296;
        if (coverage < threshold) continue;
      }
      faceNormal.divideScalar(doubleArea);
      const height = doubleArea / base;

      if (normals) {
        na.fromBufferAttribute(normals, ia).applyMatrix3(normalMatrix).normalize();
        nb.fromBufferAttribute(normals, ib).applyMatrix3(normalMatrix).normalize();
        nc.fromBufferAttribute(normals, ic).applyMatrix3(normalMatrix).normalize();
      }

      let material = materials[0] as THREE.MeshStandardMaterial;
      if (materials.length > 1) {
        const group = geometry.groups.find((g) => vertexOffset >= g.start && vertexOffset < g.start + g.count);
        material = materials[group?.materialIndex ?? 0] as THREE.MeshStandardMaterial;
      }
      const albedo = material.color ?? new THREE.Color(0xffffff);
      const map = material.map;
      const pixels = map ? readTexture(map) : null;
      const rows = Math.max(1, Math.ceil(height / sampleSpacing));
      const dy = height / rows;

      for (let row = 0; row < rows; row++) {
        const v = (row + 0.5) / rows;
        const rowWidth = base * (1 - v);
        const columns = Math.max(1, Math.ceil(rowWidth / sampleSpacing));
        const dx = rowWidth / columns;

        for (let column = 0; column < columns; column++) {
          const u = (column + 0.5) / columns;
          const wa = (1 - v) * (1 - u);
          const wb = (1 - v) * u;
          const wc = v;
          center.copy(a).multiplyScalar(wa).addScaledVector(b, wb).addScaledVector(c, wc);
          worldPoint.copy(center).applyMatrix4(bone.matrixWorld);

          // The terrace must not wash out the room textures with a second coplanar surface.
          if (floorMask && worldPoint.y > -0.02 && floorMask.some((p) => insidePolygon(worldPoint.x, worldPoint.z, p))) continue;

          if (normals) {
            normal.copy(na).multiplyScalar(wa).addScaledVector(nb, wb).addScaledVector(nc, wc).normalize();
          } else normal.copy(faceNormal);
          quaternion.setFromUnitVectors(forward, normal);
          const radius = Math.max(dx, dy) * 0.82;
          // A millimeter-thin floor prevents its Gaussian volume from veiling the toes.
          const isFloor = kind === 'architecture' && Math.abs(normal.y) > 0.98 && Math.abs(worldPoint.y) < 0.02;
          scales.set(radius, radius, isFloor ? 0.00015 : Math.max(0.00006, Math.min(dx, dy) * 0.11));
          center.addScaledVector(normal, Math.min(dx, dy) * 0.018);

          color.copy(albedo);
          if (map && pixels && uvs) {
            uv.set(
              uvs.getX(ia) * wa + uvs.getX(ib) * wb + uvs.getX(ic) * wc,
              uvs.getY(ia) * wa + uvs.getY(ib) * wb + uvs.getY(ic) * wc,
            );
            map.transformUv(uv);
            const px = Math.min(pixels.width - 1, Math.max(0, Math.floor(uv.x * pixels.width)));
            const py = Math.min(pixels.height - 1, Math.max(0, Math.floor(uv.y * pixels.height)));
            const offset = (py * pixels.width + px) * 4;
            sampledColor.setRGB(pixels.data[offset] / 255, pixels.data[offset + 1] / 255, pixels.data[offset + 2] / 255, THREE.SRGBColorSpace);
            color.multiply(sampledColor);
          }

          // Procedural splats have baked surface shading, rather than photograph-trained radiance.
          worldNormal.copy(normal).applyMatrix3(worldNormalMatrix).normalize();
          let shade = 0.58 + Math.max(0, worldNormal.y) * 0.20 + Math.max(0, worldNormal.dot(keyLight)) * 0.22;
          if (kind === 'guide') shade = 0.69 + Math.max(0, normal.y) * 0.12 + Math.max(0, normal.z) * 0.19;
          if (kind === 'architecture' && object.userData.roomId && worldNormal.y > 0.8) {
            for (const ob of obstacles) {
              const rx = worldPoint.x - ob.x;
              const rz = worldPoint.z - ob.z;
              const lx = rx * ob.cos - rz * ob.sin;
              const lz = rx * ob.sin + rz * ob.cos;
              const distance = Math.hypot(Math.max(0, Math.abs(lx) - ob.hx), Math.max(0, Math.abs(lz) - ob.hz));
              if (distance < 0.25) shade *= 0.72 + Math.min(1, distance / 0.25) * 0.28;
            }
          }
          color.multiplyScalar(shade);
          if (material.emissive) {
            sampledColor.copy(material.emissive).multiplyScalar((material.emissiveIntensity ?? 0) * 0.2);
            color.add(sampledColor);
          }
          color.convertLinearToSRGB();
          const opacity = material.transparent ? Math.min(0.95, material.opacity * 0.70) : 0.97;
          packed.pushSplat(center, scales, quaternion, opacity, color);
        }
      }
    }
    boneRanges.push({ start: firstSplat, end: packed.numSplats, bone: boneIndex });
  });

  // ExtSplats.pushSplat writes CPU arrays; initialize them explicitly to create GPU textures.
  packed.initialize({ extArrays: packed.extArrays, numSplats: packed.numSplats });
  const mesh = new SplatMesh({ extSplats: packed, covSplats: true, editable: false, raycastable: false });
  mesh.name = kind === 'guide' ? 'Elena_GaussianSplats' : 'Architecture_GaussianSplats';
  const skinning = new SplatSkinning({
    mesh, numSplats: packed.numSplats, numBones: Math.max(1, bones.length),
    mode: SplatSkinningMode.LINEAR_BLEND,
  });
  const identity = new THREE.Matrix4();
  bones.forEach((_, index) => skinning.setRestMatrix(index, identity));
  for (const range of boneRanges) {
    for (let index = range.start; index < range.end; index++) {
      skinning.skinData[index * 4] = (range.bone << 8) | 255;
    }
  }
  skinning.skinTexture.needsUpdate = true;
  mesh.skinning = skinning;
  mesh.updateGenerator();

  let enabled = false;
  let disposed = false;
  const previousMatrices = bones.map(() => new THREE.Matrix4().makeScale(0, 0, 0));
  const update = () => {
    if (disposed || !enabled) return;
    source.updateWorldMatrix(true, true);
    let changed = false;
    bones.forEach((bone, index) => {
      const previous = previousMatrices[index];
      const current = bone.matrixWorld;
      if (current.elements.some((value, i) => Math.abs(value - previous.elements[i]) > 0.000001)) {
        skinning.setBoneMatrix(index, current);
        previous.copy(current);
        changed = true;
      }
    });
    if (changed) skinning.updateBones();
  };

  return {
    mesh,
    count: packed.numSplats,
    ready: mesh.initialized.then(() => undefined),
    update,
    setEnabled: (next) => {
      enabled = next;
      mesh.visible = next;
      sourceMeshes.forEach((m) => m.layers.set(next ? 1 : 0));
      if (next) update();
    },
    setLighting: (preset) => {
      mesh.recolor.setRGB(1, preset === 'golden' ? 0.94 : 1, preset === 'golden' ? 0.83 : 1);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      sourceMeshes.forEach((m) => m.layers.set(0));
      mesh.removeFromParent();
      skinning.skinTexture.dispose();
      skinning.boneTexture.dispose();
      mesh.dispose();
    },
  };
}