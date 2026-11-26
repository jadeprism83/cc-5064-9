import { makeCamera, project, primaryRay, intersectScene, hitAttributes, PERSON, WIDTH, HEIGHT, FOV_Y, MATERIALS, CAMERA_A } from '../src/scene.js';
import { v3, norm, sub, cross, dot, scale, add } from '../src/math.js';

const ASPECT = WIDTH / HEIGHT;
const tanHalf = Math.tan(FOV_Y / 2);
const S = { x: 330, y: 150 };
const EYE = PERSON.eyeL.c;

function aim(eye, point, sx, sy) {
  const nx = (sx / WIDTH) * 2 - 1, ny = 1 - (sy / HEIGHT) * 2;
  const d = norm(sub(point, eye));
  let f = d;
  for (let it = 0; it < 60; it++) {
    const right = norm(cross(f, v3(0, 1, 0)));
    const upv = cross(right, f);
    const off = add(scale(right, nx * tanHalf * ASPECT), scale(upv, ny * tanHalf));
    const c = dot(off, d), o2 = dot(off, off);
    const lam = c + Math.sqrt(Math.max(0, c * c + 1 - o2));
    f = norm(sub(scale(d, lam), off));
  }
  const right = norm(cross(f, v3(0, 1, 0)));
  return { eye, f, right, upv: cross(right, f), tanHalf, aspect: ASPECT };
}

// gaze in A
const ra = primaryRay(CAMERA_A, S.x, S.y);
const ha = intersectScene(ra);
console.log('A gaze', S, '->', ha ? MATERIALS[ha.objectId] : 'miss');

let best = null;
for (const cx of [5.4, 5.9, 6.4, 6.9, 7.4]) {
  for (const cz of [3.2, 2.6, 2.0, 1.4, 0.8]) {
    for (const cy of [0.3, 0.8, 1.3]) {
      const cam = aim(v3(cx, cy, cz), EYE, S.x, S.y);
      const rb = primaryRay(cam, S.x, S.y);
      const hb = intersectScene(rb);
      const mat = hb ? MATERIALS[hb.objectId] : 'miss';
      const p = project(cam, EYE);
      // coverage around gaze: count person-material fraction in a 60px box
      let person = 0, tot = 0;
      for (let dy = -40; dy <= 40; dy += 8) for (let dx = -40; dx <= 40; dx += 8) {
        const rr = primaryRay(cam, S.x + dx, S.y + dy);
        const hh = intersectScene(rr); tot++;
        if (hh && ['skin','eyeWhite','pupil','hair','shirt'].includes(MATERIALS[hh.objectId])) person++;
      }
      const ok = mat === 'eyeWhite' || mat === 'pupil';
      const score = (ok ? 100 : 0) + person / tot * 10 + (p.visible ? 0 : -50);
      if (!best || score > best.score) best = { score, cx, cy, cz, mat, p, personFrac: person / tot, ok };
      if (ok && person / tot > 0.25) console.log(`cx=${cx} cz=${cz} cy=${cy} gazeMat=${mat} person=${(person/tot).toFixed(2)} proj=${p.x.toFixed(1)},${p.y.toFixed(1)} depth=${p.depth.toFixed(1)}`);
    }
  }
}
console.log('\nBEST', best && { cx: best.cx, cy: best.cy, cz: best.cz, mat: best.mat, personFrac: best.personFrac.toFixed(2), eyeDepth: best.p.depth.toFixed(1) });
