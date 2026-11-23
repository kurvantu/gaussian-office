import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import example from '../docs/prompts/human-motion-v1.example.json' with { type: 'json' };
import rigTake from '../docs/prompts/man-rig.walk-and-greet.json' with { type: 'json' };

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
          if (m.isMesh) meshes.push(m.name);
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
    if (new URL(r.url()).pathname.endsWith('/man-2-unrig.glb')) libraryFetches++;
  });
  await page.goto('/');
  await expect(page.locator('canvas[data-renderer]')).toBeVisible();
  await expect.poll(async () => (await people(page)).office).toBeTruthy();
  const initial = await people(page);
  expect(initial.actors).toEqual([]);
  expect(libraryFetches).toBe(0);
  await page.getByRole('button', { name: '2D Plan', exact: true }).click();
  await trigger(page).click();
  await expect(page.getByLabel('Library model')).toHaveValue('visitor');
  await expect(page.getByRole('dialog')).toContainText('man-2-unrig.glb');
  await insert(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('canvas[data-renderer]')).toBeVisible();
  const first = await people(page);
  expect(first.actors).toHaveLength(1);
  expect(first.actors[0].meshes).toHaveLength(10);
  expect(first.actors[0].meshes).not.toContain('humanBody_0');
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

  // A second shelf instance reuses prepared geometry/maps (not a second fetch/parse).
  await trigger(page).click();
  await insert(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const two = (await people(page)).actors;
  expect(two[1].uuid).not.toBe(first.actors[0].uuid);
  await trigger(page).click();
  await page.getByRole('button', { name: 'Remove Visitor 2', exact: true }).click();
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
  await page.locator('summary').filter({ hasText: 'Motion JSON' }).click();
  await page.getByRole('button', { name: 'Use Ada’s sample take' }).click();
  await expect(page.getByLabel('Library model')).toHaveValue('animated');
  await insert(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await people(page)).actors[0].id).toBe('Human_ada');
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
      size = '',
      topology = '',
      maps = '',
      tris = '';
    mesh.position.y = 0.4;
    try {
      await insertPlane();
    } catch (e) {
      pivot = String(e);
    }
    mesh.position.y = 0;
    atlas.width = 2049;
    atlas.height = 1;
    try {
      await insertPlane();
    } catch (e) {
      maps = String(e);
    }
    atlas.width = atlas.height = 4;
    mesh.geometry = new T.PlaneGeometry(0.5, 1.6, 128, 128).translate(0, 0.8, 0);
    try {
      await insertPlane();
    } catch (e) {
      tris = String(e);
    }
    mesh.geometry = geo;
    const validIndex = geo.index;
    geo.setIndex([0, 2, 1, 0, 2, 1, 0, 2, 1]);
    try {
      await insertPlane();
    } catch (e) {
      topology = String(e);
    }
    geo.setIndex(validIndex);
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
    return { mipmaps, kept, disposed, pivot, uvs, size, topology, maps, tris };
  });
  expect(result).toMatchObject({ mipmaps: true, kept: true, disposed: true });
  expect(result.pivot).toContain('origin between the feet');
  expect(result.uvs).toContain('UV');
  expect(result.size).toContain('8 MiB');
  expect(result.topology).toMatch(/non-manifold|inconsistent winding/);
  expect(result.maps).toContain('2048');
  expect(result.tris).toContain('32,000');
});

