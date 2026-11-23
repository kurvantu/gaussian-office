import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const rigFile = 'data/humans/man-rig.glb';
const inspect = (page: Page) => page.getByRole('button', { name: 'Inspect Guide', exact: true });
const select = (page: Page) => page.getByRole('combobox', { name: 'Guide model' });
const castMenu = (page: Page) => page.getByRole('button', { name: 'Insert human', exact: true });
const settings = (page: Page) => page.getByRole('button', { name: 'Rendering settings' });
async function insert(page: Page) {
  await page.getByRole('button', { name: 'Insert into scene' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.setViewportSize({ width: 1120, height: 640 });
});

// Observe the actual renderer, skeletons and live plan state. No test-only API, clock or motion driver.
async function studio(page: Page) {
  return page.locator('canvas[data-renderer]').evaluateHandle(canvas => {
    const el = canvas.parentElement!;
    let fiber = (el as any)[Object.keys(el).find(k => k.startsWith('__reactFiber'))!];
    while (!fiber.type?.name?.startsWith('Scene3DViewport')) fiber = fiber.return;
    let hook = fiber.memoizedState;
    while (!hook.memoizedState?.current?.scene) hook = hook.next;
    return { e: hook.memoizedState.current, sync: fiber.memoizedProps.liveSyncRef.current };
  });
}
type Studio = Awaited<ReturnType<typeof studio>>;
async function state(studio: Studio) {
  return studio.evaluate(({ e, sync }) => {
    const root = e.guide.avatar.root, vec = root.position.clone();
    const skin = new Set();
    root.traverseVisible((n: any) => { if (n.isSkinnedMesh) skin.add(n); });
    const wrist = root.getObjectByName('RightHand_49');
    return {
      nav: e.guide.root.uuid, pos: root.getWorldPosition(vec).toArray(), yaw: e.guide.root.rotation.y,
      marker: [sync.guidePos.x, sync.guidePos.z], extras: sync.extraHumans.map((m: any) => m.label),
      elena: e.guide.elena.root.visible, splats: e.gaussianGuide.mesh.visible, office: e.officeEnvironment?.uuid,
      drawn: e.renderer.renderLists.get(e.scene, 0).opaque.filter((i: any) => skin.has(i.object)).length,
      clip: e.guide.avatar.action?.getClip().name, wristY: wrist?.getWorldPosition(vec).y,
      actors: e.humanCast.actors.map((a: any) => ({ visible: a.root.visible, pos: a.root.position.toArray(), time: a.mixer.time })),
      staleSpark: e.spark.visible && e.spark.display.mapping.some(({ node }: any) => !node.visible || !node.parent),
      glError: e.renderer.getContext().getError(),
    };
  });
}

test('local Ada guides the tour: her skin walks to a floor click, waves once and returns to her parked take', async ({ page }) => {
  let officeLoads = 0, rigLoads = 0;
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('requestfinished', r => {
    if (r.resourceType() !== 'fetch') return;
    const path = new URL(r.url()).pathname;
    if (path.endsWith('/office.sog')) officeLoads++;
    if (path.endsWith('.glb')) rigLoads++;
  });
  await page.goto('/');
  const s = await studio(page);
  await expect.poll(async () => (await state(s)).office).toBeTruthy();
  const initial = await state(s);
  await castMenu(page).click();
  await page.getByRole('button', { name: 'Local GLB' }).click();
  await page.getByLabel('Human GLB files').setInputFiles(rigFile);
  await page.locator('summary').filter({ hasText: 'Motion JSON' }).click();
  await page.getByRole('button', { name: 'Use Ada’s sample take' }).click();
  await insert(page);
  await castMenu(page).click();
  await page.getByRole('button', { name: 'Pause humans' }).click();
  await page.keyboard.press('Escape');
  await inspect(page).click();
  await expect(select(page)).toHaveValue(''); // insertion is not selection
  const source = (await state(s)).actors[0];
  expect(source.pos).not.toEqual(initial.pos);
  await select(page).selectOption({ label: 'Ada · man-rig.glb' });
  await expect.poll(() => state(s)).toMatchObject({ nav: initial.nav, pos: initial.pos, yaw: initial.yaw,
    elena: false, splats: false, clip: 'EasyIdle', extras: [], actors: [{ ...source, visible: false }] });
  await expect.poll(async () => {
    const frame = await state(s);
    return frame.drawn > 0 && !frame.staleSpark;
  }).toBe(true);
  await expect(page.getByRole('button', { name: 'Spread 10 Fingers' })).toHaveCount(0);

  await settings(page).click();
  await page.getByRole('button', { name: 'Fine detail' }).click();
  await expect(page.locator('#render-settings')).toContainText('Skinned mesh');
  expect(await state(s)).toMatchObject({ elena: false, splats: false, office: initial.office });
  await page.getByRole('button', { name: /Triangle mesh/ }).click();
  await expect(page.locator('canvas[data-renderer]')).toHaveAttribute('data-renderer', 'triangles');
  await page.getByRole('button', { name: 'Close rendering settings' }).click();
  await expect.poll(async () => (await state(s)).drawn).toBeGreaterThan(0);

  for (const [tab, bones] of [ ['Head', ['Head_3']], ['Hands', ['LeftHand_25', 'RightHand_49']],
    ['Feet', ['LeftFoot_58', 'RightFoot_63']] ] as const) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    const distance = await s.evaluate(({ e }, names) => {
      const root = e.guide.avatar.root, sum = root.position.clone().set(0, 0, 0);
      for (const name of names) sum.add(root.getObjectByName(name).getWorldPosition(sum.clone()));
      return e.camTransition.target.distanceTo(sum.divideScalar(names.length));
    }, bones);
    expect(distance).toBeLessThan(tab === 'Head' ? 0.16 : 0.03);
  }
  await page.getByRole('button', { name: 'Full Body' }).click();
  const idle = await state(s);
  await page.getByRole('button', { name: 'Wave', exact: true }).click();
  await expect.poll(async () => {
    const waving = await state(s);
    return waving.clip === 'WelcomeWave' && waving.wristY - idle.wristY > 0.45;
  }).toBe(true);
  await expect.poll(async () => (await state(s)).clip).toBe('EasyIdle');
  expect(await state(s)).toMatchObject({ pos: initial.pos, actors: [{ ...source, visible: false }] });
  await page.getByTitle('Exit guide close-up inspector').click();
  await expect.poll(() => s.evaluate(({ e }) => e.camTransition.active)).toBe(false);

  // Click a real point on the triangle floor. Record gait in avatar-local coordinates so a
  // translated/rotated, but rigid, character cannot pass by arriving at the right place.
  const goal = { x: -0.8, z: -0.52 };
  const pixel = await s.evaluate(({ e }, { x, z }) => {
    const p = e.guide.root.position.clone().set(x, 0, z).project(e.camera);
    const canvas = e.renderer.domElement;
    return { x: (1 + p.x) * canvas.clientWidth / 2, y: (1 - p.y) * canvas.clientHeight / 2 };
  }, goal);
  const gait = s.evaluate(({ e, sync }) => new Promise<{ min: number; max: number; rate: number; markerError: number }>(resolve => {
    let min = Infinity, max = -Infinity, rate = 0, markerError = 0;
    const frame = () => {
      const avatar = e.guide.avatar, root = avatar.root, v = root.position.clone();
      if (e.isWalking && avatar.action?.getClip().name === 'HallwayWalk_IP') {
        const z = (n: string) => root.worldToLocal(root.getObjectByName(n).getWorldPosition(v)).z;
        const stride = z('LeftFoot_58') - z('RightFoot_63');
        min = Math.min(min, stride); max = Math.max(max, stride); rate = avatar.action.timeScale;
        const p = root.getWorldPosition(v);
        markerError = Math.max(markerError, Math.hypot(p.x - sync.guidePos.x, p.z - sync.guidePos.z));
      } else if (rate && !e.pathQueue.length) { resolve({ min, max, rate, markerError }); return; }
      requestAnimationFrame(frame);
    };
    frame();
  }));
  await page.locator('canvas[data-renderer]').click({ position: pixel });
  const stride = await gait;
  expect(stride.min).toBeLessThan(-0.35);
  expect(stride.max).toBeGreaterThan(0.35);
  expect(stride.rate).toBeCloseTo(1.52 / 1.2);
  expect(stride.markerError).toBeLessThan(0.001);
  const arrived = await state(s);
  expect(Math.hypot(arrived.pos[0] - goal.x, arrived.pos[2] - goal.z)).toBeLessThan(0.06);
  expect(arrived.clip).toBe('EasyIdle');

  await page.getByRole('button', { name: 'Virtual Tour', exact: true }).click();
  await expect(page.getByText('Virtual Tour · Following Ada', { exact: true })).toBeVisible();
  await page.getByTitle('Pause automatic tour').click();
  await expect(page.getByText('Ada · Presenting', { exact: true })).toBeVisible();
  await expect.poll(() => s.evaluate(({ e }) => e.camera.position.distanceTo(e.camera.position.clone().set(3.8, 1.6, -0.35)))).toBeLessThan(0.1);
  await inspect(page).click();
  await expect(select(page)).toHaveValue('ada');
  const atStop = await state(s);
  await select(page).selectOption({ label: 'Elena (default)' });
  await expect.poll(() => state(s)).toMatchObject({ nav: initial.nav, pos: atStop.pos, elena: true, extras: ['Ada'], actors: [source], glError: 0 });
  await settings(page).click();
  await page.getByRole('button', { name: /Gaussian splatting/ }).click();
  await expect.poll(() => state(s)).toMatchObject({ elena: true, splats: true, office: initial.office });
  expect({ officeLoads, rigLoads, errors }).toEqual({ officeLoads: 1, rigLoads: 0, errors: [] });
});

