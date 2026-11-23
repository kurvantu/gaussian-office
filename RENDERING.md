# Rendering and asset budgets

## Two sources, one scene

| Preset | Spark.js / Gaussian | Three.js triangle preview |
| --- | --- | --- |
| **Office Dining Hall** (default) | The bundled SOG v2 capture plus Elena’s skinned splats or the selected GLB skin | An approximate navigation model plus the active guide’s meshes; **not** a triangle reconstruction of the scan |
| Nordic, Soho, Kyoto | Oriented, anisotropic `ExtSplats` sampled from the current walls, floors, furniture and guide | The editable surfaces from which the splats were sampled |

[`officeEnvironment.ts`](src/scene/officeEnvironment.ts) loads the binary with Spark 2.4's SOG ZIP decoder and builds a view-dependent LOD hierarchy in a worker. The capture has **−Y up**. At unit scale, rotate it 180° about X, then −0.447 radians about world Y to align the long window wall with X; translate it +0.065 m in Y to put the floor at world Y ≈ 0. Registration is applied to the **environment**, never to the human skeleton.

[`office.ts`](src/data/office.ts) describes the interior starting camera, walkable footprint, approximate obstacles and tour stops in metres (Y up, X/Z plan). The camera starts inside the hall: fitting the full splat bounding box would frame distant reconstruction outliers. Raycasts hit floor and guide proxies, not a million splats. Tour markers, the path and the guide's floor ring stay rasterized. The capture has baked appearance; the lighting control changes the guide/preview lighting, not the scan's illumination.

The viewport requests the capture only in the office's Gaussian mode. Edits rebuild the proxy and A* grid; they do not re-fetch or re-sample the office. Quality and renderer switches reuse the loaded capture. Leaving the preset or unmounting aborts an outstanding fetch; a decoder that finishes late is disposed rather than attached to the new scene. A fetch/decode error or a detected Spark rendering failure selects the interactive triangle preview. Both renderers require WebGL2.

## Handoff limits

Use the following budgets for this scene before adding or replacing art. Splat targets are primitive counts, **not** frame-rate guarantees. The compressed download size is not the decoded CPU/GPU footprint.

| Asset | Source / geometry budget | Runtime budget |
| --- | --- | --- |
| Office capture | One SOG, ≤17 MiB, ≤1M source splats. Shipped: 16.2 MiB, **999,131** splats; seven WebP attribute images, each ≤1024 px per side. Preserve their encoded values; these are not material textures to resize or mipmap. | One static `SplatMesh`, no skin, no splat picking, zero raster building surfaces once drawn. Desktop LOD targets: **160k Balanced / 320k Fine**; mobile: **80k / 160k**, using Spark's mobile detection. Both splat meshes share Spark's main draw. |
| Elena | Preserve the supplied hero: 43,672 source triangles, 238 meshes including the floor ring, no material texture maps. No extra download. | One skinned splat mesh: about **111k Balanced / 209k Fine**, in addition to the office target. 74 joints; Spark's skinning limit is 256. Pose changes update bone matrices, not the whole splat buffer. |
| Office navigation model and overlays | Default proxy: 1 room, 6 perimeter segments, 14 furniture footprints; about 12.2k triangles including landscape and markers in mesh preview. One shared 512² tile map on the office floor. | Building proxies issue **no** draw calls behind the scan. Two tour stops use a disc and ring each; one route line and two cursor/destination rings are shown as needed. No particle emitters. User edits can increase the mesh-preview cost. |

[`gaussianSplats.ts`](src/scene/gaussianSplats.ts) and [`createHumanGuide.ts`](src/scene/createHumanGuide.ts) supply the existing guide in every preset. Covariance splats also preserve the non-uniform scaling of cutaway walls in the procedural presets. [`Scene3DViewport.tsx`](src/components/Scene3DViewport.tsx) manages visibility, LOD selection, GPU fences and disposal. Device pixel ratio is capped at 2, splat radius at 256 px, and a pending GPU fence prevents the Gaussian loop from queuing another draw.

