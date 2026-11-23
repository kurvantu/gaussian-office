import * as T from 'three';
import type { HumanoidRig } from './bind.js';
import { RigError, ROLES, type Role } from './profile.js';

export const WALK_REF_MPS = 1.2;
export const CLIPS = { idle: 'EasyIdle', walk: 'HallwayWalk_IP', wave: 'WelcomeWave' } as const;
type Angles = readonly [number, number, number];
export interface PoseKey {
  time: number;
  degrees: Angles;
}
interface Pose {
  rot: Partial<Record<Role, Angles>>;
  hipY?: number;
  forearmTwist?: number;
}
const tau = 2 * Math.PI,
  rad = T.MathUtils.degToRad,
  deg = T.MathUtils.radToDeg,
  ease = T.MathUtils.smoothstep;
const rotation = ([x, y, z]: Angles) =>
  new T.Quaternion().setFromEuler(new T.Euler(rad(x), rad(y), rad(z), 'XYZ'));

// Convert offsets in character axes to local joint rotations, retaining bind roll. Bind by
// GLTFLoader's runtime name, not UUID, so the same tracks work on independent skinned clones.
function track(rig: HumanoidRig, role: Role, times: number[], offsets: T.Quaternion[]) {
  const j = rig.joints[role],
    pre = j.localRotation.clone().multiply(j.rotation.clone().invert());
  const values: number[] = [],
    prev = j.localRotation.clone();
  for (const offset of offsets) {
    const q = pre.clone().multiply(offset).multiply(j.rotation).normalize();
    if (prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    values.push(...q.toArray());
    prev.copy(q);
  }
  return new T.QuaternionKeyframeTrack(j.name + '.quaternion', times, values);
}

/** Author your own coordinated motion in anatomical roles, without knowing runtime bone names. */
export function createPoseClip(
  rig: HumanoidRig,
  name: string,
  keys: Partial<Record<Role, readonly PoseKey[]>>
): T.AnimationClip {
  if (!name.trim() || !Object.keys(keys).length)
    throw new RigError('Specify a clip name and at least one rotation track.');
  const tracks = Object.entries(keys).map(([key, frames]) => {
    const role = key as Role;
    if (
      !ROLES.includes(role) ||
      !Array.isArray(frames) ||
      frames.length < 2 ||
      frames[0]?.time !== 0 ||
      frames.some(
        (f, i) =>
          !f ||
          !Number.isFinite(f.time) ||
          (i > 0 && f.time <= frames[i - 1].time) ||
          !Array.isArray(f.degrees) ||
          f.degrees.length !== 3 ||
          !f.degrees.every((a: number) => Number.isFinite(a) && Math.abs(a) <= 360)
      )
    )
      throw new RigError(
        `${key}: provide at least two increasing keys from time 0, with finite XYZ degree offsets in [-360, 360].`
      );
    return track(
      rig,
      role,
      frames.map((f) => f.time),
      frames.map((f) => rotation(f.degrees))
    );
  });
  return new T.AnimationClip(name, -1, tracks).optimize();
}

/** Returns NEW clips. Never edits the scene or replaces an embedded animation. */
export function createHumanoidClips(
  rig: HumanoidRig,
  existing: readonly T.AnimationClip[] = []
): T.AnimationClip[] {
  for (const name of Object.values(CLIPS))
    if (existing.some((c) => c.name === name))
      throw new RigError(
        `Clip “${name}” already exists. Use the embedded clip instead of generating over it.`
      );
  const at = (r: Role) => rig.joints[r].position;
  // Calibrate A-, T- and lowered-arm binds to the same reference segment directions.
  // For a child, undo its parent's calibration first; applying both as absolute local
  // offsets would double-rotate the forearm. Extra static twist/helpers remain untouched.
  const align: Partial<Record<Role, T.Quaternion>> = {},
    parentAlign: Partial<Record<Role, T.Quaternion>> = {};
  const referenceForearm = (s: number) => new T.Vector3(s * 0.14, -0.189, 0.091).normalize();
  for (const side of ['left', 'right'] as const) {
    const a = `${side}UpperArm` as const,
      b = `${side}LowerArm` as const,
      c = `${side}Hand` as const,
      s = side === 'left' ? 1 : -1;
    align[a] = new T.Quaternion().setFromUnitVectors(
      at(b).clone().sub(at(a)).normalize(),
      new T.Vector3(s * 0.144, -0.245, -0.022).normalize()
    );
    align[b] = new T.Quaternion().setFromUnitVectors(
      at(c).clone().sub(at(b)).normalize(),
      referenceForearm(s)
    );
    align[c] = align[b];
    parentAlign[b] = align[a].clone().invert();
    parentAlign[c] = align[b].clone().invert();
  }
  const twistAxis = referenceForearm(-1);
  function clip(name: string, duration: number, frames: number, pose: (t: number) => Pose) {
    const times = Array.from({ length: frames + 1 }, (_, i) => (i * duration) / frames),
      poses = times.map(pose);
    const tracks: T.KeyframeTrack[] = (Object.keys(poses[0].rot) as Role[]).map((role) =>
      track(
        rig,
        role,
        times,
        poses.map((p) => {
          const q = rotation(p.rot[role]!);
          if (role === 'rightLowerArm' && p.forearmTwist)
            q.multiply(new T.Quaternion().setFromAxisAngle(twistAxis, rad(p.forearmTwist)));
          if (align[role]) q.multiply(align[role]);
          if (parentAlign[role]) q.premultiply(parentAlign[role]);
          return q;
        })
      )
    );
    if (poses[0].hipY !== undefined)
      tracks.push(
        new T.VectorKeyframeTrack(
          rig.joints.hips.name + '.position',
          times,
          poses.flatMap((p) =>
            rig.joints.hips.localPosition.clone().addScaledVector(rig.hipsUp, p.hipY!).toArray()
          )
        )
      );
    return new T.AnimationClip(name, duration, tracks).optimize();
  }
  // Relax the exported A-pose. Both greeting endpoints coincide with the idle at t=0.
  const idle = clip(CLIPS.idle, 4, 48, (t) => {
    const breath = (1 - Math.cos((tau * t) / 4)) / 2;
    return {
      rot: {
        chest: [-1.8 * breath, 1.5 * breath, 0],
        head: [1.2 * breath, -3 * breath, 0],
        leftUpperArm: [-3, 0, -21 + breath],
        rightUpperArm: [-3, 0, 21 - breath],
        leftLowerArm: [-6, 0, 0],
        rightLowerArm: [-6, 0, 0],
      },
    };
  });
  const wave = clip(CLIPS.wave, 3.6, 90, (t) => {
    const lift = ease(t, 0.15, 0.99) * (1 - ease(t, 2.58, 3.5));
    const bend = ease(t, 0.28, 1.06) * (1 - ease(t, 2.65, 3.48));
    const look = ease(t, 0, 0.62) * (1 - ease(t, 2.8, 3.6));
    const beat = Math.sin(tau * 1.45 * (t - 1.03)) * ease(t, 1, 1.28) * (1 - ease(t, 2.26, 2.66));
    return {
      rot: {
        chest: [-2 * look, -6 * look, 2 * lift],
        head: [3 * lift + 4 * ease(t, 2.5, 2.85) * (1 - ease(t, 2.85, 3.36)), 11 * look, -4 * lift],
        leftUpperArm: [-3 + 4 * lift, 0, -21 + 2 * lift],
        leftLowerArm: [-6 - 4 * lift, 0, 0],
        rightUpperArm: [-3 - 6 * lift, 21 * lift, 21 - 60 * lift],
        rightLowerArm: [-6 + 4 * bend, 0, -110 * bend + 8 * beat],
        rightHand: [-4 * bend, 0, -4 * bend + 15 * beat],
      },
      forearmTwist: 75 * bend,
    };
  });

  const legs = (['left', 'right'] as const).map((side) => {
    const hip = at(`${side}UpperLeg`),
      knee = at(`${side}LowerLeg`),
      ankle = at(`${side}Foot`);
    const thigh = knee.clone().sub(hip),
      shin = ankle.clone().sub(knee);
    return {
      side,
      hip,
      ankle,
      a: Math.hypot(thigh.y, thigh.z),
      b: Math.hypot(shin.y, shin.z),
      thighBind: Math.atan2(thigh.z, -thigh.y),
      shinBind: Math.atan2(shin.z, -shin.y),
    };
  });
  // Scale stride, swing clearance and pelvis bob together with leg length. Adjust
  // the period instead of silently changing the gait's reference metres per second.
  const size = Math.min(...legs.map((l) => l.a + l.b)) / 0.9,
    period = 1.04 * size,
    stance = 0.54,
    stride = WALK_REF_MPS * period;
  const walk = clip(CLIPS.walk, period, 48, (t) => {
    const p = t / period,
      swing = Math.cos(tau * p),
      hipY = size * (-0.043 - 0.027 * Math.cos(2 * tau * (p - 0.02)));
    const rot: Pose['rot'] = {
      chest: [3, 5 * swing, 2 * Math.sin(tau * p)],
      head: [-2, -3 * swing, 0],
      leftUpperArm: [-3 + 17 * swing, 0, -19],
      rightUpperArm: [-3 - 17 * swing, 0, 19],
      leftLowerArm: [-12 + 7 * swing, 0, 0],
      rightLowerArm: [-12 - 7 * swing, 0, 0],
    };
    for (const { side, hip, ankle, a, b, thighBind, shinBind } of legs) {
      const phase = (p + (side === 'left' ? 0 : 0.5)) % 1,
        u = Math.max(0, (phase - stance) / (1 - stance));
      const z = stride * (stance / 2 - phase + ease(u, 0, 1));
      const down = hip.y + hipY - (ankle.y + 0.095 * size * Math.sin(Math.PI * u) ** 2);
      const d = Math.hypot(z, down);
      const thigh =
        Math.atan2(z, down) + Math.acos(T.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
      const shin = Math.atan2(z - a * Math.sin(thigh), down - a * Math.cos(thigh));
      const upper = deg(thighBind - thigh),
        lower = deg(shinBind - shin);
      rot[`${side}UpperLeg`] = [upper, 0, 0];
      rot[`${side}LowerLeg`] = [lower - upper, 0, 0];
      rot[`${side}Foot`] = [-lower, 0, 0];
    }
    return { rot, hipY };
  });
  return [wave, idle, walk]; // the first action is also the preview in many external GLB viewers
}
