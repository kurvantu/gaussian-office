import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // These GPU checks use system fonts and do not depend on Google Fonts availability.
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ contentType: 'text/css', body: '' }));
});

// Inspect the component's real engine in tests without adding a production debug API.
async function engineSnapshot(page: Page) {
  return page.evaluate(() => {
    const element = document.querySelector('canvas[data-renderer]')!.parentElement!;
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber'))!;
    let fiber = (element as any)[fiberKey];
    while (fiber && !fiber.type?.name?.startsWith('Scene3DViewport')) fiber = fiber.return;
    let hook = fiber.memoizedState;
    while (hook && !hook.memoizedState?.current?.scene) hook = hook.next;
    const engine = hook.memoizedState.current;
    const digitRoots: number[] = [];
    let hiddenSurfaces = 0;
    engine.guide.root.traverse((node: any) => {
      const groups = node.children.filter((child: any) => child.type === 'Group');
      if (groups.length === 5 && groups.every((child: any) => child.children.some((c: any) => c.type === 'Group'))) {
        digitRoots.push(groups.length);
      }
      if (node.isMesh && node.layers.mask === 2) hiddenSurfaces++;
    });
    return {
      proceduralSplats: engine.gaussianArchitecture?.count ?? 0,
      guideSplats: engine.gaussianGuide?.count ?? 0,
      guideId: engine.guide.root.uuid,
      officeId: engine.officeEnvironment?.uuid ?? null,
      officeVisible: engine.officeEnvironment?.visible ?? false,
      officeSplats: engine.officeEnvironment?.numSplats ?? 0,
      lodBudget: engine.spark.lodSplatCount,
      floorVisible: engine.arch.walkableMeshes.find((m: any) => m.userData.roomId)?.visible,
      active: engine.spark.activeSplats,
      bones: engine.gaussianGuide?.mesh.skinning.numBones,
      digits: digitRoots,
      hiddenSurfaces,
      furniture: engine.arch.group.children.filter((node: any) => node.userData.furnitureId).length,
      guideX: engine.guide.root.position.x,
      guideZ: engine.guide.root.position.z,
      guideFrameVersion: engine.gaussianGuide?.mesh.version,
      glError: engine.renderer.getContext().getError(),
    };
  });
}

