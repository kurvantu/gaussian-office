import * as T from 'three';

// Authored specifically for the joints in man-rig.glb, not a general-purpose retargeter.
export const RIG_FILE = 'man-rig.glb';
export const RIG_WALK_MPS = 1.2;
export const RIG_CLIPS = { idle: 'EasyIdle', walk: 'HallwayWalk_IP', wave: 'WelcomeWave' } as const;

const names = {
  hips: 'Hips_66',
  chest: 'Spine2_53',
  head: 'Head_3',
  lArm: 'LeftArm_27',
  lElbow: 'LeftForeArm_26',
  lHand: 'LeftHand_25',
  rArm: 'RightArm_51',
  rElbow: 'RightForeArm_50',
  rHand: 'RightHand_49',
  lThigh: 'LeftUpLeg_60',
  lKnee: 'LeftLeg_59',
  lAnkle: 'LeftFoot_58',
  rThigh: 'RightUpLeg_65',
  rKnee: 'RightLeg_64',
  rAnkle: 'RightFoot_63',
} as const;
type Joint = keyof typeof names;
type Angles = [number, number, number]; // offsets about the rest model's X/Y/Z axes, degrees
interface Pose {
  rot: Partial<Record<Joint, Angles>>;
  hipY?: number;
  forearmTwist?: number;
}
const tau = 2 * Math.PI,
  rad = T.MathUtils.degToRad,
  deg = T.MathUtils.radToDeg;
const ease = T.MathUtils.smoothstep;

