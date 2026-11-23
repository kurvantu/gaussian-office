import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bindHumanoid, createHumanoidClips } from '../dist/index.js';
import { prepareGlb } from '../dist/glb.js';

const fixture = readFileSync(new URL('../../../data/humans/Visitor.glb', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function split(bytes) {
  const end = 20 + bytes.readUInt32LE(12);
  return { doc: JSON.parse(bytes.subarray(20, end)), bin: bytes.subarray(end + 8) };
}
function changeJson(fn) {
  const { doc } = split(fixture);
  fn(doc);
  const json = Buffer.from(JSON.stringify(doc)),
    size = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.concat([
    fixture.subarray(0, 20),
    json,
    Buffer.alloc(size - json.length, 32),
    fixture.subarray(20 + fixture.readUInt32LE(12)),
  ]);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(size, 12);
  return bytes;
}

test('offline inspect and bake a custom rig; original BIN, skins and embedded clips survive round-trip', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'humanoid-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'Someone.glb'),
    output = join(dir, 'Someone-moving.glb'),
    profile = join(dir, 'bones.json');
  const raw = 'DCC:Palm.R 007',
    map = { format: 'planwalk.humanoid-rig.v1', bones: { rightHand: raw } };
  const bytes = changeJson((d) => {
    d.nodes.find((n) => n.name === 'Wrist_R').name = raw;
  });
  writeFileSync(input, bytes);
  writeFileSync(profile, JSON.stringify(map));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const missing = run('inspect', input);
  assert.notEqual(missing.status, 0);
  assert.ok(JSON.parse(missing.stderr).availableJoints.includes(raw));
  assert.equal(existsSync(output), false);
  const check = run('inspect', input, '--map', profile);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).roles.rightHand, raw);
  const ok = run('bake', input, output, '--map', profile);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readFileSync(input), bytes);
  const baked = readFileSync(output),
    a = split(bytes),
    b = split(baked);
  assert.deepEqual(b.bin.subarray(0, a.bin.length), a.bin);
  for (const k of ['skins', 'nodes', 'meshes', 'materials']) assert.deepEqual(b.doc[k], a.doc[k]);
  assert.deepEqual(b.doc.animations.slice(0, 3), a.doc.animations);
  assert.deepEqual(
    b.doc.animations.slice(3).map((a) => a.name),
    ['WelcomeWave', 'EasyIdle', 'HallwayWalk_IP']
  );
  const load = (b) => new GLTFLoader().parseAsync(Uint8Array.from(b).buffer, '');
  const src = await load(bytes),
    dst = await load(baked);
  const rig = bindHumanoid(src.scene, map),
    clips = createHumanoidClips(rig, src.animations),
    mixers = [src, dst].map((m) => new T.AnimationMixer(m.scene));
  for (const c of clips) {
    mixers[0].clipAction(c).play();
    mixers[1].clipAction(dst.animations.find((x) => x.name === c.name)).play();
    for (const phase of [0.1, 0.37, 0.88]) {
      mixers.forEach((m) => m.setTime(phase * c.duration));
      for (const role of ['hips', 'rightHand', 'leftFoot']) {
        const pos = (g) => g.scene.getObjectByName(rig.joints[role].name).getWorldPosition(new T.Vector3());
        assert.ok(pos(src).distanceTo(pos(dst)) < 0.00001);
      }
    }
    mixers.forEach((m) => m.stopAllAction());
  }
  assert.notEqual(run('bake', input, input, '--map', profile).status, 0);
  assert.deepEqual(readFileSync(input), bytes);
  assert.notEqual(run('bake', input, output, '--map', profile).status, 0);
  assert.deepEqual(readFileSync(output), baked);
  const again = await prepareGlb(baked, map);
  assert.equal(again.conflicts.length, 3);
  assert.throws(() => again.bake(), /already exists/);
});

test('offline preflight refuses external resources and unsupported encodings', async () => {
  await assert.rejects(
    prepareGlb(
      changeJson((d) => {
        d.buffers[0].uri = 'sidecar.bin';
      })
    ),
    /External resources/
  );
  await assert.rejects(
    prepareGlb(
      changeJson((d) => {
        d.extensionsRequired = ['KHR_draco_mesh_compression'];
      })
    ),
    /Unsupported extension/
  );
  await assert.rejects(prepareGlb(Buffer.from('not a model')), /binary glTF/);
});

test('embedded scene map works without a sidecar; matrix-only animation targets are identified', async () => {
  const raw = 'Custom:Grip.L';
  const bytes = changeJson((d) => {
    d.nodes.find((n) => n.name === 'Wrist_L').name = raw;
    d.scenes[0].extras = {
      planwalkHumanoid: { format: 'planwalk.humanoid-rig.v1', bones: { leftHand: raw } },
    };
  });
  assert.equal((await prepareGlb(bytes)).roles.leftHand, raw);
  const matrixTarget = changeJson((d) => {
    const n = d.nodes.find((n) => n.name === 'Wrist_L');
    n.matrix = new T.Matrix4().makeTranslation(...n.translation).toArray();
    delete n.translation;
  });
  await assert.rejects(prepareGlb(matrixTarget), /Wrist_L.*TRS node/);
});
