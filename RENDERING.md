# Rendering and asset budgets

## Two sources, one scene

| Preset | Spark.js / Gaussian | Three.js triangle preview |
| --- | --- | --- |
| **Office Dining Hall** (default) | The bundled SOG v2 capture plus Elena's skinned splats | An approximate navigation model plus Elena's original meshes; **not** a triangle reconstruction of the scan |
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
| Geometry / skin | ≤2 extra actors. Deliver sibling mesh or group nodes named `LOD0`, `LOD1`, `LOD2`, `LOD3` on a common rig. Limits: **20k / 10k / 5k / 2k** triangles, ≤2 primitives per level, ≤64 bones, ≤4 weights per vertex. Only a low-poly extra already within the LOD3 budget may reuse one mesh level at all distances. Hero assets should have all four. |
| Draws / overdraw | Distance thresholds 4 / 8 / 14 m with 10% hysteresis. Mobile skips LOD0. At most 2 main-pass draws per actor, zero new shadow passes, blended/additive materials or particles. Use opaque materials where possible. Audit masked hair/clothing under target lighting on mobile. No custom shaders added. |
| Maps | ≤2 atlased world images per model, each ≤1024 × 1024; embedded PNG/JPEG buffer views. Mipmaps on, linear normal data, color maps sRGB. Keep source-resolution masters and export downscaled platform copies. BC7 (PC), ASTC 6×6 (mobile) and BC5 normals are production compression targets, **not** formats accepted by this GLB loader. The small library portrait is a UI WebP, not a GPU world map. |
| Motion | Use named **in-place** clips; v1 does not extract root motion, retarget rigs or do crowd avoidance. Walk speeds use the clip’s authored `walkRefMps`. Extra actors never drive Elena or her camera. |

The original [studio visitor](data/humans/Visitor.glb) is generated by [`node scripts/build-visitor.mjs`](scripts/build-visitor.mjs): 280,896 bytes, 1.76 m tall, 15 joints, **2,752 / 2,064 / 1,312 / 840** triangles, one visible primitive, vertex colors and no maps. It is loaded only when inserted, not when the office opens. Clips: `Relaxed`, `Stroll_IP` (1.4 m/s reference) and `WaveOnce`.

Import checks inspect the actual model (including UVs of mapped surfaces, topology and rest bounds), not budget numbers in motion JSON. Fix rejected art at source. For in-engine acceptance, compare feet and scale beside Elena in both modes, check occlusion against the service island, and measure frame time and overdraw with zero and two people on target hardware. Software WebGL tests do not replace that check.

## In-engine checks

1. Open the office in Split view. At the interior starting camera, check the floor against Elena's feet and look for doubled floors, furniture or ceilings. In rendering settings, **Office (selected LOD)** reports the view-dependent count, not all source splats.
2. Compare Balanced and Fine at the same camera. Inspect hands and feet, then walk both tour stops. Change lighting: the guide can change tint, but the captured fixtures should retain their baked appearance.
3. Place or move a table in the plan and undo it. In triangle preview the proxy changes; on returning to Gaussian the same scan should still be loaded. Check a procedural preset separately for editable walls and cutaways.
4. Profile the full 3D view on the target GPU, including an eye-level turn past a nearby counter (high transparent overdraw). Record frame time and memory for **both** quality settings before raising a budget; headless software rendering is a correctness test, not a hardware performance sign-off.

The [Playwright suite](tests/spark.spec.ts) checks the real office load, renderer and quality switches, edits and undo, articulated digits, tour walking, other presets, and the missing-file fallback. The [human insertion checks](tests/humans.spec.ts) cover the menu, local files, both render modes, take validation, independent rigs, pause/replay, cancellation and disposal. Setup and commands are in the [README](README.md#build-and-verify).
