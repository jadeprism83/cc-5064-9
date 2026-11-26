import { v3, dot, cross, norm, sub, add, scale } from './math.js';

export const WIDTH = 640;
export const HEIGHT = 360;
export const ASPECT = WIDTH / HEIGHT;
export const FOV_Y = 36 * Math.PI / 180;

export const IDS = {
  wall: 0,
  poster: 1,
  rod0: 2, rod1: 3, rod2: 4, rod3: 5,
  lampL: 6, lampR: 7,
  hair: 8,
  head: 9,
  torso: 10,
  collar: 11,
  nose: 12,
  eyeL: 13, pupilL: 14,
  eyeR: 15, pupilR: 16,
};

export const MATERIALS = {
  [IDS.wall]: 'wall',
  [IDS.poster]: 'poster',
  [IDS.rod0]: 'rod', [IDS.rod1]: 'rod', [IDS.rod2]: 'rod', [IDS.rod3]: 'rod',
  [IDS.lampL]: 'lamp', [IDS.lampR]: 'lamp',
  [IDS.hair]: 'hair', [IDS.head]: 'skin', [IDS.torso]: 'shirt',
  [IDS.collar]: 'shirt', [IDS.nose]: 'skin',
  [IDS.eyeL]: 'eyeWhite', [IDS.eyeR]: 'eyeWhite',
  [IDS.pupilL]: 'pupil', [IDS.pupilR]: 'pupil',
};

// World-space anchors shared with the UI / provenance checks.
export const PERSON = {
  head: { c: v3(-0.4, 1.25, -5.0), r: 1.0 },
  hair: { c: v3(-0.45, 1.52, -5.18), r: 1.04 },
  torso: { c: v3(-0.45, -0.95, -5.3), r: 1.5 },
  collar: { c: v3(-0.42, 0.18, -5.25), r: 0.52 },
  nose: { c: v3(-0.4, 1.02, -4.24), r: 0.24 },
  eyeL: { c: v3(-0.02, 1.47, -4.12), r: 0.32 },   // +x eye, faces camera B
  eyeR: { c: v3(-0.78, 1.47, -4.12), r: 0.32 },
  pupilDir: norm(v3(0.16, 0.12, 0.98)),
};

const POSTER_NORMAL = norm(v3(0.10, 0.015, 1));
const POSTER_U = norm(cross(POSTER_NORMAL, v3(0, 1, 0)));
const POSTER_V = norm(cross(POSTER_U, POSTER_NORMAL));
const POSTER_CENTER = v3(0, 0, -3);
const POSTER_HALF = { u: 1.2, v: 1.5 };

const WALL_Z = -6.2;
const RODS = [
  { x: -0.9, z: -2.2, r: 0.011, id: IDS.rod0 },
  { x: -0.55, z: -2.2, r: 0.0085, id: IDS.rod1 },
  { x: 0.22, z: -2.2, r: 0.013, id: IDS.rod2 },
  { x: 0.68, z: -2.2, r: 0.009, id: IDS.rod3 },
];
const ROD_Y = { min: -1.35, max: 1.35 };

const LAMPS = [
  { id: IDS.lampL, x0: -3.02, x1: -2.5, y0: -1.9, y1: 1.9, z: -6.18 },
  { id: IDS.lampR, x0: 2.5, x1: 3.02, y0: -1.9, y1: 1.9, z: -6.18 },
];

export const OBJECTS = (() => {
  const objects = [];
  objects.push({ id: IDS.wall, kind: 'plane', material: 'wall', normal: v3(0, 0, 1), point: v3(0, 0, WALL_Z) });
  objects.push({
    id: IDS.poster, kind: 'quad', material: 'poster',
    normal: POSTER_NORMAL, center: POSTER_CENTER,
    u: POSTER_U, v: POSTER_V, half: POSTER_HALF,
  });
  for (const rod of RODS) {
    objects.push({ id: rod.id, kind: 'rod', material: 'rod', x: rod.x, z: rod.z, r: rod.r, yMin: ROD_Y.min, yMax: ROD_Y.max });
  }
  for (const lamp of LAMPS) {
    objects.push({
      id: lamp.id, kind: 'quad', material: 'lamp',
      normal: v3(0, 0, 1), center: v3((lamp.x0 + lamp.x1) / 2, (lamp.y0 + lamp.y1) / 2, lamp.z),
      u: v3(1, 0, 0), v: v3(0, 1, 0),
      half: { u: (lamp.x1 - lamp.x0) / 2, v: (lamp.y1 - lamp.y0) / 2 },
      emit: true,
    });
  }
  for (const name of ['hair', 'head', 'torso', 'collar', 'nose', 'eyeL', 'eyeR']) {
    objects.push({ id: IDS[name], kind: 'sphere', material: MATERIALS[IDS[name]], ...PERSON[name] });
  }
  for (const name of ['eyeL', 'eyeR']) {
    const base = PERSON[name];
    const c = add(base.c, scale(PERSON.pupilDir, base.r * 0.72));
    objects.push({ id: name === 'eyeL' ? IDS.pupilL : IDS.pupilR, kind: 'sphere', material: 'pupil', c, r: base.r * 0.4 });
  }
  return objects;
})();

