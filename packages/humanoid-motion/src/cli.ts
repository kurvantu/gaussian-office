#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { prepareGlb, MAX_INPUT } from './glb.js';
import { readBoneMap, RigError } from './index.js';

const help = `humanoid-motion inspect INPUT.glb [--map bones.json]
humanoid-motion bake INPUT.glb OUTPUT.glb [--map bones.json]
Inspect prints the resolved role map; bake writes a NEW file with wave, idle and walk clips.`;
try {
  const {
    values,
    positionals: [command, input, output, ...extra],
  } = parseArgs({
    allowPositionals: true,
    options: { map: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) console.log(help);
  else {
    if (
      (command !== 'inspect' && command !== 'bake') ||
      !input ||
      extra.length ||
      (command === 'bake') !== !!output
    )
      throw new Error(help);
    if ((await stat(input)).size > MAX_INPUT) throw new Error('Offline input exceeds 64 MiB.');
    if (values.map && (await stat(values.map)).size > 16 * 1024) throw new Error('Bone map exceeds 16 KiB.');
    const map = values.map ? readBoneMap(await readFile(values.map, 'utf8')) : undefined;
    const result = await prepareGlb(await readFile(input), map);
    if (command === 'bake') {
      if (!output.toLowerCase().endsWith('.glb')) throw new Error('Choose a new .glb output file.');
      await writeFile(output, result.bake(), { flag: 'wx' });
    }
    console.log(
      JSON.stringify(
        {
          compatible: true,
          roles: result.roles,
          conflicts: result.conflicts,
          embeddedClips: result.embeddedClips,
          walkRefMps: result.walkRefMps,
          output,
        },
        null,
        2
      )
    );
  }
} catch (e) {
  console.error(
    JSON.stringify(
      {
        compatible: false,
        availableJoints: e instanceof RigError ? e.availableJoints : undefined,
        issues: e instanceof RigError ? e.issues : [e instanceof Error ? e.message : String(e)],
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
