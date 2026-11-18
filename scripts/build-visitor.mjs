// Original PlanWalk library asset. Rebuild with: node scripts/build-visitor.mjs
// Dimensions in metres, feet at Y=0, face +Z. All four skins share one rig.
import * as T from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mkdir, writeFile } from 'node:fs/promises';

// GLTFExporter's binary writer uses the browser FileReader API for two Blobs.
globalThis.FileReader = class {
  async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend(); }
};
const scene = new T.Scene();
const bones = [], origins = [];
function joint(name, parent, x, y, z = 0) {
  const b = new T.Bone(), origin = new T.Vector3(x, y, z);
  b.name = name; b.position.copy(origin);
  if (parent !== null) { b.position.sub(origins[parent]); bones[parent].add(b); }
  else scene.add(b);
  origins.push(origin); bones.push(b); return bones.length - 1;
}
const hips = joint('Hips', null, 0, 0.93), chest = joint('Chest', hips, 0, 1.03);
const head = joint('Head', chest, 0, 1.48);
const sides = [-1, 1].map(s => {
  const side = s < 0 ? 'R' : 'L';
  const arm = joint(`Shoulder_${side}`, chest, s * .19, 1.40);
  const elbow = joint(`Elbow_${side}`, arm, s * .224, 1.14);
  const wrist = joint(`Wrist_${side}`, elbow, s * .235, .925, .035);
  const hip = joint(`Hip_${side}`, hips, s * .092, .91);
  const knee = joint(`Knee_${side}`, hip, s * .092, .50);
  return { s, arm, elbow, wrist, hip, knee, foot: joint(`Ankle_${side}`, knee, s * .092, .115) };
});
scene.updateMatrixWorld(true);
const rig = new T.Skeleton(bones);
const cloth = '#47746e', trim = '#315553', pants = '#384351', skin = '#ad7354', hair = '#372e2f', shoe = '#e8dfcb';
const mat = new T.MeshStandardMaterial({ vertexColors: true, roughness: .92 });
const counts = [];
for (const [level, n] of [16, 12, 8, 6].entries()) {
  const p = [], c = [], j = [], w = [], idx = [];
  // Sweep closed elliptical sections; each section may be weighted to a different joint.
  function form(bone, color, x, rows) {
    const tint = new T.Color(color), start = p.length / 3;
    function vertex(x, y, z, b) { p.push(x,y,z); c.push(tint.r,tint.g,tint.b); j.push(b,0,0,0); w.push(1,0,0,0); }
    rows.forEach(([y, rx, rz, z = 0, dx = 0, b = bone], k) => {
      for (let i = 0; i < n; i++) {
        const a = i * 2 * Math.PI / n;
        vertex(x + dx + rx * Math.cos(a), y, z + rz * Math.sin(a), b);
        const v = start + k*n+i, next = start+k*n+(i+1)%n;
        if (k > 0) idx.push(v-n,v,next, v-n,next,next-n);
      }
    });
    for (const k of [0,rows.length-1]) {
      const [y,,,z=0,dx=0,b=bone] = rows[k], center = p.length / 3;
      vertex(x+dx,y,z,b);
      for (let i=0; i<n; i++) {
        const a=start+k*n+i, b=start+k*n+(i+1)%n;
        idx.push(center, k ? b : a, k ? a : b);
      }
    }
  }
  form(hips,pants,0,[[.83,.14,.085],[.93,.177,.105],[1.015,.15,.09]]);
  form(chest,cloth,0,[[.923,.174,.105],[1.055,.163,.095],[1.31,.206,.12],[1.40,.205,.10],[1.455,.07,.062]]);
  form(chest,skin,0,[[1.433,.054,.046],[1.533,.056,.055]]);
  form(chest,trim,0,[[1.432,.083,.07],[1.467,.065,.057]]);
  form(head,skin,0,[[1.492,.035,.044,.028],[1.522,.07,.071,.018],[1.594,.09,.091,.007],[1.675,.094,.089],[1.718,.071,.068]]);
  form(head,hair,0,[[1.648,.095,.092,-.006],[1.688,.1,.098,-.009],[1.74,.079,.079,-.014],[1.758,.035,.033,-.019]]);
  form(head,skin,0,[[1.564,.014,.012,.094],[1.576,.018,.015,.098],[1.602,.008,.008,.092]]);
  if (level < 3) form(head,'#874e43',0,[[1.545,.020,.003,.091],[1.549,.022,.004,.091]]);
  for (const {s,arm,elbow,wrist,hip,knee,foot} of sides) {
    const x=s*.092;
    form(hip,pants,x,[[.106,.054,.057,0,0,knee],[.46,.07,.068,0,0,knee],[.525,.073,.083,.005],[.78,.089,.094],[.93,.08,.092]]);
    form(foot,shoe,x,[[0,.067,.123,.043],[.035,.069,.126,.043],[.065,.067,.122,.040],[.115,.053,.07,.003]]);
    form(arm,cloth,s*.19,[[1.127,.053,.055,0,s*.034,elbow],[1.165,.059,.063,0,s*.033],[1.36,.073,.080],[1.412,.055,.065]]);
    form(elbow,trim,s*.224,[[1.102,.051,.056],[1.146,.059,.061]]);
    form(elbow,skin,s*.224,[[.914,.030,.027,.033,s*.011],[1.055,.046,.045,.010],[1.12,.045,.048]]);
    form(wrist,skin,s*.235,[[.813,.020,.029,.043],[.855,.032,.044,.039],[.918,.032,.036,.034]]);
    if (level < 3) form(head,skin,s*.088,[[1.567,.010,.014],[1.596,.018,.023],[1.616,.012,.014]]);
    form(head,hair,s*.038,[[1.606,.012,.004,.091],[1.614,.012,.005,.091]]);
    if (level < 2) form(head,hair,s*.039,[[1.625,.021,.005,.09],[1.631,.023,.005,.09]]);
  }
  // Small stitched pocket and visitor badge on the overshirt.
  if (level < 3) {
    form(chest,trim,.083,[[1.239,.044,.008,.103],[1.319,.044,.009,.108]]);
    form(chest,shoe,.084,[[1.278,.032,.004,.118],[1.313,.032,.004,.118]]);
  }
  const geo = new T.BufferGeometry();
  for (const [name,arr,size] of [['position',p,3],['color',c,3],['skinWeight',w,4]]) geo.setAttribute(name,new T.Float32BufferAttribute(arr,size));
  geo.setAttribute('skinIndex',new T.Uint16BufferAttribute(j,4)); geo.setIndex(idx); geo.computeVertexNormals();
  const mesh = new T.SkinnedMesh(geo,mat); mesh.name = `LOD${level}`; mesh.bind(rig); scene.add(mesh);
  counts.push(idx.length / 3);
}
function rotations(name, times, angles) {
  const values = angles.flatMap(([x=0,y=0,z=0]) => new T.Quaternion().setFromEuler(new T.Euler(...[x,y,z].map(T.MathUtils.degToRad))).toArray());
  return new T.QuaternionKeyframeTrack(name+'.quaternion',times,values);
}
const idle = new T.AnimationClip('Relaxed',-1,[rotations('Chest',[0,1.6,3.2],[[0,0,0],[1.2,1.5,0],[0,0,0]])]);
const stride = [], t=[0,.25,.5,.75,1];
for (const [side,s] of [['L',1],['R',-1]]) {
  for (const [bone,angles] of [['Hip',[25,0,-25,0,25].map(x=>x*s)],['Shoulder',[-19,0,19,0,-19].map(x=>x*s)],['Knee',s===1?[10,36,12,4,10]:[12,4,10,36,12]]]) {
    stride.push(rotations(`${bone}_${side}`,t,angles.map(x=>[x])));
  }
}
const walk = new T.AnimationClip('Stroll_IP',-1,stride);
const wave = new T.AnimationClip('WaveOnce',-1,[
  rotations('Shoulder_R',[0,.36,1.08,1.44],[[0],[-14,0,-82],[-14,0,-82],[0]]),
  rotations('Elbow_R',[0,.36,.54,.72,.9,1.08,1.44],[[0],[-6,0,-61],[-6,0,-87],[-6,0,-61],[-6,0,-87],[-6,0,-61],[0]])
]);
const bytes = await new GLTFExporter().parseAsync(scene,{ binary:true, animations:[idle,walk,wave] });
const dir = new URL('../data/humans/',import.meta.url);
await mkdir(dir,{recursive:true}); await writeFile(new URL('Visitor.glb',dir),new Uint8Array(bytes));
console.log(`Visitor.glb: ${bytes.byteLength} bytes, ${bones.length} bones, ${counts.join('/')} triangles`);