test('the default office capture preserves the articulated guide, proxy edits, and tour', async ({ page }) => {
  await page.setViewportSize({ width: 1060, height: 580 });
  let officeDownloads = 0;
  page.on('requestfinished', (request) => {
    if (request.resourceType() === 'fetch' && new URL(request.url()).pathname === '/data/sog/office.sog') officeDownloads++;
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  const canvas = page.locator('canvas[data-renderer]');
  await expect(canvas).toHaveAttribute('data-renderer', 'spark');
  await expect.poll(async () => {
    const state = await engineSnapshot(page);
    return state.active - state.guideSplats;
  }).toBeGreaterThan(0);
  const initial = await engineSnapshot(page);
  expect(initial.officeId).toBeTruthy();
  expect(initial.officeSplats).toBeGreaterThan(0);
  expect(initial.officeSplats).toBeLessThanOrEqual(initial.lodBudget);
  expect(initial.proceduralSplats).toBe(0);
  expect(initial.floorVisible).toBe(false);
  expect(initial.bones).toBeGreaterThan(40);
  expect(initial.digits).toEqual([5, 5, 5, 5]);
  expect(initial.hiddenSurfaces).toBeGreaterThan(100);
  expect(initial.glError).toBe(0);

  await page.getByRole('button', { name: 'Rendering settings', exact: true }).click();
  await expect(page.locator('#render-settings')).toContainText('fixed SOG capture');
  await page.getByRole('button', { name: /Triangle mesh/ }).click();
  await expect(canvas).toHaveAttribute('data-renderer', 'triangles');
  expect(await engineSnapshot(page)).toMatchObject({
    officeVisible: false, floorVisible: true, hiddenSurfaces: 0, guideId: initial.guideId,
  });
  await page.getByRole('button', { name: /Gaussian splatting/ }).click();
  await expect(canvas).toHaveAttribute('data-renderer', 'spark');
  await page.getByRole('button', { name: 'Fine detail', exact: true }).click();
  await expect.poll(async () => (await engineSnapshot(page)).guideSplats).toBeGreaterThan(initial.guideSplats);
  expect(await engineSnapshot(page)).toMatchObject({
    officeId: initial.officeId, officeVisible: true, lodBudget: initial.lodBudget * 2,
  });
  await page.getByRole('button', { name: 'Balanced', exact: true }).click();
  await page.getByRole('button', { name: 'Close rendering settings', exact: true }).click();

  await page.getByTitle(/^Furnish/).click();
  await page.getByRole('button', { name: /^Lounge Chair/ }).click();
  const blueprint = page.locator('canvas').first();
  const rect = await blueprint.boundingBox();
  await blueprint.click({ position: { x: rect!.width * 0.83, y: rect!.height * 0.52 } });
  await expect.poll(async () => (await engineSnapshot(page)).furniture).toBe(initial.furniture + 1);
  await page.getByTitle(/Undo last floorplan edit/).click();
  await expect.poll(async () => (await engineSnapshot(page)).furniture).toBe(initial.furniture);
  await expect.poll(() => engineSnapshot(page)).toMatchObject({
    officeId: initial.officeId, guideId: initial.guideId, floorVisible: false,
  });

  await page.getByRole('button', { name: 'Inspect Guide', exact: true }).click();
  await page.getByRole('button', { name: /Hands \(5/ }).click();
  await expect(page.getByText('Arms, Palms & 5 Fingers Each (10 Total)', { exact: true })).toBeVisible();
  const before = (await engineSnapshot(page)).guideFrameVersion;
  await expect.poll(async () => (await engineSnapshot(page)).guideFrameVersion).toBeGreaterThan(before);
  await page.getByRole('button', { name: /Feet \(5/ }).click();
  await expect(page.getByText('Legs, Ankles & 5 Toes Each (10 Total)', { exact: true })).toBeVisible();
  await page.getByTitle('Exit guide close-up inspector').click();

  await page.getByRole('button', { name: 'Virtual Tour', exact: true }).click();
  await expect(page.getByText(/Virtual Tour.*Following Elena/)).toBeVisible();
  await expect.poll(async () => {
    const state = await engineSnapshot(page);
    return Math.hypot(state.guideX - 0.5, state.guideZ + 0.6);
  }, { timeout: 45_000 }).toBeLessThan(0.2);
  await expect(page.getByText('Elena', { exact: false }).first()).toBeVisible();
  expect((await engineSnapshot(page)).glError).toBe(0);
  expect(officeDownloads).toBe(1);
  expect(errors).toEqual([]);
});

test('procedural Gaussians produce colored GPU pixels, not a renamed triangle preview', async ({ page }) => {
  await page.route('**/gaussian-test', (route) => route.fulfill({
    contentType: 'text/html', body: '<body style="margin:0"></body>',
  }));
  await page.goto('/gaussian-test');
  const result = await page.evaluate(async () => {
    const source = await (await fetch('/src/scene/gaussianSplats.ts')).text();
    const threeUrl = source.match(/from "([^"]*deps\/three[^\"]*)"/)![1];
    const sparkUrl = source.match(/from "([^"]*@sparkjsdev_spark[^\"]*)"/)![1];
    const THREE = await import(/* @vite-ignore */ threeUrl);
    const { SparkRenderer } = await import(/* @vite-ignore */ sparkUrl);
    const { createGaussianRepresentation } = await import(/* @vite-ignore */ '/src/scene/gaussianSplats.ts');
    const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
    renderer.setSize(240, 240);
    document.body.append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#eeeae2');
    const camera = new THREE.PerspectiveCamera(46, 1, 0.01, 100);
    camera.position.set(2, 2, 4);
    camera.lookAt(0, 0, 0);
    const spark = new SparkRenderer({ renderer, covSplats: true, accumExtSplats: true, autoUpdate: false, enableLod: false });
    scene.add(spark);
    const model = new THREE.Group();
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#C85A32' }));
    model.add(cube);
    scene.add(model);
    const gaussians = createGaussianRepresentation(model, 'architecture', 'balanced');
    scene.add(gaussians.mesh);
    gaussians.setEnabled(true);
    await gaussians.ready;
    for (let i = 0; i < 2; i++) {
      renderer.render(scene, camera);
      await spark.update({ scene, camera });
    }
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const pixel = new Uint8Array(4);
    gl.readPixels(120, 120, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const result = { pixel: Array.from(pixel), active: spark.activeSplats, sourceLayer: cube.layers.mask, error: gl.getError() };
    gaussians.dispose();
    spark.dispose();
    renderer.dispose();
    return result;
  });
  expect(result.sourceLayer).toBe(2);
  expect(result.active).toBeGreaterThan(100);
  expect(result.pixel[0]).toBeGreaterThan(result.pixel[1] * 1.5);
  expect(result.pixel[1]).toBeGreaterThan(result.pixel[2]);
  expect(result.error).toBe(0);
});

test('mobile navigation stays usable and floorplan presets rebuild their Gaussian scenes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('canvas[data-renderer]')).toHaveAttribute('data-renderer', 'spark');
  const headerFits = await page.locator('header').evaluate((header) => {
    const buttons = Array.from(header.querySelectorAll('button'))
      .map((button) => button.getBoundingClientRect())
      .filter((box) => box.width > 0)
      .sort((a, b) => a.left - b.left);
    return buttons.every((box, index) => box.left >= 0 && box.right <= innerWidth && (index === 0 || box.left >= buttons[index - 1].right - 1));
  });
  expect(headerFits).toBe(true);
  await page.getByRole('button', { name: 'Office Dining Hall', exact: true }).click();
  await page.getByRole('button', { name: /^Soho Gallery Loft/ }).click();
  await expect.poll(async () => (await engineSnapshot(page)).guideX).toBeCloseTo(-1.8, 1);
  expect((await engineSnapshot(page)).proceduralSplats).toBeGreaterThan(50_000);
  expect((await engineSnapshot(page)).officeId).toBeNull();
  await page.getByRole('button', { name: 'Soho Gallery Loft', exact: true }).click();
  await page.getByRole('button', { name: /^Kyoto Garden Pavilion/ }).click();
  await expect.poll(async () => (await engineSnapshot(page)).guideX).toBeCloseTo(-1.6, 1);
  expect((await engineSnapshot(page)).proceduralSplats).toBeGreaterThan(50_000);
  expect((await engineSnapshot(page)).officeId).toBeNull();
  await page.getByRole('button', { name: '3D Preview', exact: true }).click();
  await expect(page.locator('canvas[data-renderer]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a failed office load leaves the guide and the triangle plan interactive', async ({ page }) => {
  await page.route('**/office.sog*', (route) => route.request().resourceType() === 'fetch'
    ? route.fulfill({ status: 404, body: 'Missing capture' })
    : route.continue()); // Allow Vite's asset URL module through.
  await page.goto('/');
  await expect(page.locator('canvas[data-renderer]')).toHaveAttribute('data-renderer', 'triangles');
  expect(await engineSnapshot(page)).toMatchObject({
    officeId: null, floorVisible: true, hiddenSurfaces: 0, digits: [5, 5, 5, 5],
  });
  await page.getByRole('button', { name: 'Rendering settings' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not load office.sog');
  await page.getByRole('button', { name: 'Close rendering settings' }).click();
  await page.getByRole('button', { name: 'Inspect Guide' }).click();
  await expect(page.getByText('3D Guide Anatomy View')).toBeVisible();
});
