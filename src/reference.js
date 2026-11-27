// Offline full-quality reference renderer.
//
// This path deliberately renders every pixel at rate 1 and is never imported by
// the runtime quality-map decision path. Acceptance tests use it as ground
// truth and report its cost separately from the adaptive pipeline's cost.
import { WIDTH, HEIGHT, intersectScene, hitAttributes, primaryRay } from './scene.js';
import { shadeAtRay, toDisplay } from './shading.js';

export function renderReference(camera, dynObjects = []) {
  const display = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  const linear = new Float32Array(WIDTH * HEIGHT * 3);
  const depth = new Float32Array(WIDTH * HEIGHT).fill(NaN);
  const ids = new Int16Array(WIDTH * HEIGHT).fill(-1);
  const trace = { shadeCalls: 0 };
  let traceCalls = 0, shadeCalls = 0;

  for (let py = 0; py < HEIGHT; py++) {
    for (let px = 0; px < WIDTH; px++) {
      const idx = py * WIDTH + px;
      const ray = primaryRay(camera, px + 0.5, py + 0.5);
      const hit = intersectScene(ray, dynObjects);
      traceCalls++;
      if (!hit) {
        linear[idx * 3] = 0.02; linear[idx * 3 + 1] = 0.03; linear[idx * 3 + 2] = 0.06;
      } else {
        hit.attr = hitAttributes(hit, ray);
        const c = shadeAtRay(ray, hit, 0, 0, trace);
        linear[idx * 3] = c[0]; linear[idx * 3 + 1] = c[1]; linear[idx * 3 + 2] = c[2];
        depth[idx] = hit.t;
        ids[idx] = hit.objectId;
        shadeCalls++;
      }
      const d = toDisplay([linear[idx * 3], linear[idx * 3 + 1], linear[idx * 3 + 2]]);
      display[idx * 4] = d[0] * 255;
      display[idx * 4 + 1] = d[1] * 255;
      display[idx * 4 + 2] = d[2] * 255;
      display[idx * 4 + 3] = 255;
    }
  }
  return {
    display,
    linear,
    depth,
    ids,
    stats: {
      traceCalls,
      shadeCalls,
      fullPixels: WIDTH * HEIGHT,
      shadeFraction: shadeCalls / (WIDTH * HEIGHT),
    },
  };
}

// Mean squared error / PSNR on display-space 0..255 buffers.
export function psnr(a, b, mask = null) {
  let se = 0, n = 0;
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    if (mask && !mask[i]) continue;
    for (let ch = 0; ch < 3; ch++) {
      const d = a[i * 4 + ch] - b[i * 4 + ch];
      se += d * d;
      n++;
    }
  }
  if (!n) return { mse: NaN, psnr: NaN, n: 0 };
  const mse = se / n;
  return { mse, psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), n };
}

// Region mask helper: pixels whose reference object id is in `idSet`.
export function idMask(refIds, idSet) {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  for (let i = 0; i < WIDTH * HEIGHT; i++) if (idSet.has(refIds[i])) mask[i] = 1;
  return mask;
}