test('the actual detailed local GLB keeps its skin and maps, selects mobile LODs, and releases them on clear', async ({
  page,
}) => {
  await stage(page);
  const result = await page.evaluate(async () => {
    const { cast, three: T, camera } = window as any;
    const name = 'man-2-unrig.glb',
      bytes = await (await fetch('/data/humans/' + name)).blob();
    const file = new File([bytes], name);
    await cast.insert([file], '');
    const actor = cast.group.children[0],
      parts: any[] = [],
      images = new Set<any>(),
      joints = new Set<any>();
    actor.updateMatrixWorld(true);
    actor.traverseVisible((m: any) => {
      if (!m.isMesh) return;
      parts.push(m);
      m.skeleton.bones.forEach((b: any) => joints.add(b));
      Object.values(m.material).forEach((v: any) => {
        if (v?.isTexture) images.add(v.image);
      });
    });
    const box = new T.Box3().setFromObject(actor, true);
    const tri = () => parts.reduce((n, m) => n + m.geometry.index.count / 3, 0);
    const clock = (distance: number) =>
      cast.update(0, camera.copy(actor.position).add(new T.Vector3(0, 0, distance)));
    clock(0);
    const close = tri();
    clock(10);
    const medium = tri();
    clock(20);
    const far = tri();
    let freed = 0;
    parts[0].geometry.addEventListener('dispose', () => freed++);
    const texels = [...images].reduce((n, i) => n + i.width * i.height, 0);
    const material = parts.find((m) => m.material.name === 'Wolf3D_Skin')?.material;
    const pbr =
      !!material?.map?.isTexture &&
      material.map.generateMipmaps &&
      material.map.colorSpace === T.SRGBColorSpace;
    const opaque = parts.every((m) => !m.material.transparent && !m.castShadow);
    let clipError = '';
    try {
      await cast.insert(
        [file],
        JSON.stringify({
          format: 'planwalk.humans.v1',
          preset: 'office',
          models: { v: { file: name, idleClip: 'Relaxed' } },
          actors: [{ id: 'test', model: 'v', spawn: { x: 0.5, z: -0.6, yawDeg: 0 }, steps: [] }],
        })
      );
    } catch (e) {
      clipError = String(e);
    }
    const kept = cast.group.children.length === 1 && cast.group.children[0] === actor;
    cast.clear();
    return {
      meshes: parts.length,
      palettes: new Set(parts.map((m) => m.skeleton)).size,
      images: images.size,
      joints: joints.size,
      height: box.max.y - box.min.y,
      foot: box.min.y,
      close,
      medium,
      far,
      texels,
      pbr,
      opaque,
      freed,
      clipError,
      kept,
    };
  });
  expect(result).toMatchObject({
    meshes: 10,
    palettes: 1,
    images: 16,
    joints: 58,
    pbr: true,
    opaque: true,
    freed: 1,
    kept: true,
  });
  expect(result.height).toBeCloseTo(1.86, 2);
  expect(Math.abs(result.foot)).toBeLessThan(0.01);
  expect(result.texels).toBeLessThanOrEqual(2 * 512 * 512);
  expect(result.close).toBeLessThanOrEqual(10_000);
  expect(result.close).toBeGreaterThan(result.medium);
  expect(result.medium).toBeLessThanOrEqual(5_000);
  expect(result.medium).toBeGreaterThan(result.far);
  expect(result.far).toBeLessThanOrEqual(2_000);
  expect(result.far).toBeGreaterThan(0);
  expect(result.clipError).toContain('no playable clip “Relaxed”');
});

