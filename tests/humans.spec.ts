import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import example from '../docs/prompts/human-motion-v1.example.json' with { type: 'json' };

const fixture = readFileSync('data/humans/Visitor.glb');
const trigger = (p: Page) => p.getByRole('button', { name: 'Insert human', exact: true });
const insert = (p: Page) => p.getByRole('button', { name: 'Insert into scene' });
const ada = { ...example, models: { visitor: example.models.visitor }, actors: [example.actors[0]] };

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (r) =>
    r.fulfill({ contentType: 'text/css', body: '' })
  );
});

async function people(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('canvas[data-renderer]')!.parentElement!;
    let f = (el as any)[Object.keys(el).find((k) => k.startsWith('__reactFiber'))!];
    while (!f.type?.name?.startsWith('Scene3DViewport')) f = f.return;
    let h = f.memoizedState;
    while (!h.memoizedState?.current?.scene) h = h.next;
    const e = h.memoizedState.current;
    return {
      actors: e.humanCast.group.children.map((root: any) => {
        const meshes: string[] = [];
        root.traverseVisible((m: any) => {
          if (m.isSkinnedMesh) meshes.push(m.name);
        });
        return { uuid: root.uuid, id: root.name, meshes, pos: root.position.toArray() };
      }),
      guide: e.guide.root.uuid,
      guidePos: e.guide.root.position.toArray(),
      office: e.officeEnvironment?.uuid,
      error: e.renderer.getContext().getError(),
    };
  });
}

