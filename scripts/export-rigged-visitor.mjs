// Convenience preset. Other assets use `npm run humanoid -- bake INPUT.glb OUTPUT.glb`.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { prepareGlb } from '../packages/humanoid-motion/dist/glb.js';
import profile from '../packages/humanoid-motion/examples/man-rig.rig.json' with { type: 'json' };
const input = await readFile(new URL('../data/humans/man-rig.glb', import.meta.url));
const animated = (await prepareGlb(input, profile)).bake();
const dir = new URL('../exports/', import.meta.url);
await mkdir(dir, { recursive: true });
const tmp = new URL(`man-rig-${process.pid}.tmp`, dir);
await writeFile(tmp, animated, { flag: 'wx' });
await rename(tmp, new URL('man-rig-animated.glb', dir));
console.log(`exports/man-rig-animated.glb — ${animated.length} bytes`);
