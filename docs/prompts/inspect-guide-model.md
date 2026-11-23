# Implementation prompt: Use an inserted GLB as the tour guide

Implement a **Guide model** selector inside PlanWalk Studio’s **Inspect Guide** panel. A user who has already inserted `data/humans/man-rig.glb` must be able to use that character in place of Elena. Change the guide’s appearance and animation, not who controls the tour.

**Required user flow:** **Insert human → Local GLB → `man-rig.glb` → Insert into scene → Inspect Guide → Guide model → select the inserted character.** Also support the same model inserted via **Studio library → Rigged visitor**. Neither a motion take nor a second file selection is required. Insertion alone must never change the guide.

### What the user should see

- Put a keyboard-accessible, labelled selector above the inspector’s body-region tabs. Offer **Elena (default)** and identify each inserted candidate by actor label and filename (e.g. **Ada · man-rig.glb**). Key choices by actor ID, not filename: two actors can share a GLB. With no eligible actors, show “Insert a rigged human first.” Explain why an incompatible actor cannot be used; keep the current guide on failure.
- Selecting a character replaces Elena at the guide’s **current position and heading**, not at the extra’s spawn point. Closing the inspector keeps the selection. A floor click or tour stop must move the visible character; the 2D guide marker and follow camera must track it. Preserve the inspector’s existing pause behavior and the tour narration. Update labels such as “Follow Elena” to match the selection.
- This is a reversible role change. While the actor is guiding, park its extra take and hide its extra marker and body; do not show two copies or consume another cast slot. Mark it **Active guide** in the cast list. Extra pause/replay controls must not drive the guide; other extras keep their own clocks. Selecting Elena restores the actor at its previous extra position and take state. Removing the active source, clearing the cast or resetting/changing presets must safely return to Elena.

### Implementation constraints

- Wire `src/components/GuideInspectorPanel.tsx` through `src/App.tsx` to `src/components/Scene3DViewport.tsx` and the live `HumanCast`. Reuse the prepared `HumanModel` from the existing importer; don’t fetch, upload or parse the GLB again. Keep one navigation root and the existing `HumanGuideController` contract. A guide instance needs independent bones and mixer state, not control by the actor’s `walkTo` steps. Don’t dispose shared meshes, textures or LOD geometry while another instance uses them.
- Check the loaded skin and playable clips, not just the basename. The original `man-rig.glb` is clipless on disk; the importer supplies `EasyIdle`, `HallwayWalk_IP` and `WelcomeWave` via `packages/humanoid-motion`. Use those actions: idle at rest, loop the in-place walk at guide travel speed divided by its **1.2 m/s** reference speed, and play Wave once before returning to locomotion or idle. Don’t request `Visitor.glb`’s `Relaxed` clip.
- Frame **Full Body, Head, Hands and Feet** using the selected character’s bounds and mapped joints. Only offer gestures the rig supports; do not promise Elena’s finger, toe or facial articulation. Keep Elena’s existing inspector unchanged when she is selected.
- Draw the imported guide as a skinned mesh in **both Spark/Gaussian and triangle modes**. Suppress Elena’s meshes, splats and picking targets while replaced, including after renderer/quality switches. Do not convert the imported skin to splats, reload the office capture, modify either source asset or change the motion JSON schema.

### Definition of done

Add Playwright coverage using the real local `man-rig.glb`, including an insertion with Ada’s sample take. Verify that the selected rig actually walks to a clicked destination and waves, not merely that the selector label changes. Check both render modes, restoration to Elena, removal of the active source, and an ineligible model. Run `npx tsc --noEmit`, `npm run test:humanoid`, `npm run build` and `npx playwright test`. Report changed files, how to try the feature and which checks passed or were not run.