test('insert a studio visitor and a local GLB without replacing the guide or the scan', async ({ page }) => {
  await page.setViewportSize({ width: 1060, height: 580 });
  const errors: string[] = [];
  let downloads = 0,
    libraryFetches = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfinished', (r) => {
    if (r.resourceType() !== 'fetch') return;
    if (new URL(r.url()).pathname.endsWith('/office.sog')) downloads++;
    if (new URL(r.url()).pathname.endsWith('/Visitor.glb')) libraryFetches++;
  });
  await page.goto('/');
  await expect(page.locator('canvas[data-renderer]')).toBeVisible();
  await expect.poll(async () => (await people(page)).office).toBeTruthy();
  const initial = await people(page);
  expect(initial.actors).toEqual([]);
  expect(libraryFetches).toBe(0);
  await page.getByRole('button', { name: '2D Plan', exact: true }).click();
  await trigger(page).click();
  await insert(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('canvas[data-renderer]')).toBeVisible();
  const first = await people(page);
  expect(first.actors).toHaveLength(1);
  expect(first.actors[0].meshes).toHaveLength(1);
  expect(first.actors[0].pos[1]).toBe(0);
  expect(first.actors[0].pos).not.toEqual(first.guidePos);
  expect(first).toMatchObject({
    guide: initial.guide,
    guidePos: initial.guidePos,
    office: initial.office,
    error: 0,
  });
  await page.getByRole('button', { name: 'Rendering settings', exact: true }).click();
  await page.getByRole('button', { name: /Triangle mesh/ }).click();
  await expect(page.locator('canvas[data-renderer]')).toHaveAttribute('data-renderer', 'triangles');
  expect((await people(page)).actors).toEqual(first.actors);
  await page.getByRole('button', { name: 'Close rendering settings' }).click();

  await trigger(page).click();
  await page.getByRole('button', { name: 'Local GLB', exact: true }).click();
  await expect(insert(page)).toBeDisabled();
  const input = page.getByLabel('Human GLB files');
  await input.setInputFiles({
    name: 'Broken.glb',
    mimeType: 'model/gltf-binary',
    buffer: Buffer.from('not a GLB'),
  });
  await insert(page).click();
  await expect(page.getByRole('alert')).toContainText('binary glTF');
  expect((await people(page)).actors).toEqual(first.actors);
  await input.setInputFiles({ name: 'Visitor.glb', mimeType: 'model/gltf-binary', buffer: fixture });
  await page.locator('summary').filter({ hasText: 'Motion JSON' }).click();
  const json = page.getByRole('textbox', { name: 'Motion JSON' });
  await json.fill(
    JSON.stringify({ ...ada, models: { visitor: { ...ada.models.visitor, idleClip: 'Absent' } } })
  );
  await insert(page).click();
  await expect(page.getByRole('alert')).toContainText('idleClip');
  expect((await people(page)).actors).toEqual(first.actors);
  await page.getByLabel('Open motion JSON file').setInputFiles({
    name: 'ada.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(ada)),
  });
  await expect(json).toHaveValue(JSON.stringify(ada));
  await insert(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await trigger(page).click();
  await expect(insert(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Pause humans' }).click();
  const both = await people(page);
  expect(both.actors.map((a: any) => a.id)).toEqual(['Human_visitor', 'Human_ada']);
  await page.getByRole('button', { name: 'Remove Visitor', exact: true }).click();
  await expect(insert(page)).toBeEnabled();
  expect((await people(page)).actors).toEqual([both.actors[1]]);
  await page.keyboard.press('Escape');
  await expect(trigger(page)).toBeFocused();
  await page.getByTitle('Reset floorplan & tour to default state').click();
  expect(await people(page)).toMatchObject({
    actors: [],
    guide: initial.guide,
    office: initial.office,
    error: 0,
  });
  expect(downloads).toBe(1);
  expect(libraryFetches).toBe(1);
  expect(errors).toEqual([]);
});

test('mobile menu fits, closes with Escape, and cancellation drops a late import', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      if (this.name === 'Slow.glb')
        await new Promise<void>((resolve) => {
          (window as any).finishRead = resolve;
        });
      return read.call(this);
    };
  });
  await trigger(page).click();
  const box = await page.getByRole('dialog').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Local GLB', exact: true }).click();
  await page
    .getByLabel('Human GLB files')
    .setInputFiles({ name: 'Slow.glb', mimeType: 'model/gltf-binary', buffer: fixture });
  await insert(page).click();
  await page.waitForFunction(() => !!(window as any).finishRead);
  await page.keyboard.press('Escape');
  await expect(trigger(page)).toBeFocused();
  await page.evaluate(() => (window as any).finishRead());
  await trigger(page).click();
  await expect(page.getByRole('dialog')).toContainText('0 / 2 extras');
  await insert(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Office Dining Hall', exact: true }).click();
  await page.getByRole('button', { name: /^Soho Gallery Loft/ }).click();
  await expect.poll(async () => (await people(page)).actors.length).toBe(0);
  await trigger(page).click();
  await expect(page.getByRole('dialog')).not.toContainText('Motion JSON');
  await insert(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await people(page)).actors).toHaveLength(1);
});

// Deterministic clock checks use the real GLTFLoader, skin clones, clips and floorplan, without a GPU timer.
async function stage(page: Page) {
  await page.route('**/human-test', (r) => r.fulfill({ contentType: 'text/html', body: '<body></body>' }));
  await page.goto('/human-test');
  await page.evaluate(async () => {
    const load = (url: string) => import(/* @vite-ignore */ url);
    const source = await (await fetch('/src/scene/humans/cast.ts')).text();
    const T = await load(source.match(/from "([^"]*deps\/three\.js[^"]*)"/)![1]);
    const { HumanCast } = await load('/src/scene/humans/cast.ts');
    const { OFFICE } = await load('/src/data/office.ts');
    const { NavGrid } = await load('/src/utils/pathfinding.ts');
    const blob = await (await fetch('/data/humans/Visitor.glb')).blob();
    const w = window as any;
    w.three = T;
    w.cast = new HumanCast(new T.Group(), true, (s: unknown) => (w.state = s));
    w.plan = (p: unknown) => w.cast.setNavigation(p, new NavGrid(p));
    w.office = OFFICE;
    w.plan(OFFICE);
    w.camera = new T.Vector3(0.5, 1, -0.6);
    w.visitor = new File([blob], 'Visitor.glb');
    w.host = new File([blob], 'Host.glb');
  });
}

