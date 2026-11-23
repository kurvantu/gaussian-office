import * as T from 'three';
import { createHumanGuide, type HumanGuideController } from './createHumanGuide';
import { ImportedGuide } from './humans/importedGuide';
import { guideIssue, type HumanModel } from './humans/model';

/** Cameras, pathfinding and the plan marker follow this root for the entire session. */
export class TourGuide {
  readonly root = new T.Group();
  readonly elena = createHumanGuide();
  private imported: ImportedGuide | null = null;

  constructor(private mobile: boolean) {
    this.root.name = 'Tour_guide';
    this.root.add(this.elena.root);
  }

  get avatar(): HumanGuideController { return this.imported ?? this.elena; }

  setModel(model: HumanModel | null) {
    // Build before releasing the current guide. The source actor owns the model's lifetime.
    let next: ImportedGuide | null = null;
    if (model) {
      if (!model.guideBinding) throw new Error(guideIssue(model)!);
      next = new ImportedGuide(model, model.guideBinding, this.mobile);
    }
    this.imported?.dispose();
    this.imported = next;
    this.elena.root.visible = !next;
    if (next) this.root.add(next.root);
  }

  hitTest(ray: T.Raycaster) {
    // Raycaster does not respect Object3D.visible. Exclude the inactive avatar, floor aura
    // and hidden LODs explicitly; Elena's layer-1 Gaussian proxies remain pickable.
    const targets: T.Mesh[] = [];
    this.avatar.root.traverseVisible(node => {
      if (node instanceof T.Mesh && !node.userData.keepRaster) targets.push(node);
    });
    return ray.intersectObjects(targets, false).length > 0;
  }

  dispose() {
    this.imported?.dispose();
    this.elena.dispose();
    this.root.removeFromParent();
  }
}
