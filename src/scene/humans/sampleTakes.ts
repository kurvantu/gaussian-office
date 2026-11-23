import example from '../../../docs/prompts/human-motion-v1.example.json';
import rigTake from '../../../docs/prompts/man-rig.walk-and-greet.json';
import { CLIPS, WALK_REF_MPS } from '../../../packages/humanoid-motion/src/index';

export type SampleShot = 'ada' | 'greet';
const inventories = {
  visitor: {
    idle: example.models.visitor.idleClip,
    walk: example.models.visitor.walkClip,
    wave: 'WaveOnce',
    walkRefMps: example.models.visitor.walkRefMps,
  },
  humanoid: { ...CLIPS, walkRefMps: WALK_REF_MPS },
};
export type SampleInventory = keyof typeof inventories;

/** Recognize only known, calibrated clip sets; never guess the gait speed of an unknown walk. */
export function matchSampleInventory(names: readonly string[]): SampleInventory | undefined {
  return (['visitor', 'humanoid'] as const).find((id) => {
    const { idle, walk, wave } = inventories[id];
    return [idle, walk, wave].every((name) => names.includes(name));
  });
}

/** Keep the shot's marks, timing and actor. Bind its idle, gait and greeting to the chosen model. */
export function sampleText(shot: SampleShot, inventory: SampleInventory, file: string) {
  const template = shot === 'ada' ? example : rigTake;
  const actor = template.actors[0];
  const originalWave = shot === 'ada' ? inventories.visitor.wave : inventories.humanoid.wave;
  const { idle, walk, wave, walkRefMps } = inventories[inventory];
  return JSON.stringify(
    {
      format: template.format,
      preset: template.preset,
      models: { [actor.model]: { file, idleClip: idle, walkClip: walk, walkRefMps } },
      actors: [
        {
          ...actor,
          steps: actor.steps.map((step) =>
            step.op === 'play' && 'clip' in step && step.clip === originalWave
              ? { ...step, clip: wave }
              : step
          ),
        },
      ],
    },
    null,
    2
  );
}
