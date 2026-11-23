export const ROLES = [
  'hips',
  'chest',
  'head',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
] as const;
export type Role = (typeof ROLES)[number];
export interface BoneMap {
  format: 'planwalk.humanoid-rig.v1';
  bones: Partial<Record<Role, string>>;
}
export class RigError extends Error {
  readonly issues: readonly string[];
  availableJoints?: string[];
  constructor(...issues: string[]) {
    super(issues.join('\n'));
    this.name = 'RigError';
    this.issues = issues;
  }
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
/** Explicit, case-sensitive *source* joint names. Unmapped roles are auto-resolved. */
export function parseBoneMap(input: unknown): BoneMap {
  if (
    !record(input) ||
    input.format !== 'planwalk.humanoid-rig.v1' ||
    !record(input.bones) ||
    Object.keys(input).some((k) => k !== 'format' && k !== 'bones')
  )
    throw new RigError(
      'Bone map: expected { "format": "planwalk.humanoid-rig.v1", "bones": { … } }. This is not a motion take.'
    );
  const bones: BoneMap['bones'] = {};
  for (const [role, value] of Object.entries(input.bones)) {
    if (!ROLES.includes(role as Role)) throw new RigError(`Bone map: unknown role “${role}”.`);
    if (typeof value !== 'string' || !value.trim() || value.length > 128)
      throw new RigError(`bones.${role}: expected an exact GLB joint name (1–128 characters).`);
    bones[role as Role] = value;
  }
  return { format: 'planwalk.humanoid-rig.v1', bones };
}

export function readBoneMap(text: string): BoneMap {
  if (new TextEncoder().encode(text).length > 16384) throw new RigError('Bone map exceeds 16 KiB.');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RigError('Bone map JSON is not valid JSON.');
  }
  return parseBoneMap(data);
}

// Match anatomical names, never node order or a filename. Do not strip the 2 from Spine2.
export const normalizedName = (s: string) =>
  (s.split(/[:|]/).pop() ?? s)
    .toLowerCase()
    .replace(/^mixamorig\d*/, '')
    .replace(/^def[-_]/, '')
    .replace(/_\d+$/, '')
    .replace(/[\s_.-]/g, '');
export function aliases(role: Role): string[][] {
  if (role === 'hips') return [['hips', 'pelvis']];
  if (role === 'chest') return [['chest'], ['upperchest', 'spine2'], ['spine1'], ['spine']];
  if (role === 'head') return [['head']];
  const side = role.startsWith('left') ? 'left' : 'right',
    s = side[0];
  const names: Record<string, string[]> = {
    UpperArm: ['upperarm', 'arm'],
    LowerArm: ['lowerarm', 'forearm', 'elbow'],
    Hand: ['hand', 'wrist'],
    UpperLeg: ['upperleg', 'upleg', 'thigh', 'hip'],
    LowerLeg: ['lowerleg', 'leg', 'shin', 'knee', 'calf'],
    Foot: ['foot', 'ankle'],
  };
  const part = role.slice(side.length);
  const tier = names[part].flatMap((n) => [side + n, n + s, s + n, n + side]);
  return part === 'UpperArm' ? [tier, ['shoulder' + s]] : [tier]; // Shoulder_L/R in the original studio rig
}