test('take playback is independent, replayable, LOD bounded and releases shared resources once', async ({
  page,
}) => {
  await stage(page);
  const shared = {
    ...example,
    models: ada.models,
    actors: [example.actors[0], { ...example.actors[1], model: 'visitor' }],
  };
  const result = await page.evaluate(async (take) => {
    const { cast, visitor, camera } = window as any;
    await cast.insert([visitor], JSON.stringify(take));
    const [a, b] = cast.group.children,
      mesh = (o: any) => o.getObjectByName('LOD1');
    const joint = (o: any) => o.getObjectByName('Wrist_R');
    const geom = mesh(a).geometry;
    let releases = 0;
    geom.addEventListener('dispose', () => releases++);
    cast.update(1.3, camera);
    const walking = a.position.toArray(),
      tilt = joint(b).rotation.z,
      neutral = joint(a).rotation.z;
    const lod = [0, 1, 2, 3].filter((i) => a.getObjectByName(`LOD${i}`).visible);
    cast.togglePause();
    cast.update(5, camera);
    const frozen = a.position.toArray();
    cast.replay();
    const spawn = a.position.toArray(),
      clearedPose = joint(b).rotation.z;
    cast.update(40, camera);
    const end = a.position.toArray(),
      yaw = a.rotation.y,
      endPose = joint(b).rotation.z;
    const rig = mesh(a).skeleton !== mesh(b).skeleton && joint(a) !== joint(b) && geom === mesh(b).geometry;
    cast.remove('lin');
    const kept = releases;
    cast.clear();
    return {
      walking,
      tilt,
      neutral,
      lod,
      frozen,
      spawn,
      clearedPose,
      end,
      yaw,
      endPose,
      rig,
      kept,
      releases,
      left: cast.group.children.length,
    };
  }, shared);
  expect(result.rig).toBe(true);
  expect(result.walking).not.toEqual(result.spawn);
  expect(result.tilt).toBeCloseTo(Math.PI / 12, 4);
  expect(result.neutral).toBeCloseTo(0);
  expect(result.lod).toEqual([1]);
  expect(result.frozen).toEqual(result.walking);
  expect(result.spawn).toEqual([0.5, 0, -0.6]);
  expect(result.clearedPose).toBeCloseTo(0);
  expect(result.end).toEqual([-4.4, 0, -2.82]);
  expect(Math.sin(result.yaw)).toBeCloseTo(1);
  expect(result.endPose).toBeCloseTo(0);
  expect(result.kept).toBe(0);
  expect(result.releases).toBe(1);
  expect(result.left).toBe(0);
});