test('same-file local and library actors have separate guide roles; removal, reset and ineligible rigs are safe', async ({ page }) => {
  await page.goto('/');
  const s = await studio(page);
  await inspect(page).click();
  await expect(page.getByText('Insert a rigged human first.')).toBeVisible();
  await castMenu(page).click();
  await page.getByRole('button', { name: 'Local GLB' }).click();
  await page.getByLabel('Human GLB files').setInputFiles(rigFile);
  await insert(page); // no generation checkbox, take or second import
  await castMenu(page).click();
  await page.getByLabel('Library model').selectOption('rigged');
  await insert(page);
  await expect(select(page)).toHaveValue('');
  await select(page).selectOption({ label: 'Man rig · man-rig.glb' });
  await expect.poll(async () => (await state(s)).extras).toEqual(['Rigged visitor']);
  const parked = (await state(s)).actors[0];
  const other = (await state(s)).actors[1];
  await expect.poll(async () => (await state(s)).actors[1].time).toBeGreaterThan(other.time);
  await castMenu(page).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Man rig' })).toContainText('Active guide');
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await page.keyboard.press('Escape');
  expect((await state(s)).actors[0]).toEqual(parked);
  await select(page).selectOption({ label: 'Rigged visitor · man-rig.glb' });
  await expect.poll(() => state(s)).toMatchObject({ extras: ['Man rig'], clip: 'EasyIdle', actors: [{ visible: true }, { visible: false }] });
  await castMenu(page).click();
  await page.getByRole('button', { name: 'Remove Rigged visitor', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(select(page)).toHaveValue('');
  await expect.poll(() => state(s)).toMatchObject({ elena: true, splats: true, extras: ['Man rig'] });

  // An identically named but incompatible file must not qualify based on its basename.
  await castMenu(page).click();
  await page.getByRole('button', { name: 'Local GLB' }).click();
  await page.getByLabel('Human GLB files').setInputFiles({ name: 'man-rig.glb', mimeType: 'model/gltf-binary', buffer: readFileSync('data/humans/Visitor.glb') });
  await insert(page);
  await expect(select(page).getByRole('option', { name: /Man rig 2/ })).toBeDisabled();
  await expect(page.getByText(/Man rig 2: Missing guide clips/)).toBeVisible();
  await select(page).selectOption('man-rig');
  await page.getByTitle('Reset floorplan & tour to default state').click();
  await inspect(page).click();
  await expect(select(page)).toHaveValue('');
  await expect(select(page).getByRole('option')).toHaveCount(1);
  await expect.poll(() => state(s)).toMatchObject({ actors: [], extras: [], elena: true, splats: true, glError: 0 });
});
