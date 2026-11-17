# Gaussian Office · PlanWalk Studio

Walk through an office dining hall with Elena, the articulated tour guide. The default 3D environment is the checked-in [`data/sog/office.sog`](data/sog/office.sog), rendered by Spark.js in Three.js. Elena is **not** part of the scan: her original model, joints, gestures, walking animation and close-up inspector are unchanged.

![Split view: the office navigation plan on the left and Elena standing in the captured dining hall on the right](docs/office-walkthrough.jpg)

## Run locally

Use Node.js 22.12 or newer, npm, and a browser with WebGL2 and hardware acceleration. The repository includes the capture; no backend, API key or asset conversion is needed.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite (usually `http://localhost:5173`). The app opens in **Office Dining Hall → Split**. On first load, **Loading office…** means the asset is being fetched, decoded and prepared for drawing. The navigation model stands in until the scan is ready.

## Explore and edit

- **3D Preview:** drag to orbit, scroll to zoom, or click the floor to walk Elena. Reset the camera to return to the interior starting view.
- **Virtual Tour:** follow Elena between the dining aisle and window seating. Drag to look around; use WASD or the arrow keys to walk. **Follow Elena** returns to the guided camera.
- **Inspect Guide:** switch between the full figure, head, hands and feet, or select a gesture.
- **2D Plan / Split:** the office plan is a hand-aligned approximation for picking, collision and routing. Editing a wall or moving a table changes that plan and its **Triangle mesh** preview; it does **not** move captured furniture or repaint the SOG.
- **Spark.js / Gaussian:** see the office and guide splat counts, choose Balanced or Fine detail, or switch to the triangle preview. Wall cutaways apply to the mesh preview, not the scan. The other floorplan presets still generate their own editable 3D architecture.

## Build and verify

```sh
npx tsc --noEmit
npm run build
npm run preview
```

Serve the **whole `dist/` directory over HTTP(S)**. Vite inlines the application code but emits the office as a separate, hashed `.sog` file beside `index.html`. Deploying just the HTML will give you the navigation model instead of the capture. If **Triangle preview · Fallback** appears, open rendering settings for the error and check that the `.sog` request returns the binary, not a 404 or an HTML page.

To run the browser checks:

```sh
npx playwright install chromium
npx playwright test
```

See [Rendering and asset budgets](RENDERING.md) for the coordinate transform, LOD targets and in-engine acceptance checks.

## Capture credit

**[天安骏业集团餐厅](https://superspl.at/scene/40c67340)** by [Hilo](https://superspl.at/user/heroizme), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The original attribution is in `license.txt` inside `office.sog`. The archive is unchanged; the viewer rotates and offsets the capture, builds runtime LODs and renders Elena separately. The screenshot above shows that composite.
