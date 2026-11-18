import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import schema from '../../../docs/prompts/human-motion-v1.schema.json';
import type { FloorplanData, Point2D } from '../../types/floorplan';
import { NavGrid, pointInPolygon } from '../../utils/pathfinding';

export type Step =
  | ({ op: 'walkTo'; speedMps: number } & Point2D)
  | { op: 'turnTo'; yawDeg: number; durationSec: number }
  | { op: 'wait'; durationSec: number }
  | { op: 'play'; clip: string }
  | { op: 'pose'; bone: string; keys: { tSec: number; xyzDeg: [number, number, number] }[] };
export interface ModelSpec {
  file: string;
  idleClip?: string;
  walkClip?: string;
  walkRefMps?: number;
}
export interface ActorSpec {
  id: string;
  model: string;
  spawn: Point2D & { yawDeg: number };
  steps: Step[];
}
interface Take {
  models: Record<string, ModelSpec>;
  actors: ActorSpec[];
}
export interface Navigation {
  plan: FloorplanData;
  grid: NavGrid;
}
export const MAX_ACTORS = 2;
export const MAX_JSON_CHARS = 65_536;

// Same accepted inputs as the versioned oneOf schema. Dispatch on op so an
// invalid pose reports its own field, not (e.g.) a missing walk speed.
const runtimeSchema = {
  ...schema,
  $defs: {
    ...schema.$defs,
    step: { ...schema.$defs.step, type: 'object', discriminator: { propertyName: 'op' } },
  },
};
let validate: ValidateFunction<Take> | undefined;
export function readTake(text: string): Take {
  if (text.length > MAX_JSON_CHARS) throw new Error('Motion JSON exceeds 64K characters.');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Motion JSON is not valid JSON.');
  }
  if (data && typeof data === 'object' && 'needsInput' in data)
    throw new Error('needsInput is a question, not a playable motion take.');
  validate ??= new Ajv2020({ ownProperties: true, discriminator: true }).compile<Take>(runtimeSchema);
  if (!validate(data)) {
    const err = validate.errors?.[0];
    throw new Error(
      `${err?.instancePath || 'Motion JSON'}: ${err?.message ?? 'does not match planwalk.humans.v1'}.`
    );
  }
  if (new Set(data.actors.map((a) => a.id)).size !== data.actors.length)
    throw new Error('actors: each actor needs a unique id.');
  const files = Object.values(data.models).map((m) => m.file);
  if (new Set(files).size !== files.length) throw new Error('models: register each filename only once.');
  data.actors.forEach((a, i) => {
    if (!Object.prototype.hasOwnProperty.call(data.models, a.model))
      throw new Error(`actors[${i}].model: unknown model “${a.model}”.`);
  });
  return data;
}

export function canStand(p: Point2D, { plan, grid }: Navigation) {
  return grid.isWalkable(p) && plan.rooms.some((room) => pointInPolygon(p, room.polygon));
}

function clearLeg(start: Point2D, end: Point2D, nav: Navigation) {
  const dx = end.x - start.x,
    dz = end.z - start.z;
  const samples = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.08));
  for (let i = 1; i <= samples; i++) {
    if (!canStand({ x: start.x + (dx * i) / samples, z: start.z + (dz * i) / samples }, nav)) return false;
  }
  return true;
}

export function checkedPath(start: Point2D, goal: Point2D, nav: Navigation, field: string) {
  if (!canStand(goal, nav)) throw new Error(`${field}: destination is blocked or outside the floor.`);
  const path = nav.grid.findPath(start, goal),
    end = path[path.length - 1];
  if (end?.x !== goal.x || end.z !== goal.z)
    throw new Error(`${field}: no complete route to the requested mark.`);
  // The guide grid can use exterior space or a best-effort fallback.
  let prev = start;
  for (const wp of path) {
    if (!clearLeg(prev, wp, nav))
      throw new Error(`${field}: route crosses a blocked cell or leaves the floor.`);
    prev = wp;
  }
  return path;
}

export function nearbyMark(anchor: Point2D, yaw: number, occupied: Point2D[], nav: Navigation) {
  // Try the guide's side first so both people can be seen from the opening camera.
  for (const r of [1, 1.5, 2, 3, 4])
    for (let i = 0; i < 16; i++) {
      const a = yaw + Math.PI / 2 + (i * Math.PI) / 8;
      const p = { x: anchor.x + r * Math.sin(a), z: anchor.z + r * Math.cos(a) };
      if (clearLeg(anchor, p, nav) && occupied.every((q) => Math.hypot(p.x - q.x, p.z - q.z) >= 0.68)) {
        return { ...p, yawDeg: (yaw * 180) / Math.PI };
      }
    }
  throw new Error('No clear floor space near Elena. Move the guide to an open area and try again.');
}