/** Make real, reusable joint tracks without ever posing the shared source scene. */
export function authorRigClips(root: T.Object3D): T.AnimationClip[] | undefined {
  const joints = {} as Record<Joint, T.Bone>;
  for (const key of Object.keys(names) as Joint[]) {
    const node = root.getObjectByName(names[key]);
    if (!(node instanceof T.Bone)) return;
    joints[key] = node;
  }
  // A coincident filename is not a rig inventory. Only apply the choreography to these chains.
  for (const [a, b, c] of [
    [joints.lThigh, joints.lKnee, joints.lAnkle],
    [joints.rThigh, joints.rKnee, joints.rAnkle],
    [joints.lArm, joints.lElbow, joints.lHand],
    [joints.rArm, joints.rElbow, joints.rHand],
  ])
    if (b.parent !== a || c.parent !== b) return;
  if (joints.lThigh.parent !== joints.hips || joints.rThigh.parent !== joints.hips) return;
  root.updateWorldMatrix(true, true);
  const at = (joint: T.Bone) => joint.getWorldPosition(new T.Vector3());
  const twistAxis = at(joints.rHand).sub(at(joints.rElbow)).normalize();
  const hipParent = joints.hips.parent!;
  const hipLocalUp = hipParent
    .worldToLocal(at(joints.hips).add(new T.Vector3(0, 1, 0)))
    .sub(joints.hips.position);

  function clip(name: string, duration: number, frames: number, pose: (t: number) => Pose) {
    const times = Array.from({ length: frames + 1 }, (_, i) => (i * duration) / frames),
      poses = times.map(pose);
    const tracks: T.KeyframeTrack[] = [];
    for (const key of Object.keys(poses[0].rot) as Joint[]) {
      const bone = joints[key],
        world = bone.getWorldQuaternion(new T.Quaternion()).normalize();
      // Convert model-axis offsets into THIS bone's bind frame. Writing Euler angles directly
      // over the local quaternion would lose Blender's non-identity rest rotations.
      const pre = bone.quaternion.clone().multiply(world.clone().invert());
      const values: number[] = [],
        prev = bone.quaternion.clone();
      for (const p of poses) {
        const [x, y, z] = p.rot[key]!;
        const delta = new T.Quaternion().setFromEuler(new T.Euler(rad(x), rad(y), rad(z)));
        if (key === 'rElbow' && p.forearmTwist)
          delta.multiply(new T.Quaternion().setFromAxisAngle(twistAxis, rad(p.forearmTwist)));
        const q = pre.clone().multiply(delta).multiply(world).normalize();
        if (prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        values.push(...q.toArray());
        prev.copy(q);
      }
      tracks.push(new T.QuaternionKeyframeTrack(bone.name + '.quaternion', times, values));
    }
    if (poses[0].hipY !== undefined) {
      tracks.push(
        new T.VectorKeyframeTrack(
          joints.hips.name + '.position',
          times,
          poses.flatMap((p) => joints.hips.position.clone().addScaledVector(hipLocalUp, p.hipY!).toArray())
        )
      );
    }
    return new T.AnimationClip(name, duration, tracks).optimize();
  }

  // Relax the exported A-pose. Both greeting endpoints coincide with the idle at t=0.
  const idle = clip(RIG_CLIPS.idle, 4, 48, (t) => {
    const breath = (1 - Math.cos((tau * t) / 4)) / 2;
    return {
      rot: {
        chest: [-1.8 * breath, 1.5 * breath, 0],
        head: [1.2 * breath, -3 * breath, 0],
        lArm: [-3, 0, -21 + breath],
        rArm: [-3, 0, 21 - breath],
        lElbow: [-6, 0, 0],
        rElbow: [-6, 0, 0],
      },
    };
  });
  const wave = clip(RIG_CLIPS.wave, 3.6, 90, (t) => {
    const lift = ease(t, 0.15, 0.99) * (1 - ease(t, 2.58, 3.5));
    const bend = ease(t, 0.28, 1.06) * (1 - ease(t, 2.65, 3.48));
    const look = ease(t, 0, 0.62) * (1 - ease(t, 2.8, 3.6));
    const beat = Math.sin(tau * 1.45 * (t - 1.03)) * ease(t, 1, 1.28) * (1 - ease(t, 2.26, 2.66));
    return {
      rot: {
        chest: [-2 * look, -6 * look, 2 * lift],
        head: [3 * lift + 4 * ease(t, 2.5, 2.85) * (1 - ease(t, 2.85, 3.36)), 11 * look, -4 * lift],
        lArm: [-3 + 4 * lift, 0, -21 + 2 * lift],
        lElbow: [-6 - 4 * lift, 0, 0],
        rArm: [-3 - 6 * lift, 21 * lift, 21 - 60 * lift],
        rElbow: [-6 + 4 * bend, 0, -110 * bend + 8 * beat],
        rHand: [-4 * bend, 0, -4 * bend + 15 * beat],
      },
      forearmTwist: 75 * bend,
    };
  });

  // In-place gait: during stance an ankle moves back at exactly the reference speed.
  // Solve the two sagittal links from this skeleton's measured thigh and shin lengths.
  const period = 1.04,
    stance = 0.54,
    stride = RIG_WALK_MPS * period;
  const legs = (['l', 'r'] as const).map((side) => {
    const hip = at(joints[`${side}Thigh`]),
      knee = at(joints[`${side}Knee`]),
      ankle = at(joints[`${side}Ankle`]);
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
  // A same-named but collapsed or differently proportioned export must not get invalid IK keys.
  if (
    legs.some(
      ({ a, b, hip, ankle }) => !(a > 0.35 && a < 0.55 && b > 0.35 && b < 0.55 && hip.y - ankle.y > 0.75)
    )
  )
    return;
  const walk = clip(RIG_CLIPS.walk, period, 48, (t) => {
    const p = t / period,
      swing = Math.cos(tau * p),
      hipY = -0.043 - 0.027 * Math.cos(2 * tau * (p - 0.02));
    const rot: Pose['rot'] = {
      chest: [3, 5 * swing, 2 * Math.sin(tau * p)],
      head: [-2, -3 * swing, 0],
      lArm: [-3 + 17 * swing, 0, -19],
      rArm: [-3 - 17 * swing, 0, 19],
      lElbow: [-12 + 7 * swing, 0, 0],
      rElbow: [-12 - 7 * swing, 0, 0],
    };
    for (const { side, hip, ankle, a, b, thighBind, shinBind } of legs) {
      const phase = (p + (side === 'l' ? 0 : 0.5)) % 1,
        u = Math.max(0, (phase - stance) / (1 - stance));
      const z = stride * (stance / 2 - phase + ease(u, 0, 1));
      const down = hip.y + hipY - (ankle.y + 0.095 * Math.sin(Math.PI * u) ** 2);
      const d = Math.hypot(z, down);
      const thigh =
        Math.atan2(z, down) + Math.acos(T.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
      const shin = Math.atan2(z - a * Math.sin(thigh), down - a * Math.cos(thigh));
      const upper = deg(thighBind - thigh),
        lower = deg(shinBind - shin);
      rot[`${side}Thigh`] = [upper, 0, 0];
      rot[`${side}Knee`] = [lower - upper, 0, 0];
      rot[`${side}Ankle`] = [-lower, 0, 0];
    }
    return { rot, hipY };
  });
  return [wave, idle, walk]; // the first action is also the preview in many external GLB viewers
}
