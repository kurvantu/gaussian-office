import * as T from 'three';
import { library, type LibraryId } from './library';
import type { FloorplanData, Point2D } from '../../types/floorplan';
import type { NavGrid } from '../../utils/pathfinding';
import { HumanActor } from './actor';
import { disposeModel, loadModel, type GenerateMotion, type HumanModel } from './model';
import { MAX_ACTORS, nearbyMark, readTake, type ActorSpec, type ModelSpec, type Navigation } from './take';

export interface CastState {
  people: { id: string; label: string; file: string }[];
  paused: boolean;
  problem: string | null;
}
export const emptyCast: CastState = { people: [], paused: false, problem: null };
export type ModelSource = LibraryId | File[];

/** Viewport-owned session; nothing here owns or animates the guide, architecture or capture. */
export class HumanCast {
  readonly group = new T.Group();
  markers: { label: string; position: Point2D }[] = [];
  private actors: HumanActor[] = [];
  private readonly shelfOrigins = new WeakMap<HumanModel, LibraryId>();
  private nav?: Navigation;
  private pending?: AbortController;
  private paused = false;
  private problem: string | null = null;

  constructor(
    private guide: T.Object3D,
    private mobile: boolean,
    private onChange: (state: CastState) => void
  ) {
    this.group.name = 'Inserted_humans';
  }

  private publish() {
    this.markers = this.actors.map((a) => ({ label: a.label, position: a.root.position }));
    this.onChange({
      people: this.actors.map((a) => ({ id: a.spec.id, label: a.label, file: a.asset.file })),
      paused: this.paused,
      problem: this.problem,
    });
  }

  setNavigation(plan: FloorplanData, grid: NavGrid) {
    if (this.nav && this.nav.plan.id !== plan.id) this.clear();
    this.nav = { plan, grid };
    this.revalidate();
  }

  private revalidate() {
    if (!this.actors.length || !this.nav) return;
    const previous = this.problem;
    try {
      let changed = false;
      for (const a of this.actors) if (a.rebuildRoutes(this.nav)) changed = true;
      this.problem = null;
      if (changed || previous) this.actors.forEach((a) => a.replay());
    } catch (e) {
      this.paused = true;
      this.problem = `Plan changed. ${e instanceof Error ? e.message : 'A mark is no longer reachable.'} Undo the edit or remove the human.`;
    }
    if (this.problem !== previous) this.publish();
  }

  cancelInsert() {
    this.pending?.abort();
  }

