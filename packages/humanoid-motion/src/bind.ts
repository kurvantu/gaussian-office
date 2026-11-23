import * as T from 'three';
import {
  aliases,
  normalizedName,
  parseBoneMap,
  RigError,
  ROLES,
  type BoneMap,
  type Role,
} from './profile.js';

type Slots<A> = Record<Role, A>;
export interface RestJoint {
  /** Original GLB name (for maps) and unique Three.js binding name (for clone-safe tracks). */
  sourceName: string;
  name: string;
  position: T.Vector3;
  rotation: T.Quaternion; // in the model container's space
  localRotation: T.Quaternion;
  localPosition: T.Vector3;
}
export interface HumanoidRig {
  readonly joints: Readonly<Slots<RestJoint>>;
  /** One metre up, expressed in the pelvis parent's coordinate system. */
  readonly hipsUp: T.Vector3;
}
const parentRole: Partial<Slots<Role>> = {
  chest: 'hips',
  head: 'chest',
  leftUpperArm: 'chest',
  rightUpperArm: 'chest',
  leftLowerArm: 'leftUpperArm',
  rightLowerArm: 'rightUpperArm',
  leftHand: 'leftLowerArm',
  rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips',
  rightUpperLeg: 'hips',
  leftLowerLeg: 'leftUpperLeg',
  rightLowerLeg: 'rightUpperLeg',
  leftFoot: 'leftLowerLeg',
  rightFoot: 'rightLowerLeg',
};
const sourceName = (b: T.Bone) => (typeof b.userData.name === 'string' ? b.userData.name : b.name);
const fail = (message: string): never => {
  throw new RigError(message);
};

/** Bind at rest, before starting a mixer. Only joints of an actual weighted skin (or their bone parents)
 * can satisfy roles. The result is a snapshot; no skeleton, geometry or animation is changed. */
