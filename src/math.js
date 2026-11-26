// Minimal fixed-size vector / 4x4 matrix helpers for the VRS demo.
// Vectors are {x,y,z,w?}. Matrices are column-major arrays of 16 numbers.

export function v3(x = 0, y = 0, z = 0) { return { x, y, z }; }
export function add(a, b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
export function sub(a, b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
export function scale(a, s) { return v3(a.x * s, a.y * s, a.z * s); }
export function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function cross(a, b) {
  return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
export function length(a) { return Math.hypot(a.x, a.y, a.z); }
export function norm(a) {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : v3(0, 0, 0);
}

export function perspective(fovYRad, aspect, near, far) {
  const f = 1 / Math.tan(fovYRad / 2);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function lookAt(eye, center, up) {
  const z = norm(sub(eye, center));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const m = new Float64Array(16);
  m[0] = x.x; m[1] = y.x; m[2] = z.x; m[3] = 0;
  m[4] = x.y; m[5] = y.y; m[6] = z.y; m[7] = 0;
  m[8] = x.z; m[9] = y.z; m[10] = z.z; m[11] = 0;
  m[12] = -dot(x, eye); m[13] = -dot(y, eye); m[14] = -dot(z, eye); m[15] = 1;
  return m;
}

export function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

export function transform(m, p) {
  const x = p.x, y = p.y, z = p.z;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return {
    x: m[0] * x + m[4] * y + m[8] * z + m[12],
    y: m[1] * x + m[5] * y + m[9] * z + m[13],
    z: m[2] * x + m[6] * y + m[10] * z + m[14],
    w,
  };
}