  async insert(source: ModelSource, text: string, generate?: GenerateMotion) {
    this.cancelInsert();
    const token = new AbortController(),
      { signal } = token;
    this.pending = token;
    const staged: HumanActor[] = [],
      models = new Map<string, HumanModel>();
    try {
      if (!this.nav) throw new Error('The scene is still starting. Try again in a moment.');
      const take = text.trim() ? readTake(text) : null;
      if (take && this.nav.plan.id !== 'office')
        throw new Error('v1 motion takes use the Office Dining Hall floorplan.');
      const shelf = typeof source === 'string' ? library[source] : null;
      const names = Array.isArray(source) ? source.map((f) => f.name) : [library[source].file];
      if (generate && !Array.isArray(source))
        throw new Error('Choose Local GLB to generate humanoid motion.');
      if (generate?.profile && names.length !== 1)
        throw new Error(
          'Use a separate bone map with one GLB at a time, or embed each profile in its scene.'
        );
      if (!names.length) throw new Error('Choose a local .glb model first.');
      if (names.length > 2 || new Set(names).size !== names.length)
        throw new Error('Choose up to two uniquely named GLB files.');
      if (this.actors.length + (take?.actors.length ?? names.length) > MAX_ACTORS)
        throw new Error('Two additional humans fit in the scene. Remove a human before inserting another.');
      const assets = new Map<string, ModelSpec>(
        take
          ? Object.entries(take.models)
          : names.map((file, i) => [`model-${i}`, { file, idleClip: shelf?.idleClip }])
      );
      const usedFiles = new Set(Array.from(assets.values(), (m) => m.file));
      for (const name of usedFiles)
        if (!names.includes(name)) throw new Error(`models: select “${name}” (exact filename).`);
      for (const name of names)
        if (!usedFiles.has(name)) throw new Error(`models: “${name}” is not named in this take.`);
      const taken = new Set(this.actors.map((a) => a.spec.id));
      for (const a of take?.actors ?? [])
        if (taken.has(a.id)) throw new Error(`actors: “${a.id}” is already in the scene.`);

      // The shelf entry is a first-party Vite asset. User-selected GLBs never leave the browser.
      if (Array.isArray(source)) {
        for (const file of source) {
          signal.throwIfAborted();
          models.set(file.name, await loadModel(file, signal, this.mobile, generate));
        }
      } else {
        const entry = library[source];
        // Share prepared textures and index buffers only from a still-live shelf instance,
        // never from a user upload which happens to have the same basename.
        let model = this.actors.find((a) => this.shelfOrigins.get(a.model) === source)?.model;
        if (!model) {
          const response = await fetch(entry.url, { signal });
          if (!response.ok) throw new Error(`Could not load ${entry.file} (HTTP ${response.status}).`);
          model = await loadModel(new File([await response.blob()], entry.file), signal, this.mobile);
          this.shelfOrigins.set(model, source);
        }
        models.set(entry.file, model);
      }
      signal.throwIfAborted();

      // Validate against the current (possibly edited) plan, then commit all or none.
      const occupied = this.actors.map((a) => a.root.position as Point2D);
      const specs: ActorSpec[] =
        take?.actors ??
        Array.from(assets, ([model, asset]): ActorSpec => {
          const { file } = asset;
          const preview = models.get(file)!.previewMotion;
          if (preview) asset.idleClip = preview.idleClip; // no defaults override an explicit take
          let stem =
            shelf?.actorId ??
            file
              .slice(0, -4)
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/-$/, '')
              .slice(0, 26);
          if (!/^[a-z]/.test(stem) || stem === 'elena') stem = 'visitor';
          let id = stem,
            n = 1;
          while (taken.has(id)) id = `${stem}-${++n}`;
          taken.add(id);
          const spawn = nearbyMark(this.guide.position, this.guide.rotation.y, occupied, this.nav!);
          occupied.push(spawn);
          return { id, model, spawn, steps: preview ? [{ op: 'play', clip: preview.openingClip }] : [] };
        });
      for (const [i, spec] of specs.entries()) {
        const asset = assets.get(spec.model)!;
        const label = spec.id[0].toUpperCase() + spec.id.slice(1).replace(/-/g, ' ');
        const actor = new HumanActor(
          spec,
          models.get(asset.file)!,
          asset,
          label,
          take ? `${label} · actors[${i}]` : label
        );
        staged.push(actor);
        actor.prepare(this.nav);
        actor.updateLod(0, this.mobile);
      }
      for (const actor of staged) this.group.add(actor.root);
      this.actors.push(...staged);
      this.publish();
      return staged.map((a) => a.label);
    } catch (error) {
      staged.forEach((a) => a.dispose());
      throw error;
    } finally {
      for (const m of models.values()) if (!this.actors.some((a) => a.model === m)) disposeModel(m);
      if (this.pending === token) this.pending = undefined;
    }
  }

  update(dt: number, camera: T.Vector3) {
    for (const actor of this.actors) {
      if (!this.paused) actor.update(dt);
      actor.updateLod(actor.root.position.distanceTo(camera), this.mobile);
    }
  }

  togglePause() {
    if (!this.problem) {
      this.paused = !this.paused;
      this.publish();
    }
  }
  replay() {
    if (!this.problem) {
      this.actors.forEach((a) => a.replay());
      this.paused = false;
      this.publish();
    }
  }

  remove(id: string) {
    this.cancelInsert();
    const actor = this.actors.find((a) => a.spec.id === id);
    if (!actor) return;
    actor.dispose();
    this.actors = this.actors.filter((a) => a !== actor);
    if (!this.actors.some((a) => a.model === actor.model)) disposeModel(actor.model);
    if (!this.actors.length) {
      this.paused = false;
      this.problem = null;
    } else this.revalidate();
    this.publish();
  }

  clear() {
    this.cancelInsert();
    const models = new Set(this.actors.map((a) => a.model));
    this.actors.forEach((a) => a.dispose());
    models.forEach(disposeModel);
    this.actors = [];
    this.paused = false;
    this.problem = null;
    this.publish();
  }
}
