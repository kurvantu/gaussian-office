import * as T from 'three';
import { CLIPS, WALK_REF_MPS, type Role } from '../../../packages/humanoid-motion/src/index';
import type { HumanGuideController } from '../createHumanGuide';
import { HumanInstance } from './instance';
import type { GuideBinding, HumanModel } from './model';

/** No take, spawn, or route here. Only the parent navigation root moves across the floor. */
export class ImportedGuide extends HumanInstance implements HumanGuideController {
  private readonly idle = this.mixer.clipAction(this.clips.get(CLIPS.idle)!);
  private readonly walk = this.mixer.clipAction(this.clips.get(CLIPS.walk)!);
  private readonly wave = this.mixer.clipAction(this.clips.get(CLIPS.wave)!).setLoop(T.LoopOnce, 1);
  private action = this.idle;
  private readonly worldPos = new T.Vector3();

  constructor(model: HumanModel, private binding: GuideBinding, private mobile: boolean) {
    super(model, 'Imported_guide');
    this.wave.clampWhenFinished = true;
    this.updateLod(0, mobile);
    this.idle.play();
    this.mixer.update(0);
  }

  private play(next: T.AnimationAction) {
    if (this.action !== next) this.action.stop();
    this.action = next.reset().play();
  }

  triggerWave() { this.play(this.wave); }
  triggerPresent() { /* No presentation clip: stay in natural idle during narration. */ }

  update({ dt, isWalking, walkSpeed, lookTargetWorld }: Parameters<HumanGuideController['update']>[0]) {
    if (isWalking) {
      if (this.action !== this.walk) this.play(this.walk);
      this.walk.timeScale = walkSpeed / WALK_REF_MPS;
    } else if (this.action === this.walk || (this.action === this.wave && !this.wave.isRunning())) {
      this.play(this.idle);
    }
    this.mixer.update(dt);
    if (lookTargetWorld) this.updateLod(this.root.getWorldPosition(this.worldPos).distanceTo(lookTargetWorld), this.mobile);
  }

  getInspectAnchorWorld(target: Parameters<HumanGuideController['getInspectAnchorWorld']>[0]) {
    const { bounds, rig } = this.binding;
    const height = bounds.max.y - bounds.min.y;
    const at = (role: Role) => this.skin.getObjectByName(rig.joints[role].name)!.getWorldPosition(new T.Vector3());
    const focus = this.root.localToWorld(bounds.getCenter(new T.Vector3()));
    const offset = new T.Vector3(0.1, 0.08, 1.6).multiplyScalar(height);
    if (target === 'head') {
      focus.copy(at('head'));
      focus.y += (bounds.max.y - rig.joints.head.position.y) * 0.45;
      offset.set(0.06, 0.02, 0.38).multiplyScalar(height);
    } else if (target === 'hands' || target === 'feet') {
      const hands = target === 'hands';
      const left = at(hands ? 'leftHand' : 'leftFoot');
      const right = at(hands ? 'rightHand' : 'rightFoot');
      focus.addVectors(left, right).multiplyScalar(0.5);
      offset.set(0, hands ? 0.06 : 0.18, 1).multiplyScalar(Math.max(height * 0.34, left.distanceTo(right) * 1.6));
    }
    return { focus, idealCamOffset: offset.applyQuaternion(this.root.getWorldQuaternion(new T.Quaternion())) };
  }
}
