# Gaussian Rendering

The 3D workspace defaults to **Spark.js 2.4 Gaussian splatting**. Open the
**Spark.js / Gaussian** control in the viewport to compare it with the original
Three.js triangle renderer, or switch between Balanced and Fine Detail sampling.

## Implementation

- `src/scene/gaussianSplats.ts` samples the editable architectural and human
  surfaces into oriented, anisotropic `ExtSplats`, including floor textures.
- `SplatSkinning` binds samples to the existing guide's joint hierarchy. Finger,
  toe, facial, and walking animations update bone matrices on the GPU without
  uploading the full Gaussian collection on every frame.
- Covariance splats preserve the non-uniform scaling used by wall cutaways.
- `src/components/Scene3DViewport.tsx` owns `SparkRenderer`, frame pacing,
  GPU-resource cleanup, and the triangle-rendering fallback.
- Original triangle surfaces are retained as hidden picking proxies. The ground
  backdrop, route line, and interaction markers remain conventional geometry.
- Floorplan edits regenerate the architectural splats. Lighting presets tint
  their baked surface shading; they do not dynamically relight a trained scene.

## Scope

These are real Gaussian primitives rendered by Spark, procedurally generated from
the current editable model. They are **not** a photograph-trained 3DGS capture.
Photorealistic captured interiors would require separately captured/trained splat
assets and alignment with the navigation floorplan. No such assets or training
service are included.

The renderer requires WebGL2 and a compatible GPU. A detected initialization or
shader failure switches the workspace to the functional triangle preview.

## Verification

```sh
npx tsc --noEmit
npm run build
npx playwright test
```

Install the test browser once with `npx playwright install chromium`. The browser
checks cover real Gaussian-colored GPU pixels, renderer switching, quality changes,
floorplan edits and undo, the guide's four five-digit extremities, tour walking,
preset scene rebuilding, and mobile navigation.