const MAT = new Uint8Array(17);
const DEPTH_SCALE = new Float32Array(17);
// Per-object uv extents used to turn pixel footprints into texture derivatives.
for (const o of OBJECTS) {
  MAT[o.id] = o.material === 'poster' ? 1 : o.material === 'rod' ? 2 : o.material === 'lamp' ? 3 :
    o.material === 'wall' ? 4 : o.material === 'skin' ? 5 : o.material === 'shirt' ? 6 :
    o.material === 'eyeWhite' ? 7 : o.material === 'pupil' ? 8 : 9;
  DEPTH_SCALE[o.id] =
    o.kind === 'quad' ? Math.max(o.half.u * 2, o.half.v * 2) :
    o.kind === 'rod' ? 2.7 :
    o.kind === 'sphere' ? Math.PI * o.r :
    o.id === IDS.wall ? 8 : 1;
}
export const MATERIAL_CODE = MAT;
export const UV_SCALE = DEPTH_SCALE;

export function makeCamera(eye, target, up = v3(0, 1, 0), fovY = FOV_Y) {
  const f = norm(sub(target, eye));
  const right = norm(cross(f, up));
  const upv = cross(right, f);
  const tanHalf = Math.tan(fovY / 2);
  return { eye, f, right, upv, tanHalf, aspect: ASPECT };
}

export function primaryRay(cam, px, py, W = WIDTH, H = HEIGHT) {
  const ndcx = (px / W) * 2 - 1;
  const ndcy = 1 - (py / H) * 2;
  const dir = norm(add(cam.f, add(scale(cam.right, ndcx * cam.tanHalf * cam.aspect), scale(cam.upv, ndcy * cam.tanHalf))));
  return { o: cam.eye, d: dir };
}

export function project(cam, point, W = WIDTH, H = HEIGHT) {
  const q = sub(point, cam.eye);
  const zc = dot(q, cam.f);
  const ndcx = dot(q, cam.right) / (zc * cam.tanHalf * cam.aspect);
  const ndcy = dot(q, cam.upv) / (zc * cam.tanHalf);
  return { x: (ndcx + 1) * 0.5 * W, y: (1 - ndcy) * 0.5 * H, depth: zc, visible: zc > 0 };
}

function intersectSphere(ray, o) {
  const ox = ray.o.x - o.c.x, oy = ray.o.y - o.c.y, oz = ray.o.z - o.c.z;
  const b = ox * ray.d.x + oy * ray.d.y + oz * ray.d.z;
  const c = ox * ox + oy * oy + oz * oz - o.r * o.r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 1e-4) t = -b + sq;
  return t >= 1e-4 ? t : -1;
}

function intersectPlane(ray, normal, point) {
  const denom = dot(ray.d, normal);
  if (Math.abs(denom) < 1e-6) return -1;
  return dot(sub(point, ray.o), normal) / denom;
}

function intersectRod(ray, o) {
  const ox = ray.o.x - o.x, oz = ray.o.z - o.z;
  const dx = ray.d.x, dz = ray.d.z;
  const a = dx * dx + dz * dz;
  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - o.r * o.r;
  if (a < 1e-9) return -1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 1e-4) t = (-b + sq) / (2 * a);
  if (t < 1e-4) return -1;
  const y = ray.o.y + t * ray.d.y;
  if (y < o.yMin || y > o.yMax) return -1;
  return t;
}

// Geometry pass: attributes + depth only, no material shading.
export function intersectScene(ray) {
  let bestT = Infinity;
  let best = null;
  for (const o of OBJECTS) {
    let t = -1;
    if (o.kind === 'plane') t = intersectPlane(ray, o.normal, o.point);
    else if (o.kind === 'quad') {
      const p = intersectPlane(ray, o.normal, o.center);
      if (p > 0) {
        const local = sub(add(ray.o, scale(ray.d, p)), o.center);
        const a = dot(local, o.u), b = dot(local, o.v);
        if (a >= -o.half.u && a <= o.half.u && b >= -o.half.v && b <= o.half.v) t = p;
      }
    } else if (o.kind === 'rod') t = intersectRod(ray, o);
    else if (o.kind === 'sphere') t = intersectSphere(ray, o);
    if (t > 0 && t < bestT) { bestT = t; best = o; }
  }
  if (!best) return null;
  const p = add(ray.o, scale(ray.d, bestT));
  return { t: bestT, object: best, objectId: best.id, materialCode: MAT[best.id], point: p };
}

