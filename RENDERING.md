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

## In-engine checks

1. Open the office in Split view. At the interior starting camera, check the floor against Elena's feet and look for doubled floors, furniture or ceilings. In rendering settings, **Office (selected LOD)** reports the view-dependent count, not all source splats.
2. Compare Balanced and Fine at the same camera. Inspect hands and feet, then walk both tour stops. Change lighting: the guide can change tint, but the captured fixtures should retain their baked appearance.
3. Place or move a table in the plan and undo it. In triangle preview the proxy changes; on returning to Gaussian the same scan should still be loaded. Check a procedural preset separately for editable walls and cutaways.
4. Profile the full 3D view on the target GPU, including an eye-level turn past a nearby counter (high transparent overdraw). Record frame time and memory for **both** quality settings before raising a budget; headless software rendering is a correctness test, not a hardware performance sign-off.

The [Playwright suite](tests/spark.spec.ts) checks the real office load, renderer and quality switches, edits and undo, articulated digits, tour walking, other presets, and the missing-file fallback. Setup and commands are in the [README](README.md#build-and-verify).
