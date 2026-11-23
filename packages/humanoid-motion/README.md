# Humanoid Motion for Three.js

Generate a greeting, an idle and an in-place walk on **your character’s own skeleton**, or author a new action using anatomical roles instead of hard-coded node names. The library snapshots the rest transforms, compensates for joint roll and arm spread, and sizes the walking cycle from leg lengths. It has no dependency on React, Spark, PlanWalk's assets, or a running viewer.

**Start here:** [GLB requirements, role table and Blender handoff](GLB-CONTRACT.md). This works on *already skinned bipeds*, not arbitrary meshes.

## Try an actual file

From the PlanWalk checkout, with Node 22.12+ and `npm ci`:

```sh
npm run --silent humanoid -- inspect data/humans/Visitor.glb
mkdir -p exports
npm run --silent humanoid -- bake data/humans/Visitor.glb exports/Visitor-with-greeting.glb
```

`Visitor.glb` is a different rig from `man-rig.glb`: it has 15 bones, four LOD meshes and three embedded clips. The baked file has those **same three plus three new ones**. No need to rename your file to a library filename. For custom bone names:

```sh
npm run --silent humanoid -- inspect MyHuman.glb --map MyHuman.rig.json
npm run --silent humanoid -- bake MyHuman.glb MyHuman-moving.glb --map MyHuman.rig.json
```

`inspect` writes nothing. It prints JSON with resolved roles, existing clips, name conflicts and gait speed. On failure it exits nonzero with actionable `issues`; missing/ambiguous mappings also report `availableJoints`. `bake` targets the original **glTF node indices** and appends standard animation channels/accessors after the original BIN payload. No mesh or texture re-encoding, no clobbering embedded clips, inputs or existing output files. The parent output directory must already exist.

## Use the library in another project

This is a local, packable **ES module with TypeScript declarations**, not a published registry package. From the checkout:

```sh
npm ci
mkdir -p exports
npm pack ./packages/humanoid-motion --pack-destination exports
```

Copy the resulting `planwalk-humanoid-motion-1.0.0.tgz` to your project, then:

```sh
npm install three@0.180.0 ./planwalk-humanoid-motion-1.0.0.tgz
# TypeScript projects also need the matching Three declarations:
npm install -D @types/three@^0.180.0
# The installed tarball includes the standalone CLI:
npx humanoid-motion inspect MyHuman.glb
```

```js
import { AnimationMixer, LoopOnce } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bindHumanoid, createHumanoidClips, CLIPS } from '@planwalk/humanoid-motion';

const gltf = await new GLTFLoader().loadAsync('/models/MyHuman.glb');
const rig = bindHumanoid(gltf.scene); // or bindHumanoid(gltf.scene, myBoneMap)
const clips = createHumanoidClips(rig, gltf.animations); // NEW clips, no mutations
const mixer = new AnimationMixer(gltf.scene);
const action = (name) => mixer.clipAction(clips.find(c => c.name === name));
const wave = action(CLIPS.wave).setLoop(LoopOnce, 1);
mixer.addEventListener('finished', e => { if (e.action === wave) action(CLIPS.idle).play(); });
wave.play();
// Add gltf.scene to your scene. Call mixer.update(deltaSeconds) in your render loop.
```

| Generated clip | Use |
| --- | --- |
| `WelcomeWave` | 3.6 s one-shot with a raised right hand and planted feet. |
| `EasyIdle` | 4 s breathing loop. The wave starts/ends at its opening pose. |
| `HallwayWalk_IP` | Two-step loop. Translate the actor container yourself at `WALK_REF_MPS` (1.2 m/s at playback rate 1). The hips bob, but the clip does not translate the actor across the floor. Shorter legs get a shorter stride and cycle. |

### Author another action

```js
import { createPoseClip } from '@planwalk/humanoid-motion';
const nod = createPoseClip(rig, 'Yes', {
  head: [
    { time: 0,   degrees: [0, 0, 0] },
    { time: 0.3, degrees: [14, 0, 0] },
    { time: 0.7, degrees: [0, 0, 0] }
  ]
});
mixer.stopAllAction();
mixer.clipAction(nod).setLoop(LoopOnce, 1).play();
```

Key one or several of the [15 roles](GLB-CONTRACT.md#the-15-required-roles) in parallel. Times are seconds, strictly increasing from zero per track. XYZ degree offsets (−360 to +360) are expressed in the **rest model's axes**, converted to the joint’s local bind frame; animated parent rotations compose hierarchically. Keys interpolate as quaternions. This is not world-space IK or reinterpretation of another character's clip. For a loop, match the first and last poses.

### API and ownership

- `bindHumanoid(root, profile?) → HumanoidRig`: resolves roles using actual skin palettes, weights and ancestors. Pass the model container above the skeleton, in the unanimated rest pose. The snapshot records source names, runtime track names, and rest transforms. Treat it as read-only; bind again for a different model.
- `parseBoneMap(object)` / `readBoneMap(jsonText) → BoneMap`: validate a [v1 map](bone-map.schema.json). `ROLES` is the ordered list of role names. `RigError.issues` contains the diagnostics; `availableJoints` is provided on naming failures.
- `createHumanoidClips(rig, existingClips = []) → AnimationClip[]`: returns **only** the three generated clips. Pass existing animations to reject name collisions. `createPoseClip(rig, name, tracks) → AnimationClip` authors your own named rotation clip.
- Binding and authoring do not start playback or alter the rest pose, geometry, materials, or embedded clips. A caller owns its mixer and resources. Clips can be shared by `SkeletonUtils.clone` instances of the **same** rig; use one mixer per instance and rebuild clips for a different rig. Stop actions and uncache the mixer root when done.

For a Node asset pipeline, use the same adapter as the CLI; it is separate from the browser entry:

```js
import { readFile, writeFile } from 'node:fs/promises';
import { prepareGlb } from '@planwalk/humanoid-motion/node';
const human = await prepareGlb(await readFile('MyHuman.glb')); // optional second argument: bone map
console.log(human.roles, human.embeddedClips);
await writeFile('MyHuman-moving.glb', human.bake(), { flag: 'wx' });
```

**In Studio:** **Insert human → Local GLB → Generate humanoid motion** uses this same package. Normal import remains available for static props or embedded animations. A generated character greets and idles by default. For a single selected file, **Motion JSON → Use walk & greet take** fills in its exact filename. A bone map describes anatomy; the optional motion take describes placement and playback.