### Additional human models

Extra people are a separate triangle group in both rendering modes. They add **zero splats** and do not use Elena’s per-joint sampler. Use this sheet **before** making an asset:

| Item | Handoff and runtime limit |
| --- | --- |
| File / axes | One self-contained glTF 2.0 binary scene, ≤8 MiB. Metres, Y up, +Z forward, origin between the feet. Rest height 0.6–2.5 m; floor at Y = 0 ± 8 cm. No sidecar files, cameras, lights or external decoders. Core materials, unlit, mesh quantization and texture transforms supported. |
| Geometry / skin | ≤2 extra actors, **20k / 10k / 5k / 2k** runtime triangles at LOD0–3. Prefer authored tiers, especially for heroes; use sibling nodes named `LOD0` through `LOD3`. Single-level sources up to 32k triangles can also be inserted: above 2k, the loader makes four index buffers using meshoptimizer, preserving vertex attributes, bind transforms and material boundaries. It rejects a result that cannot meet a tier limit. ≤4 weights per vertex and ≤64 palette joints per model; unweighted helpers can stay in the hierarchy. |
| Draws / overdraw | Target ≤2 main-pass draws per actor for new art. The detailed import path accepts up to **12** visible primitives per tier without merging or discarding their materials. Distance thresholds 4 / 8 / 14 m with 10% hysteresis; mobile starts at LOD1. Zero new shadow passes, blended/additive materials or particle emitters. Audit masked hair/clothing on mobile. No custom shaders. |
| Maps | Prefer two atlased world maps. Multi-material sources may embed ≤20 PNG/JPEG images and ≤20 textures, ≤2048 px per side, ≤24 × 1024² source pixels total. Before decoding, the importer budgets **2 × 1024² base texels combined** on desktop, **2 × 512²** on mobile; it scales images proportionally instead of dropping PBR maps. Mipmaps on, normals linear, color maps sRGB. Keep source-resolution masters. BC7 (PC), ASTC 6×6 (mobile) and BC5 normals are production compression targets, **not** formats accepted by this GLB loader. Library portraits are small UI WebPs, not GPU world maps. |
| Motion | Use named **in-place** clips; v1 does not extract root motion, retarget rigs or do crowd avoidance. Walk speeds use the clip’s authored `walkRefMps`. Extra takes never drive the tour guide or its camera. |

The [humanoid rig contract](packages/humanoid-motion/GLB-CONTRACT.md) is an additional requirement **when generating motion or selecting a GLB as the guide**. The standalone rig inspector checks the loaded skeleton, not Studio’s mesh/topology/texture budgets. A valid static prop or an actor with its own clips does not need a bone map.

**Detailed visitor (default).** The [unchanged source GLB](data/humans/man-2-unrig.glb) is 5,873,228 bytes. Its two roots overlap: `Sketchfab_model` is the dressed, skinned person; `Sketchfab_model.001` contains a second black `humanBody_0` reference. For this export, the importer selects the dressed root before decoding meshes or images. Picking the named file locally uses the same path. No bytes are rewritten on disk; normal insertion leaves the model in its rest pose.

| Measured in the viewer | Detailed visitor |
| --- | --- |
| Rest bounds / skin | 1.86 m tall, soles ~1.2 mm above Y=0. 68 authored joints, 58 weighted palette entries, no animation clips. |
| Triangles / draws | **18,112 / 9,042 / 4,515 / 1,780** triangles. Ten opaque draws, zero shadow passes and particles. In the starting desktop Split view, adding one person changed the Gaussian frame from 9 to 19 draws; the guide and SOG were reused. |
| Images | 16 embedded maps on the displayed character (17 in the file). After downscaling: 1,676,211 base texels on desktop / 417,287 on mobile, before mipmaps. |