test('Rigged visitor offers a playable walk & greet take alongside the existing studio models', async ({
  page,
}) => {
  const errors: string[] = [],
    rigRequests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfinished', (r) => {
    if (r.resourceType() === 'fetch' && new URL(r.url()).pathname.endsWith('/man-rig.glb'))
      rigRequests.push(r.url());
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto('/');
  await expect(page.locator('canvas[data-renderer]')).toBeVisible();
  await expect.poll(async () => (await people(page)).office).toBeTruthy();
  const original = await people(page);
  await trigger(page).click();
  await page.getByLabel('Library model').selectOption({ label: 'Rigged visitor' });
  await expect(page.getByRole('dialog')).toContainText('man-rig.glb');
  await page.locator('summary').filter({ hasText: 'Motion JSON' }).click();
  await page.getByRole('button', { name: 'Use walk & greet take' }).click();
  expect(JSON.parse(await page.getByRole('textbox', { name: 'Motion JSON' }).inputValue())).toEqual(rigTake);
  expect(rigRequests).toHaveLength(0);
  await insert(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const spark = await people(page);
  expect(spark.actors).toHaveLength(1);
  expect(spark.actors[0].id).toBe('Human_greeter');
  expect(spark.actors[0].meshes).toHaveLength(10);
  await page.getByRole('button', { name: 'Rendering settings', exact: true }).click();
  await page.getByRole('button', { name: /Triangle mesh/ }).click();
  await expect(page.locator('canvas[data-renderer]')).toHaveAttribute('data-renderer', 'triangles');
  const mesh = await people(page);
  expect(mesh.actors[0].uuid).toBe(spark.actors[0].uuid);
  expect(mesh).toMatchObject({ guide: original.guide, office: original.office, error: 0 });
  expect(rigRequests).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('man-rig drives weighted vertices, plants its feet, and replays on its own skeleton', async ({
  page,
}) => {
  await stage(page);
  const r = await page.evaluate(async (take) => {
    const { cast, three: T, camera, visitor } = window as any;
    const name = 'man-rig.glb',
      blob = await (await fetch('/data/humans/' + name)).blob();
    const file = new File([blob], name);
    await cast.insert([file], ''); // real local source, no JSON and no embedded animations
    const current = () => cast.group.children[0];
    const clock = (dt: number) => cast.update(dt, camera);
    const joint = (name: string) => current().getObjectByName(name);
    const pos = (n: string) => current().worldToLocal(joint(n).getWorldPosition(new T.Vector3()));
    const wrist = () => pos('RightHand_49');
    const ankle = (left: boolean) => pos(left ? 'LeftFoot_58' : 'RightFoot_63');
    // Sample an actually drawn, weighted hand vertex, not just an animated Object3D.
    let mesh: any,
      id = -1;
    current().traverseVisible((m: any) => {
      if (!m.isSkinnedMesh || mesh) return;
      const { skinIndex: j, skinWeight: w } = m.geometry.attributes;
      const slot = m.skeleton.bones.indexOf(joint('RightHand_49'));
      for (const i of m.geometry.index.array) {
        if ([0, 1, 2, 3].some((k) => j.getComponent(i, k) === slot && w.getComponent(i, k) > 0.55)) {
          mesh = m;
          id = i;
          break;
        }
      }
    });
    if (!mesh) throw new Error('No drawn hand vertex on the rig');
    const vertex = () => {
      current().updateMatrixWorld(true);
      return current().worldToLocal(mesh.localToWorld(mesh.getVertexPosition(id, new T.Vector3())));
    };
    const start = current().position.clone(),
      low = wrist(),
      v0 = vertex(),
      foot = ankle(false);
    clock(1.22);
    const high = wrist(),
      v1 = vertex(),
      footError = foot.distanceTo(ankle(false));
    cast.togglePause();
    clock(1);
    const paused = v1.distanceTo(vertex());
    cast.togglePause();
    clock(0.36);
    const waveSwing = wrist().distanceTo(high);
    cast.replay();
    const replay = v0.distanceTo(vertex());
    clock(3.6);
    const settled = wrist().distanceTo(low),
      chest = joint('Spine2_53').quaternion.clone();
    clock(2);
    const breath = chest.angleTo(joint('Spine2_53').quaternion),
      drift = start.distanceTo(current().position);
    cast.clear();

    // The sample drives root travel through navigation; the in-place gait plants the stance
    // foot at 1.2 m/s and lifts the other. Half a cycle later the legs have exchanged roles.
    await cast.insert('rigged', JSON.stringify(take));
    const a = ankle(true),
      b = ankle(false),
      origin = current().position.clone();
    clock(0.26);
    const planted = ankle(true),
      swing = ankle(false),
      travel = origin.distanceTo(current().position);
    clock(0.26);
    const half = ankle(true).z - ankle(false).z;
    clock(15);
    const destination = current().position.toArray();
    cast.clear();

    // Never replace an explicit empty take with the automatic greeting.
    const stillTake = {
      ...take,
      models: { rig: { file: name } },
      actors: [{ ...take.actors[0], steps: [] }],
    };
    await cast.insert('rigged', JSON.stringify(stillTake));
    const still = wrist();
    clock(1.22);
    const explicitRest = wrist().distanceTo(still);
    cast.clear();
    // A different, already animated GLB with this basename keeps its own inventory.
    let mismatch = '';
    try {
      await cast.insert([new File([visitor], name)], JSON.stringify(take));
    } catch (e) {
      mismatch = String(e);
    }
    return {
      lift: high.y - low.y,
      skinLift: v1.y - v0.y,
      footError,
      paused,
      replay,
      waveSwing,
      settled,
      breath,
      drift,
      split: a.z - b.z,
      half,
      ankleHeight: planted.y - a.y,
      stanceTravel: a.z - planted.z,
      swingLift: swing.y - b.y,
      travel,
      destination,
      mismatch,
      explicitRest,
    };
  }, rigTake);
  expect(r.lift).toBeGreaterThan(0.5);
  expect(r.skinLift).toBeGreaterThan(0.5);
  expect(r.waveSwing).toBeGreaterThan(0.045);
  expect(r.footError).toBeLessThan(0.0001);
  expect(r.drift).toBe(0);
  expect(r.paused).toBeLessThan(0.0001);
  expect(r.replay).toBeLessThan(0.0001);
  expect(r.settled).toBeLessThan(0.001);
  expect(r.breath).toBeGreaterThan(0.02);
  expect(r.split).toBeGreaterThan(0.5);
  expect(r.half).toBeLessThan(-0.5);
  expect(Math.abs(r.ankleHeight)).toBeLessThan(0.003);
  expect(r.swingLift).toBeGreaterThan(0.075);
  expect(r.stanceTravel).toBeCloseTo(0.26 * 1.2, 2);
  expect(r.travel).toBeGreaterThan(0.27);
  expect(r.destination).toEqual([1.35, 0, -0.52]);
  expect(r.mismatch).toContain('no playable clip “EasyIdle”');
  expect(r.explicitRest).toBeLessThan(0.0001);
});

test('a custom GLB can generate humanoid motion by role map; a failed bind leaves the scene untouched', async ({
  page,
}) => {
  // An existing skinned character with its own clips and an artist-specific joint name.
  // Keep the original BIN and node indices intact, including the existing animation targets.
  const jsonEnd = 20 + fixture.readUInt32LE(12),
    doc = JSON.parse(fixture.subarray(20, jsonEnd).toString());
  const hand = 'Character:Grip.R 007';
  doc.nodes.find((n: any) => n.name === 'Wrist_R').name = hand;
  const json = Buffer.from(JSON.stringify(doc)),
    size = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.concat([
    fixture.subarray(0, 20),
    json,
    Buffer.alloc(size - json.length, 32),
    fixture.subarray(jsonEnd),
  ]);
  bytes.writeUInt32LE(size, 12);
  bytes.writeUInt32LE(bytes.length, 8);
  await page.setViewportSize({ width: 980, height: 640 });
  await page.goto('/');
  await expect(page.locator('canvas[data-renderer]')).toBeVisible();
  await trigger(page).click();
  await page.getByRole('button', { name: 'Local GLB', exact: true }).click();
  await page
    .getByLabel('Human GLB files')
    .setInputFiles({ name: 'Guest.glb', mimeType: 'model/gltf-binary', buffer: bytes });
  const generate = page.getByRole('checkbox', { name: 'Generate humanoid motion' });
  await expect(generate).not.toBeChecked();
  await generate.check();
  await insert(page).click();
  await expect(page.getByRole('alert')).toContainText('rightHand: not recognized');
  expect((await people(page)).actors).toHaveLength(0);
  await page.locator('summary').filter({ hasText: 'Rig requirements' }).click();
  await page
    .getByLabel('Open bone map file')
    .setInputFiles({
      name: 'Guest.rig.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'planwalk.humanoid-rig.v1', bones: { rightHand: hand } })),
    });
  await expect(page.getByLabel('Bone map JSON', { exact: false })).toContainText(hand);
  await page.locator('summary').filter({ hasText: 'Motion JSON' }).click();
  await page.getByRole('button', { name: 'Use walk & greet take' }).click();
  expect(
    JSON.parse(await page.getByRole('textbox', { name: 'Motion JSON' }).inputValue()).models.rig.file
  ).toBe('Guest.glb');
  await insert(page).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const scene = await people(page);
  expect(scene.actors.map((a: any) => a.id)).toEqual(['Human_greeter']);
  expect(scene.error).toBe(0);
});
