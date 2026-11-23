import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as T from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import {
  bindHumanoid,
  createHumanoidClips,
  createPoseClip,
  parseBoneMap,
  readBoneMap,
  ROLES,
} from '../dist/index.js';

// Independent, short T-pose character; a namespace, rolled joints and an unmapped spine
// helper. Each landmark has a real weighted vertex. Emulate GLTFLoader's original/runtime names.
function character({ custom = false, size = 0.64 } = {}) {
  const root = new T.Group(),
    bones = [],
    positions = [],
    indices = [],
    weights = [],
    byRole = {},
    map = { format: 'planwalk.humanoid-rig.v1', bones: {} };
  function add(role, alias, parent, x, y, z = 0) {
    const raw = custom ? `Studio:driver.${bones.length}` : `mixamorig:${alias}`;
    const b = new T.Bone();
    b.name = T.PropertyBinding.sanitizeNodeName(raw);
    b.userData.name = raw;
    const world = new T.Vector3(x, y, z).multiplyScalar(size);
    parent.add(b);
    b.position.copy(parent.worldToLocal(world.clone()));
    b.rotation.y = 0.27;
    b.updateWorldMatrix(true, false);
    if (role) {
      byRole[role] = b;
      map.bones[role] = raw;
    }
    positions.push(
      ...world
        .clone()
        .add(new T.Vector3(0, 0.008, 0.011))
        .toArray()
    );
    indices.push(bones.length, 0, 0, 0);
    weights.push(1, 0, 0, 0);
    bones.push(b);
    return b;
  }
  const hips = add('hips', 'Hips', root, 0, 0.99),
    spine = add(null, 'Spine', hips, 0, 1.15),
    chest = add('chest', 'Spine2', spine, 0, 1.35);
  add('head', 'Head', chest, 0, 1.62);
  for (const [side, s] of [
    ['left', 1],
    ['right', -1],
  ]) {
    const n = s === 1 ? 'Left' : 'Right';
    const a = add(side + 'UpperArm', n + 'Arm', chest, s * 0.18, 1.48),
      e = add(side + 'LowerArm', n + 'ForeArm', a, s * 0.45, 1.48);
    add(side + 'Hand', n + 'Hand', e, s * 0.69, 1.48, 0.01);
    const t = add(side + 'UpperLeg', n + 'UpLeg', hips, s * 0.09, 0.98),
      k = add(side + 'LowerLeg', n + 'Leg', t, s * 0.1, 0.53, 0.02);
    add(side + 'Foot', n + 'Foot', k, s * 0.11, 0.1, 0);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  g.setAttribute('skinIndex', new T.Uint16BufferAttribute(indices, 4));
  g.setAttribute('skinWeight', new T.Float32BufferAttribute(weights, 4));
  const m = new T.SkinnedMesh(g, new T.MeshBasicMaterial());
  m.name = 'Surface';
  root.add(m);
  root.updateMatrixWorld(true);
  m.bind(new T.Skeleton(bones));
  return { root, byRole, map, m, vertexIndex: bones.indexOf(byRole.rightHand) };
}

test('one role set drives a rolled, namespaced T-pose at different sizes; no template or root motion', () => {
  for (const size of [0.57, 1.2]) {
    const { root, byRole, vertexIndex } = character({ size });
    root.position.set(-3, 1, 5);
    root.rotation.y = 0.8;
    const template = Object.values(byRole).map((b) => b.quaternion.toArray());
    const rig = bindHumanoid(root),
      clips = createHumanoidClips(rig);
    assert.deepEqual(
      clips.map((c) => c.name),
      ['WelcomeWave', 'EasyIdle', 'HallwayWalk_IP']
    );
    assert.ok(clips.every((c) => c.validate()));
    const actor = clone(root),
      mesh = actor.getObjectByName('Surface'),
      mixer = new T.AnimationMixer(actor);
    const at = (role) =>
      actor.worldToLocal(actor.getObjectByName(rig.joints[role].name).getWorldPosition(new T.Vector3()));
    const vertex = () => {
      actor.updateMatrixWorld(true);
      return actor.worldToLocal(mesh.localToWorld(mesh.getVertexPosition(vertexIndex, new T.Vector3())));
    };
    mixer.clipAction(clips[0]).play();
    mixer.update(0);
    const low = at('rightHand'),
      v = vertex(),
      foot = at('rightFoot');
    assert.ok(low.y < 1.16 * size, 'T-pose arms relax before the wave');
    mixer.update(1.55);
    assert.ok(at('rightHand').y - low.y > 0.48 * size);
    assert.ok(vertex().y - v.y > 0.46 * size);
    assert.ok(foot.distanceTo(at('rightFoot')) < 0.00001);
    mixer.stopAllAction();
    mixer.clipAction(clips[2]).play();
    mixer.update(0);
    const left = at('leftFoot'),
      right = at('rightFoot'),
      dt = clips[2].duration / 4;
    mixer.update(dt);
    assert.ok(Math.abs(left.z - at('leftFoot').z - 1.2 * dt) < 0.003);
    assert.ok(Math.abs(left.y - at('leftFoot').y) < 0.003);
    assert.ok(at('rightFoot').y - right.y > 0.07 * size);
    assert.deepEqual(
      Object.values(byRole).map((b) => b.quaternion.toArray()),
      template
    );
    assert.deepEqual(actor.position.toArray(), [-3, 1, 5]);
  }
});

test('custom names bind by exact source name, via sidecar or scene extras; key a new semantic nod', () => {
  const { root, map, byRole } = character({ custom: true });
  assert.throws(
    () => bindHumanoid(root),
    (e) =>
      e.issues.some((s) => s.includes('hips: not recognized')) &&
      e.availableJoints.includes(map.bones.rightHand)
  );
  root.userData.planwalkHumanoid = map;
  const rig = bindHumanoid(root);
  assert.deepEqual(Object.keys(rig.joints), [...ROLES]);
  assert.equal(rig.joints.head.sourceName, map.bones.head);
  const nod = createPoseClip(rig, 'Nod', {
    head: [
      { time: 0, degrees: [0, 0, 0] },
      { time: 0.3, degrees: [17, 0, 0] },
      { time: 0.6, degrees: [0, 0, 0] },
    ],
  });
  const mixer = new T.AnimationMixer(root),
    before = byRole.head.quaternion.clone();
  mixer.clipAction(nod).play();
  mixer.update(0.3);
  assert.ok(Math.abs(before.angleTo(byRole.head.quaternion) - T.MathUtils.degToRad(17)) < 1e-5);
  mixer.update(0.3);
  assert.ok(before.angleTo(byRole.head.quaternion) < 0.001);
  assert.throws(
    () =>
      createPoseClip(rig, 'bad', {
        head: [
          { time: 0, degrees: [0, 0, 0] },
          { time: 0, degrees: [NaN, 0, 0] },
        ],
      }),
    /head:/
  );
  assert.throws(
    () => bindHumanoid(root, { ...map, bones: { ...map.bones, head: 'typo' } }),
    /head: joint “typo” not found/
  );
  assert.throws(
    () => bindHumanoid(root, { ...map, bones: { ...map.bones, rightHand: map.bones.leftHand } }),
    /already maps/
  );
  assert.throws(() => createHumanoidClips(rig, [new T.AnimationClip('EasyIdle')]), /already exists/);
});

test('ambiguities require an exact override; unsafe chains, weights, axes and bare bones fail early', () => {
  const { root, byRole, m } = character();
  const extra = new T.Bone();
  extra.name = 'RightHand_123';
  byRole.rightLowerArm.add(extra);
  m.skeleton.bones.push(extra);
  assert.throws(() => bindHumanoid(root), /inverse bind matrices/);
  m.skeleton.boneInverses.push(new T.Matrix4());
  assert.throws(() => bindHumanoid(root), /rightHand: ambiguous/);
  const map = { format: 'planwalk.humanoid-rig.v1', bones: { rightHand: 'mixamorig:RightHand' } };
  assert.ok(bindHumanoid(root, map));
  byRole.leftLowerArm.add(byRole.rightHand);
  assert.throws(() => bindHumanoid(root, map), /rightHand: must descend from rightLowerArm/);
  byRole.rightLowerArm.add(byRole.rightHand);
  byRole.rightLowerLeg.scale.x = 2;
  assert.throws(() => bindHumanoid(root, map), /uniform scale/);
  byRole.rightLowerLeg.scale.x = 1;
  byRole.hips.rotation.z = Math.PI;
  assert.throws(() => bindHumanoid(root, map), /upright Y-up/);
  m.geometry.getAttribute('skinWeight').setX(0, 0);
  assert.throws(() => bindHumanoid(root, map), /normalize weights/);
  assert.throws(() => bindHumanoid(new T.Group()), /No weighted skinned mesh/);
  assert.throws(() => parseBoneMap({ format: 'planwalk.humans.v1', actors: [] }), /not a motion take/);
  assert.throws(() => readBoneMap('{'), /not valid JSON/);
  assert.throws(() => parseBoneMap({ ...map, bones: { leftWing: 'cap' } }), /unknown role/);
});