export function bindHumanoid(root: T.Object3D, profile?: BoneMap): HumanoidRig {
  if (root instanceof T.Bone) throw new RigError('Pass the model container above the skeleton, not a bone.');
  const map = profile ?? root.userData.planwalkHumanoid;
  const overrides = map === undefined ? {} : parseBoneMap(map).bones;
  const nodes = new Set<T.Object3D>(),
    weighted = new Set<T.Bone>(),
    candidates = new Set<T.Bone>();
  const trackNames = new Map<string, number>();
  root.traverse((n) => {
    nodes.add(n);
    trackNames.set(n.name, (trackNames.get(n.name) ?? 0) + 1);
  });
  for (const mesh of nodes) {
    if (!(mesh instanceof T.SkinnedMesh)) continue;
    const palette = mesh.skeleton?.bones;
    const weights = mesh.geometry.getAttribute('skinWeight'),
      indices = mesh.geometry.getAttribute('skinIndex');
    if (
      !palette?.length ||
      !weights ||
      !indices ||
      weights.count !== mesh.geometry.attributes.position?.count ||
      indices.count !== weights.count ||
      weights.itemSize !== 4 ||
      indices.itemSize !== 4
    )
      fail(`Skin “${mesh.name}”: expected JOINTS_0 and WEIGHTS_0 for every vertex.`);
    const inverses = mesh.skeleton.boneInverses;
    if (
      inverses.length !== palette.length ||
      inverses.some((m) => {
        const det = m?.determinant();
        return !Number.isFinite(det) || det === 0;
      })
    )
      fail(`Skin “${mesh.name}”: invalid inverse bind matrices. Re-export the rest skin.`);
    for (const b of palette) {
      if (!nodes.has(b)) fail(`Skin “${mesh.name}”: joints must be inside the selected scene.`);
      for (let n: T.Object3D | null = b; n && nodes.has(n) && !candidates.has(n as T.Bone); n = n.parent)
        if (n instanceof T.Bone) candidates.add(n);
    }
    for (let i = 0; i < weights.count; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const w = weights.getComponent(i, k);
        if (w === 0) continue;
        const b = palette[indices.getComponent(i, k)];
        if (!b || !Number.isFinite(w) || w < 0)
          fail(`Skin “${mesh.name}”: invalid weight/joint at vertex ${i}.`);
        sum += w;
        weighted.add(b);
      }
      if (Math.abs(sum - 1) > 0.02) fail(`Skin “${mesh.name}”: normalize weights at vertex ${i}.`);
    }
  }
  if (!weighted.size) fail('No weighted skinned mesh. Bind the human mesh to a deform skeleton first.');
  const bones = {} as Slots<T.Bone>,
    issues: string[] = [];
  for (const role of ROLES) {
    const exact = overrides[role];
    let hits: T.Bone[] = [];
    if (exact !== undefined) hits = [...candidates].filter((b) => sourceName(b) === exact);
    else
      for (const tier of aliases(role)) {
        hits = [...candidates].filter((b) => tier.includes(normalizedName(sourceName(b))));
        if (hits.length) break;
      }
    if (!hits.length)
      issues.push(
        `${role}: ${exact === undefined ? 'not recognized; specify its source joint in a bone map' : `joint “${exact}” not found in the skin`}.`
      );
    else if (hits.length > 1)
      issues.push(`${role}: ambiguous (${hits.map(sourceName).join(', ')}); map one uniquely named joint.`);
    else bones[role] = hits[0];
  }
  if (issues.length) {
    const error = new RigError(...issues);
    error.availableJoints = [...candidates].map(sourceName).sort();
    throw error;
  }
  const driven = new Set<T.Object3D>();
  for (const b of weighted)
    for (let n: T.Object3D | null = b; n && nodes.has(n) && !driven.has(n); n = n.parent) driven.add(n);
  const byBone = new Map<T.Object3D, Role>();
  for (const role of ROLES) {
    const b = bones[role],
      other = byBone.get(b);
    if (other) issues.push(`${role}: “${sourceName(b)}” already maps to ${other}.`);
    byBone.set(b, role);
    if (!b.matrixAutoUpdate) issues.push(`${role}: enable matrixAutoUpdate to animate this joint's TRS.`);
    if (!driven.has(b)) issues.push(`${role}: “${sourceName(b)}” does not drive any weighted vertices.`);
    if (!b.name || T.PropertyBinding.sanitizeNodeName(b.name) !== b.name || trackNames.get(b.name) !== 1)
      issues.push(`${role}: needs a unique, track-safe runtime node name (load with GLTFLoader).`);
  }
  for (const role of ROLES) {
    let p = bones[role].parent;
    while (p && !byBone.has(p)) p = p.parent;
    if ((p ? byBone.get(p) : undefined) !== parentRole[role])
      issues.push(`${role}: must descend from ${parentRole[role] ?? 'the rig root'} (helpers are allowed).`);
  }
  if (issues.length) throw new RigError(...issues);
  const underHips = new Set<T.Object3D>();
  bones.hips.traverse((n) => underHips.add(n));
  if ([...weighted].some((b) => !underHips.has(b)))
    fail('Expected one humanoid: all weighted joints must descend from the mapped hips.');
  for (const n of driven) {
    const { x, y, z } = n.scale;
    if (
      ![x, y, z, ...n.position.toArray(), ...n.quaternion.toArray()].every(Number.isFinite) ||
      Math.min(x, y, z) <= 0 ||
      Math.max(x, y, z) / Math.min(x, y, z) > 1.001 ||
      Math.abs(n.quaternion.lengthSq() - 1) > 0.001
    )
      fail(
        `Joint path “${n.name}”: apply finite transforms with positive uniform scale (no mirroring or shear).`
      );
  }
  root.updateWorldMatrix(true, true);
  const unrotate = root.getWorldQuaternion(new T.Quaternion()).invert(),
    joints = {} as Slots<RestJoint>;
  for (const role of ROLES) {
    const b = bones[role];
    joints[role] = {
      name: b.name,
      sourceName: sourceName(b),
      position: root.worldToLocal(b.getWorldPosition(new T.Vector3())),
      rotation: unrotate.clone().multiply(b.getWorldQuaternion(new T.Quaternion())).normalize(),
      localPosition: b.position.clone(),
      localRotation: b.quaternion.clone(),
    };
  }
  const at = (r: Role) => joints[r].position;
  if (
    !(
      at('head').y > at('chest').y &&
      at('chest').y > at('hips').y &&
      at('leftUpperArm').x > at('rightUpperArm').x &&
      at('leftUpperLeg').x > at('rightUpperLeg').x
    )
  )
    fail('Expected upright Y-up, facing +Z, with anatomical left on +X. Check axes and left/right mapping.');
  const stature = at('head').y - Math.min(at('leftFoot').y, at('rightFoot').y);
  if (!(stature >= 0.35 && stature <= 2.6))
    fail('Rig scale: head-to-foot pivot height must be 0.35–2.6 metres. Apply unit conversion at export.');
  for (const side of ['left', 'right'] as const) {
    const thigh = at(`${side}UpperLeg`),
      knee = at(`${side}LowerLeg`),
      ankle = at(`${side}Foot`),
      elbow = at(`${side}LowerArm`);
    if (
      !(
        thigh.y - knee.y > 0.02 &&
        knee.y - ankle.y > 0.02 &&
        Math.abs(thigh.z - knee.z) < thigh.y - knee.y &&
        Math.abs(knee.z - ankle.z) < knee.y - ankle.y
      )
    )
      fail(`${side} leg: export a standing rest pose with separate hip, knee and ankle pivots in metres.`);
    if (elbow.distanceTo(at(`${side}UpperArm`)) < 0.02 || elbow.distanceTo(at(`${side}Hand`)) < 0.02)
      fail(`${side} arm: upper arm, elbow and hand need separate rest pivots in metres.`);
  }
  const upPoint = root.localToWorld(
    at('hips')
      .clone()
      .add(new T.Vector3(0, 1, 0))
  );
  return { joints, hipsUp: bones.hips.parent!.worldToLocal(upPoint).sub(bones.hips.position) };
}
