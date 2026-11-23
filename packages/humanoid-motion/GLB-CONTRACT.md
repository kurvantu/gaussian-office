# Humanoid GLB contract · v1

**Can my character move?** It must already be a **skinned, upright biped**. A mesh that looks human, a collection of rigid body parts, or bones with no skin weights is not enough. No embedded animations are required. The engine generates actions on the target's rest hierarchy; it does not auto-rig a mesh or transfer arbitrary motion capture.

## Artist handoff

1. **Frame and units.** Export in **metres**, glTF **+Y up, +Z forward**. The character's anatomical left is **+X**. For the Studio put the origin on the floor between the feet. Apply unit/axis conversions without breaking the inverse bind matrices. The engine accepts 0.35–2.6 m between the head pivot and the lower foot pivot; Studio also checks the *rendered* height (see below).
2. **Rest pose.** Use a standing T-, A-, or relaxed lowered-arm bind pose, legs extended approximately downward, knees bending toward +Z. Head above chest above hips; distinct shoulder/elbow/wrist and hip/knee/ankle pivots. Hands should follow the forearm, palms down in a T-pose or inward in a relaxed pose. The engine measures segment directions and lengths, not the mesh silhouette. A seated, twisted, crossed-limb or mirrored bind is not a supported reference pose.
3. **Skin.** Export one character with a connected deform hierarchy. Body, clothing and LOD meshes may share the same bones. Use valid `skins[].joints`, inverse binds where needed, `JOINTS_0` and normalized `WEIGHTS_0` (four slots per vertex, zero unused weights). All weighted joints must be the hips or descendants of the hips. Each required role must affect some vertices, directly or through descendants. Extra fingers, twist bones, clavicles, neck and spine bones may remain. No second independent skeleton.
4. **Transforms.** Use finite translation/rotation/scale on joint paths, normalized quaternions and **positive, uniform scale**. No reflected bones, nonuniform scaling, shear or constraint/control-rig dependency at playback. In the GLB use TRS, not a `matrix`, on the joints to be animated. Set limb roll as needed; the engine retains local bind orientations.
5. **File.** Export **glTF 2.0 Binary (`.glb`)**, one scene, one embedded BIN buffer, triangle meshes. Embed any images; do not reference sidecars or URLs. For this toolchain use dense buffer-backed accessors; no Draco, Meshopt *compressed input*, KTX2, or external decoders. Core glTF, `KHR_materials_unlit`, `KHR_texture_transform` and `KHR_mesh_quantization` are accepted. Blender users: export the mesh **and** its deform armature with skinning, not just the visible mesh. Check orientation and scale *in the exported GLB*.

## The 15 required roles

Roles are **anatomy, not mandatory bone names**. Each maps to one distinct joint. “Parent” below means the nearest **mapped ancestor**; intermediate helper bones are allowed and are left at their rest transforms.

| Role(s) | Mapped parent | Examples of source joint names |
| --- | --- | --- |
| `hips` | none; an unmapped armature root is OK | `Hips`, `Pelvis`, `Hips_66` |
| `chest` | hips | `Chest`, `Spine2`, `Spine2_53` |
| `head` | chest | `Head`, `Head_3` |
| `leftUpperArm`, `rightUpperArm` | chest | `LeftArm` / `RightArm`, `upper_arm.L` / `.R` |
| `leftLowerArm`, `rightLowerArm` | corresponding upper arm | `LeftForeArm` / `RightForeArm`, `Elbow_L` / `_R` |
| `leftHand`, `rightHand` | corresponding lower arm | `LeftHand` / `RightHand`, `Wrist_L` / `_R` |
| `leftUpperLeg`, `rightUpperLeg` | hips | `LeftUpLeg` / `RightUpLeg`, `thigh.L` / `.R` |
| `leftLowerLeg`, `rightLowerLeg` | corresponding upper leg | `LeftLeg` / `RightLeg`, `shin.L` / `.R` |
| `leftFoot`, `rightFoot` | corresponding lower leg | `LeftFoot` / `RightFoot`, `Ankle_L` / `_R` |

Map the upper-arm pivot that moves the humerus, not the clavicle. Map the foot that turns at the ankle, not the toe. Choose a chest above the pelvis and ancestral to both arms and the head. The binder checks the skin and hierarchy; it cannot infer the anatomical front of a mesh or repair bad weights.

### Custom names: a bone map, not a motion take

Automatic matching uses anatomical names, ignoring case, separators, namespaces (e.g. `mixamorig:LeftForeArm`), Blender `DEF-` and exported `_number` suffixes. The chest matcher prefers `Chest`, then `UpperChest`/`Spine2`, then `Spine1` or `Spine`. It does **not** guess from node ordering. Two candidates at the same priority are an error.

Override only the roles that need it. Values are exact, case-sensitive **source GLB node names**, before Three.js sanitizes them. For example:

```json
{
  "format": "planwalk.humanoid-rig.v1",
  "bones": { "hips": "Pelvis_CTL", "rightHand": "Character:Grip.R 007" }
}
```

[JSON Schema](bone-map.schema.json) · [Complete 15-bone studio example](examples/studio-visitor.rig.json) · [Detailed visitor example](examples/man-rig.rig.json)

Supply the file with `--map`, pass it to `bindHumanoid(scene, map)`, or open/paste it under **Local GLB → Generate humanoid motion → Rig requirements & optional bone map**. Alternatively embed the same JSON object at `scenes[0].extras.planwalkHumanoid` (`scene.userData.planwalkHumanoid` after GLTFLoader). A supplied map replaces the embedded one; unspecified roles auto-match. A sidecar is read **only** when explicitly chosen, never fetched by the GLB. This map does not specify actions, actors or floor marks.

## Which limits apply?

| Consumer | Additional limits |
| --- | --- |
| **Three.js library** | Takes a loaded `Object3D` container, not file bytes. No renderer, textures, triangle LODs, DOM, floorplan or filenames are needed for binding/clip creation. Use the same Three.js instance for loading and animation. Call at rest, before posing the skin. |
| **Offline `inspect` / `bake`** | Self-contained GLB as above; ≤64 MiB, ≤2,048 nodes, ≤1,000,000 elements per accessor. Checks the loaded rig, inverse binds and weights without decoding images. Use a glTF validator for source conformance: Three.js can normalize malformed weights while loading; baking does not repair the original skin. An inspection is **not** a full glTF conformance or Studio rendering audit. Baking appends animation data; it does not optimize textures or reduce geometry. |
| **PlanWalk Studio** | ≤8 MiB, ≤512 nodes, ≤120,000 elements/accessor; 0.6–2.5 m rest mesh height, soles at Y = 0 ± 8 cm. At most 64 weighted joints, 12 visible primitives/LOD. Single-level input ≤32k triangles, or all four named LODs (20k/10k/5k/2k). Opaque/masked materials only; no cameras/lights. Up to 20 embedded PNG/JPEG images and 20 textures, 2048 px/side, 24 × 1024² total source pixels. Mapped surfaces need finite, noncollapsed UVs inside [0,1]; geometry is topology-checked. Failed generation does not replace the current cast. |

**Typical fixes:** `rightHand: not recognized` → inspect the reported source joint names and map the wrist; `ambiguous` → supply an exact name (rename truly duplicate source names); `must descend from` → fix the roles or hierarchy, not just the spelling; `does not drive any weighted vertices` → export deform bones/weights rather than controls; `already exists` → use the existing clip or rename it intentionally in your DCC. An unskinned prop can still be inserted normally in Studio with generation **off**.