All four generated index buffers reuse the same vertex attributes. Two instances of the same library entry share the prepared model, but have separate skeletons and distance selections. Removing the last instance releases its textures and LOD geometry. These counts were checked using software WebGL2, **not** profiled on a target phone.

**Rigged visitor.** [`man-rig.glb`](data/humans/man-rig.glb) is a separate 5,065,452-byte source with one clothed character, one skin (68 joints) and **no embedded animation**. It uses the same texture, weighted-palette and distance LOD limits as the detailed visitor. Its [bone map](packages/humanoid-motion/examples/man-rig.rig.json) feeds the [shared motion library](packages/humanoid-motion/README.md), which builds tracks once per loaded model from its rest orientations and proportions. The library greeting remains the default for this named clipless visitor. Other files opt in under **Local GLB → Generate humanoid motion** and can supply their own map; Elena is never bound. An explicit motion take overrides the insertion greeting.

| Authored clip | Playback |
| --- | --- |
| `WelcomeWave` · 3.6 s | Raises the right arm, turns the palm forward, waves and lowers it. Starts and ends at the idle pose with feet planted. |
| `EasyIdle` · 4 s | Seamless breathing and small head/shoulder movements. |
| `HallwayWalk_IP` · ~1.04 s on this rig | In-place, two-step loop at a reference **1.2 m/s**. Uses measured leg lengths and alternating foot contact/swing. Only the path controller translates the actor across the floor; the clip moves the hips vertically. |

[`npm run export:rigged-visitor`](scripts/export-rigged-visitor.mjs) bakes the same curves as standard glTF joint channels into a separate `exports/man-rig-animated.glb`. Neither export nor playback requires Blender or another animation service.

The [animated visitor](data/humans/Visitor.glb) is generated by [`node scripts/build-visitor.mjs`](scripts/build-visitor.mjs): 280,896 bytes, 1.76 m tall, 15 joints, **2,752 / 2,064 / 1,312 / 840** triangles, one visible primitive, vertex colors and no maps. It is loaded only when inserted, not when the office opens. Clips: `Relaxed`, `Stroll_IP` (1.4 m/s reference) and `WaveOnce`.

Import checks inspect the actual model (including UVs of mapped surfaces, topology and rest bounds), not budget numbers in motion JSON. Fix rejected art at source. For in-engine acceptance, compare feet and scale beside Elena in both modes, check occlusion against the service island, and measure frame time and overdraw with zero and two people on target hardware. Software WebGL tests do not replace that check.

## In-engine checks

1. Open the office in Split view. At the interior starting camera, check the floor against Elena's feet and look for doubled floors, furniture or ceilings. In rendering settings, **Office (selected LOD)** reports the view-dependent count, not all source splats.
2. Compare Balanced and Fine at the same camera. Inspect hands and feet, then walk both tour stops. Change lighting: the guide can change tint, but the captured fixtures should retain their baked appearance.
3. Place or move a table in the plan and undo it. In triangle preview the proxy changes; on returning to Gaussian the same scan should still be loaded. Check a procedural preset separately for editable walls and cutaways.
4. Profile the full 3D view on the target GPU, including an eye-level turn past a nearby counter (high transparent overdraw). Record frame time and memory for **both** quality settings before raising a budget; headless software rendering is a correctness test, not a hardware performance sign-off.

The [Playwright suite](tests/spark.spec.ts) checks the real office load, renderer and quality switches, edits and undo, articulated digits, tour walking, other presets, and the missing-file fallback. The [human insertion checks](tests/humans.spec.ts) cover the menu, local files, both render modes, take validation, independent rigs, pause/replay, cancellation and disposal. The [guide model checks](tests/guide-model.spec.ts) measure gait and wrist motion on the selected GLB, floor-click arrival, camera tracking and reversible cast roles. Setup and commands are in the [README](README.md#build-and-verify).