// Full attribute evaluation at an already-known surface point. Shared by the
// VRS shading path and the full-quality reference so both use identical uv,
// normal and view-angle math.
export function attributesAtPoint(o, px, py, pz, dx, dy, dz) {
  let u = 0, v = 0, nx = 0, ny = 0, nz = 1, cosView = 1;
  if (o.kind === 'plane' || o.kind === 'quad') {
    nx = o.normal.x; ny = o.normal.y; nz = o.normal.z;
    const lx = px - (o.center ?? o.point).x;
    const ly = py - (o.center ?? o.point).y;
    const lz = pz - (o.center ?? o.point).z;
    if (o.kind === 'quad') {
      u = (lx * o.u.x + ly * o.u.y + lz * o.u.z) / (o.half.u * 2) + 0.5;
      v = (lx * o.v.x + ly * o.v.y + lz * o.v.z) / (o.half.v * 2) + 0.5;
    } else {
      u = px / 8 + 0.5;
      v = py / 6 + 0.5;
    }
    cosView = Math.abs(dx * nx + dy * ny + dz * nz);
  } else if (o.kind === 'rod') {
    const localX = px - o.x, localZ = pz - o.z;
    nx = localX / o.r; nz = localZ / o.r; ny = 0;
    u = Math.atan2(localZ, localX) / (Math.PI * 2) + 0.5;
    v = (py - o.yMin) / (o.yMax - o.yMin);
    cosView = Math.abs(nx * dx + nz * dz);
  } else {
    const lx = (px - o.c.x) / o.r, ly = (py - o.c.y) / o.r, lz = (pz - o.c.z) / o.r;
    nx = lx; ny = ly; nz = lz;
    u = Math.atan2(lx, lz) / (Math.PI * 2) + 0.5;
    v = Math.acos(Math.max(-1, Math.min(1, ly))) / Math.PI;
    cosView = Math.abs(dx * nx + dy * ny + dz * nz);
  }
  return { u, v, normal: { x: nx, y: ny, z: nz }, cosView: Math.max(0.2, cosView) };
}

// Full hit record (uv, normal), computed lazily only when a sample is shaded.
export function hitAttributes(hit, ray) {
  return attributesAtPoint(hit.object, hit.point.x, hit.point.y, hit.point.z, ray.d.x, ray.d.y, ray.d.z);
}

const GAZE_SHARED = { x: 0.5, y: 0.5 };

// Solves a camera direction so `point` projects exactly onto (sx, sy).
export function makeCameraAiming(eye, point, sx, sy, W = WIDTH, H = HEIGHT) {
  const nx = (sx / W) * 2 - 1;
  const ny = 1 - (sy / H) * 2;
  const d = norm(sub(point, eye));
  const tanHalf = Math.tan(FOV_Y / 2);
  let f = d;
  for (let it = 0; it < 64; it++) {
    const right = norm(cross(f, v3(0, 1, 0)));
    const upv = cross(right, f);
    const off = add(scale(right, nx * tanHalf * ASPECT), scale(upv, ny * tanHalf));
    const c = dot(off, d);
    const o2 = dot(off, off);
    f = norm(sub(scale(d, c + Math.sqrt(Math.max(0, c * c + 1 - o2)), off)));
  }
  const right = norm(cross(f, v3(0, 1, 0)));
  return { eye, f, right, upv: cross(right, f), tanHalf, aspect: ASPECT };
}

// Camera A: looks straight at the poster, person is fully occluded.
export const CAMERA_A = makeCamera(v3(0, 0, 2.2), v3(0, 0, -3.0));

// Gaze point shared by both jump scenarios (identical screen coordinates).
// In A it lands on the poster; in B it lands on the re-exposed eye.
export const SHARED_GAZE = { x: 330, y: 150 };

// Camera B: cut to a far-right off-axis position. The poster now hides only the
// left part of the person, the +x eye is revealed at SHARED_GAZE.
export const CAMERA_B = makeCameraAiming(v3(7.4, 0.8, 0.8), PERSON.eyeL.c, SHARED_GAZE.x, SHARED_GAZE.y);

export function eyeScreenPosition(cam = CAMERA_B) {
  return project(cam, PERSON.eyeL.c);
}
