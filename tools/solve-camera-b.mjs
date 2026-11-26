// Solves a camera look-at direction so a chosen world point lands on a chosen
// screen coordinate, and prints coverage grids for both jump cameras.
import { makeCamera, project, primaryRay, intersectScene, hitAttributes, PERSON, WIDTH, HEIGHT, SHARED_GAZE, FOV_Y, MATERIALS } from '../src/scene.js';
import { v3, norm, sub, cross, dot, scale, add } from '../src/math.js';

const ASPECT = WIDTH / HEIGHT;
const tanHalf = Math.tan(FOV_Y / 2);

function aim(eye, point, sx, sy) {
  const nx = (sx / WIDTH) * 2 - 1;
  const ny = 1 - (sy / HEIGHT) * 2;
  const d = norm(sub(point, eye));
  let f = d;
  for (let it = 0; it < 50; it++) {
    const right = norm(cross(f, v3(0, 1, 0)));
    const upv = cross(right, f);
    const off = add(scale(right, nx * tanHalf * ASPECT), scale(upv, ny * tanHalf));
    const c = dot(off, d);
    const o2 = dot(off, off);
    const lam = c + Math.sqrt(Math.max(0, c * c + 1 - o2));
    f = norm(sub(scale(d, lam), off));
  }
  const cam = { eye, f, right: norm(cross(f, v3(0, 1, 0))), upv: cross(norm(cross(f, v3(0, 1, 0))), f), tanHalf, aspect: ASPECT };
  return cam;
}

const EYE = PERSON.eyeL.c;
const CAM_B_EYE = v3(5.75, 0.42, 1.35);
const camB = aim(CAM_B_EYE, EYE, SHARED_GAZE.x, SHARED_GAZE.y);
const eyeProj = project(camB, EYE);
console.log('shared gaze', SHARED_GAZE, ' eye projection in B', eyeProj.x.toFixed(1), eyeProj.y.toFixed(1), 'depth', eyeProj.depth.toFixed(2));
console.log('camB f', camB.f, 'eye', CAM_B_EYE);

const MATS = { wall: '.', poster: 'P', rod: '|', lamp: 'L', skin: 'S', shirt: 'T', eyeWhite: 'o', pupil: '@', hair: 'H' };
function grid(cam, label) {
  console.log('\n' + label);
  for (let j = 0; j < 26; j++) {
    let row = '';
    for (let i = 0; i < 72; i++) {
      const ray = primaryRay(cam, (i + 0.5) * WIDTH / 72, (j + 0.5) * HEIGHT / 26);
      const hit = intersectScene(ray);
      row += hit ? MATS[MATERIALS[hit.objectId]] : ' ';
    }
    console.log(row);
  }
}
grid(camB, 'CAMERA B (person revealed)');
console.log('\nGaze hit in B:', (() => {
  const ray = primaryRay(camB, SHARED_GAZE.x, SHARED_GAZE.y);
  const h = intersectScene(ray);
  return h ? MATERIALS[h.objectId] + ' id=' + h.objectId : 'miss';
})());

// also camera A poster test at same point
import { CAMERA_A } from '../src/scene.js';
const ra = primaryRay(CAMERA_A, SHARED_GAZE.x, SHARED_GAZE.y);
const ha = intersectScene(ra);
console.log('Gaze hit in A:', ha ? MATERIALS[ha.objectId] + ' id=' + ha.objectId : 'miss');
console.log('\nEXPORT camB eye=', CAM_B_EYE, 'f=', camB.f);