test('two-file take checks, edited marks and local-only model validation are atomic', async ({ page }) => {
  await stage(page);
  const take = { ...example, models: { ...example.models, host: { file: 'Host.glb', idleClip: 'Relaxed' } } };
  const result = await page.evaluate(async (take) => {
    const w = window as any,
      { cast, visitor, host, camera } = w;
    const errors: string[] = [];
    async function reject(files: File[], text: string) {
      try {
        await cast.insert(files, text);
        errors.push('incorrectly accepted');
      } catch (e) {
        errors.push(String(e));
      }
      if (cast.group.children.length) throw new Error('Partial take was attached');
    }
    await reject([visitor], JSON.stringify(take));
    const order = structuredClone(take);
    (order.actors[1].steps[1] as any).keys[2].tSec = 0.2;
    await reject([visitor, host], JSON.stringify(order));
    const blocked = structuredClone(take);
    Object.assign(blocked.actors[0].steps[0], { x: 4.05, z: -1.4 });
    await reject([visitor, host], JSON.stringify(blocked));
    await reject([visitor], '{"needsInput":["Which GLB?"]}');
    await reject([visitor], JSON.stringify({ ...take, format: 'unknown' }));
    await cast.insert([visitor, host], JSON.stringify(take));
    const first = cast.group.children[0],
      two = cast.group.children.length;
    cast.update(0.6, camera);
    const before = first.position.toArray();
    const edited = structuredClone(w.office);
    Object.assign(edited.furniture[0], { x: -4.4, z: -2.82 });
    w.plan(edited);
    cast.update(3, camera);
    const held = first.position.toArray(),
      warning = w.state.problem;
    w.plan(w.office);
    const recovered = w.state.problem;
    cast.replay();
    cast.clear();
    return { errors, two, before, held, warning, recovered };
  }, take);
  expect(result.errors).toEqual([
    expect.stringContaining('Host.glb'),
    expect.stringContaining('.keys'),
    expect.stringContaining('blocked'),
    expect.stringContaining('needsInput'),
    expect.stringContaining('/format'),
  ]);
  expect(result.two).toBe(2);
  expect(result.held).toEqual(result.before);
  expect(result.warning).toContain('blocked');
  expect(result.recovered).toBeNull();

  // A GLB referencing a sidecar must fail before the sidecar is requested.
  const scene = JSON.parse(fixture.subarray(20, 20 + fixture.readUInt32LE(12)).toString());
  scene.buffers[0].uri = 'sidecar.bin';
  const json = Buffer.from(JSON.stringify(scene));
  const length = (json.length + 3) & ~3;
  const bin = fixture.subarray(20 + fixture.readUInt32LE(12));
  const glb = Buffer.concat([fixture.subarray(0, 20), json, Buffer.alloc(length - json.length, 32), bin]);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(length, 12);
  let sidecars = 0;
  page.on('request', (r) => {
    if (r.url().includes('sidecar.bin')) sidecars++;
  });
  const error = await page.evaluate(async (base64) => {
    const w = window as any,
      bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    try {
      await w.cast.insert([new File([bytes], 'External.glb')], '');
      return null;
    } catch (e) {
      return String(e);
    }
  }, glb.toString('base64'));
  expect(error).toContain('External resources');
  expect(sidecars).toBe(0);
});

test('a plain low-poly GLB can use an embedded world texture; bad UVs, pivots and oversized files are rejected', async ({
  page,
}) => {
  await stage(page);
  const result = await page.evaluate(async () => {
    const { three: T, cast } = window as any;
    const exporterPath = '/node_modules/three/examples/jsm/exporters/GLTFExporter.js';
    const { GLTFExporter } = await import(/* @vite-ignore */ exporterPath);
    const scene = new T.Scene();
    const atlas = document.createElement('canvas');
    atlas.width = atlas.height = 4;
    const paint = atlas.getContext('2d')!;
    paint.fillStyle = '#47746e';
    paint.fillRect(0, 0, 4, 4);
    const geo = new T.PlaneGeometry(0.5, 1.6).translate(0, 0.8, 0);
    const mesh = new T.Mesh(geo, new T.MeshStandardMaterial({ map: new T.CanvasTexture(atlas) }));
    mesh.name = 'Billboard';
    scene.add(mesh);
    const insertPlane = async () =>
      cast.insert([new File([await new GLTFExporter().parseAsync(scene, { binary: true })], 'Low.glb')], '');
    await insertPlane();
    const original = cast.group.children[0],
      map = original.getObjectByName('Billboard').material.map;
    const mipmaps = map.generateMipmaps && map.minFilter === T.LinearMipmapLinearFilter;
    let disposed = false;
    map.addEventListener('dispose', () => {
      disposed = true;
    });
    let pivot = '',
      uvs = '',
      size = '';
    mesh.position.y = 0.4;
    try {
      await insertPlane();
    } catch (e) {
      pivot = String(e);
    }
    mesh.position.y = 0;
    geo.attributes.uv.array.fill(0);
    try {
      await insertPlane();
    } catch (e) {
      uvs = String(e);
    }
    try {
      await cast.insert([new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'Large.glb')], '');
    } catch (e) {
      size = String(e);
    }
    const kept = cast.group.children.length === 1 && cast.group.children[0] === original;
    cast.clear();
    return { mipmaps, kept, disposed, pivot, uvs, size };
  });
  expect(result).toMatchObject({ mipmaps: true, kept: true, disposed: true });
  expect(result.pivot).toContain('origin between the feet');
  expect(result.uvs).toContain('UV');
  expect(result.size).toContain('8 MiB');
});
