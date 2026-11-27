// Procedural textures and the physically-plausible-ish shading used at every
// shading rate. Shading always goes through `shadeAtRay` so the variable-rate
// path and the full-quality reference share the exact same math.

function hash2(ix, iy, seed = 0) {
  let h = ix * 374761393 + iy * 668265263 + seed * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function valueNoise(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

// Strong-contrast procedural texture. Frequency is intentionally high so
// under-sampled coarse shading shows real aliasing unless mip filtering runs.
export function sampleTexture(material, u, v) {
  switch (material) {
    case 'poster': {
      // Vertical striped "photo" with a bright sun disc and fine print grain.
      const stripes = 0.5 + 0.5 * Math.sin(u * 210);
      const rings = 0.5 + 0.5 * Math.sin(Math.hypot(u - 0.5, v - 0.55) * 260);
      const grain = valueNoise(u * 520, v * 520, 7) * 0.35;
      const disc = Math.hypot(u - 0.5, v - 0.42) < 0.18 ? 1 : 0;
      const base = [0.20 + stripes * 0.55, 0.18 + rings * 0.4, 0.42 + 0.3 * stripes];
      const sun = [1.0, 0.92, 0.55];
      const k = disc;
      const col = [
        Math.max(base[0], sun[0] * k) + grain * 0.15,
        Math.max(base[1], sun[1] * k) + grain * 0.15,
        Math.max(base[2], sun[2] * k) + grain * 0.15,
      ];
      return col;
    }
    case 'wall': {
      const seam = Math.abs((u * 14) % 1 - 0.5) < 0.03 ? 0.15 : 0;
      const n = valueNoise(u * 300, v * 300, 3);
      const base = 0.42 + n * 0.08 - seam;
      return [base * 0.94, base * 0.92, base * 0.86];
    }
    case 'rod': {
      // Brushed metal: sharp specular band along v plus fine scratches along u.
      const band = Math.exp(-Math.pow((v - 0.55) * 9, 2));
      const scratch = 0.5 + 0.5 * Math.sin(u * 900);
      const base = 0.22 + band * 0.6 + scratch * 0.1;
      return [base, base * 0.98, base * 0.95];
    }
    case 'lamp': {
      const pane = 0.5 + 0.5 * Math.cos(v * 60);
      const edge = Math.min(1, Math.min(u, 1 - u) * 12);
      const g = 0.55 + 0.45 * pane;
      return [g * edge, g * 0.98 * edge, g * 0.9 * edge];
    }
    case 'hair': {
      const strand = 0.5 + 0.5 * Math.sin((u * 64 + v * 9) * Math.PI * 2);
      const dark = 0.05 + 0.13 * strand;
      return [dark, dark * 0.9, dark * 0.8];
    }
    case 'skin': {
      const blotch = valueNoise(u * 80, v * 80, 11) * 0.12;
      return [0.82 + blotch, 0.62 + blotch * 0.6, 0.52 + blotch * 0.4];
    }
    case 'shirt': {
      const weave = 0.5 + 0.5 * Math.sin(u * 180) * Math.sin(v * 180);
      const g = 0.24 + weave * 0.06;
      return [0.10 + g * 0.2, 0.16 + g * 0.4, 0.42 + g * 0.4];
    }
    case 'eyeWhite': {
      const vein = valueNoise(u * 200, v * 200, 23) > 0.85 ? 0.75 : 1;
      return [0.95 * vein, 0.96 * vein, 0.93 * vein];
    }
    case 'pupil':
      return [0.02, 0.02, 0.03];
    case 'fence': {
      // Thin painted rods: fine scratches make lost rods easy to see against
      // the poster when the panel slides away.
      const scratch = 0.5 + 0.5 * Math.sin(u * 1400);
      const band = Math.exp(-Math.pow((v - 0.5) * 7, 2));
      const g = 0.16 + band * 0.45 + scratch * 0.08;
      return [g * 1.05, g * 0.95, g * 0.8];
    }
    case 'panel': {
      // Muted matte panel with a fine checker; strong texture so any coarse
      // shading on the panel itself is visible.
      const chk = ((Math.floor(u * 96) + Math.floor(v * 96)) & 1) ? 0.92 : 0.78;
      const grain = valueNoise(u * 260, v * 260, 41) * 0.06;
      const g = chk * 0.62 + grain;
      return [g * 1.02, g, g * 0.94];
    }
    case 'target': {
      // High-frequency rings: a demanding target for borrowed neighbour budget.
      const ring = 0.5 + 0.5 * Math.sin(Math.hypot(u - 0.5, v - 0.5) * 360);
      const g = 0.25 + ring * 0.65;
      return [g, 0.3 + ring * 0.3, 0.25 + ring * 0.2];
    }
    default:
      return [0.6, 0.6, 0.6];
  }
}

// Mip-style prefiltered fetch: instead of point sampling, integrate several
// taps spread over the footprint, which is what a coarse shading rate needs to
// avoid shimmering under minification.
export function sampleTextureFiltered(material, u, v, footprintU, footprintV) {
  if (footprintU <= 1e-4 && footprintV <= 1e-4) return sampleTexture(material, u, v);
  // log2 mip level -> tap count, but cap so coarse rates stay cheap.
  const lod = Math.max(Math.abs(footprintU), Math.abs(footprintV));
  const taps = lod > 0.08 ? 5 : lod > 0.02 ? 3 : 1;
  if (taps === 1) return sampleTexture(material, u, v);
  const du = footprintU * 0.35, dv = footprintV * 0.35;
  const r = [0, 0, 0];
  const offsets = taps === 3
    ? [[0, 0], [du, dv * 0.5], [-du, -dv * 0.5]]
    : [[0, 0], [du, 0], [-du, 0], [0, dv], [0, -dv]];
  for (const [a, b] of offsets) {
    const c = sampleTexture(material, u + a, v + b);
    r[0] += c[0]; r[1] += c[1]; r[2] += c[2];
  }
  return [r[0] / offsets.length, r[1] / offsets.length, r[2] / offsets.length];
}

const LIGHT_DIR = (() => {
  const x = -0.45, y = 0.55, z = 0.7;
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
})();

// Core shading function. `ray` is the primary ray used for the sample, so the
// lighting uses the true view vector of that sample rather than a raster screen
// position. `footprint` is the uv derivative range covered by this shading
// invocation.
export function shadeAtRay(ray, hit, footprintU = 0, footprintV = 0, trace) {
  const attr = hit.attr;
  const uv = attr.uv;
  const mat = hit.object.material;
  const albedo = sampleTextureFiltered(mat, uv.u, uv.v, footprintU, footprintV);
  const n = attr.normal;
  const ndotl = Math.max(0, n.x * LIGHT_DIR.x + n.y * LIGHT_DIR.y + n.z * LIGHT_DIR.z);
  const view = Math.max(0.05, attr.cosView);
  const spec = Math.pow(ndotl, 24) * (mat === 'rod' ? 0.9 : 0.25);
  const ambient = 0.16;
  const emissive = hit.object.emit ? 0.7 : 0;
  const rim = Math.pow(1 - view, 3) * 0.15;
  const col = [
    albedo[0] * (ambient + ndotl * 0.85) + spec + emissive + rim,
    albedo[1] * (ambient + ndotl * 0.85) + spec + emissive + rim,
    albedo[2] * (ambient + ndotl * 0.85) + spec + emissive + rim,
  ];
  if (trace) trace.shadeCalls++;
  return col;
}

// Linear-space output then a framebuffer tone step, shared with the reference.
export function toDisplay(col, exposure = 1) {
  const g = 1.6;
  const r = col[0] * exposure, gg = col[1] * exposure, b = col[2] * exposure;
  return [
    Math.min(1, Math.pow(Math.max(0, r), 1 / g) * 1.05),
    Math.min(1, Math.pow(Math.max(0, gg), 1 / g) * 1.05),
    Math.min(1, Math.pow(Math.max(0, b), 1 / g) * 1.05),
  ];
}
