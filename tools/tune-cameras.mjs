// Tunes / validates the two camera setups for the gaze-jump scenarios.
// Run: node tools/tune-cameras.mjs
import { CAMERA_A, CAMERA_B, SHARED_GAZE, PERSON, WIDTH, HEIGHT, primaryRay, intersectScene, hitAttributes, project, IDS } from '../src/scene.js';
import { MATERIALS } from '../src/scene.js';

function castFrom(cam, sx, sy) {
  const ray = primaryRay(cam, sx, sy);
  const hit = intersectScene(ray);
  return hit ? { id: hit.objectId, mat: MATERIALS[hit.objectId], t: hit.t, attr: hitAttributes(hit, ray), point: hit.point } : null;
}

const eyeB = project(CAMERA_B, PERSON.eyeL.c);
const eyeA = project(CAMERA_A, PERSON.eyeL.c);

console.log('CAMERA_A eye(', PERSON.eyeL.c.x, ') screen=', eyeA.x.toFixed(1), eyeA.y.toFixed(1), 'depth', eyeA.depth.toFixed(2));
const aHitAtEye = castFrom(CAMERA_A, eyeA.x, eyeA.y);
console.log('  camera A ray to eye hits:', aHitAtEye ? `${aHitAtEye.mat} (${aHitAtEye.id})` : 'nothing');
console.log('CAMERA_B eye screen=', eyeB.x.toFixed(1), eyeB.y.toFixed(1), 'depth', eyeB.depth.toFixed(2));

console.log('\nShared gaze target:', SHARED_GAZE);
const bAtGaze = castFrom(CAMERA_B, SHARED_GAZE.x, SHARED_GAZE.y);
console.log('  camera B at gaze hits:', bAtGaze ? `${bAtGaze.mat} (${bAtGaze.id})` : 'nothing', 't=', bAtGaze?.t.toFixed(2));
const aAtGaze = castFrom(CAMERA_A, SHARED_GAZE.x, SHARED_GAZE.y);
console.log('  camera A at gaze hits:', aAtGaze ? `${aAtGaze.mat} (${aAtGaze.id})` : 'nothing', 't=', aAtGaze?.t.toFixed(2));

console.log('\nCamera B coverage grid (mat per cell):');
const sym = { wall: '.', poster: 'P', rod: '|', lamp: 'L', skin: 'S', shirt: 'T', eyeWhite: 'o', pupil: '@', hair: 'H' };
for (let j = 0; j < 24; j++) {
  let row = '';
  for (let i = 0; i < 64; i++) {
    const hit = castFrom(CAMERA_B, (i + 0.5) * WIDTH / 64, (j + 0.5) * HEIGHT / 24);
    row += hit ? sym[hit.mat] : ' ';
  }
  console.log(row);
}
console.log('\nCamera A coverage grid:');
for (let j = 0; j < 24; j++) {
  let row = '';
  for (let i = 0; i < 64; i++) {
    const hit = castFrom(CAMERA_A, (i + 0.5) * WIDTH / 64, (j + 0.5) * HEIGHT / 24);
    row += hit ? sym[hit.mat] : ' ';
  }
  console.log(row);
}
