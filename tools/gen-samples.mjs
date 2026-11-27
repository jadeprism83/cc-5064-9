// Generates quality-map update samples: for each key scenario it dumps the real
// reconstructed picture and its per-tile shading-rate map as PPM images, plus a
// JSON summary of the signals behind every quality-map change. These samples
// let sampling density and temporal flicker be inspected across gaze movement
// and edge (disocclusion) changes without a browser.
//
// Run: npm run samples  (or: node tools/gen-samples.mjs)
import { writeFileSync } from 'node:fs';
import { CAMERA_A, WIDTH, HEIGHT } from '../src/scene.js';
import { SCENARIOS, frameState } from '../src/dynamics.js';
import {
  createPipelineState, createBudgetController, renderFrame,
  TILE, TILES_X, TILES_Y,
} from '../src/vrs.js';
import { writePPM } from './ppm.js';

const OUT = 'out/vrs/samples';
const RATE_RGB = { 1: [64, 220, 128], 2: [245, 190, 70], 4: [235, 90, 90] };

// Pure-array rate-map renderer (mirrors viz.js colour coding so the offline
// samples match the raster debug window overlay).
function rateMapImage(tiles, gaze) {
  const img = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let ty = 0; ty < TILES_Y; ty++) {
    for (let tx = 0; tx < TILES_X; tx++) {
      const t = tiles[ty * TILES_X + tx];
      const [r, g, b] = RATE_RGB[t.rate];
      for (let y = ty * TILE; y < ty * TILE + TILE; y++) {
        for (let x = tx * TILE; x < tx * TILE + TILE; x++) {
          const i = (y * WIDTH + x) * 4;
          img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
        }
      }
      if (t.revealConstrained || t.borrowed) {
        const c = t.revealConstrained ? [255, 80, 255] : [90, 170, 255];
        for (let x = tx * TILE; x < tx * TILE + TILE; x++) {
          for (const y of [ty * TILE, ty * TILE + TILE - 1]) setPx(img, x, y, c);
          for (let y = ty * TILE; y < ty * TILE + TILE; y++) {
            setPx(img, tx * TILE, y, c); setPx(img, tx * TILE + TILE - 1, y, c);
          }
        }
      }
    }
  }
  // Gaze crosshair + ring.
  const mark = (x, y) => setPx(img, Math.round(x), Math.round(y), [255, 255, 255]);
  for (let d = -7; d <= 7; d++) { mark(gaze.x + d, gaze.y); mark(gaze.x, gaze.y + d); }
  const rad = TILE * 1.4;
  for (let a = 0; a < Math.PI * 2; a += 0.05) {
    mark(gaze.x + Math.cos(a) * rad, gaze.y + Math.sin(a) * rad);
  }
  return img;
}
function setPx(img, x, y, c) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const i = (y * WIDTH + x) * 4;
  img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; img[i + 3] = 255;
}

// Frames worth sampling per scenario: warm-up, a mid sweep and the final frame.
const PICK = {
  occluded: [3, 12, 30],
  revealed: [3, 12, 30],
  saccade: [1, 8, 24],
  targetMotion: [4, 20, 40],
  suddenReveal: [10, 15, 16, 24],
};

const manifest = { generatedAt: new Date().toISOString(), resolution: { WIDTH, HEIGHT }, samples: [] };

for (const [name, pickFrames] of Object.entries(PICK)) {
  const state = createPipelineState();
  const controller = createBudgetController();
  const scenario = SCENARIOS[name];
  const record = { scenario: name, frames: scenario.frames, framesDumped: [], timeline: [] };
  for (let f = 0; f < scenario.frames; f++) {
    const dyn = frameState(name, f);
    const out = renderFrame(state, CAMERA_A, dyn.gaze, dyn.objects, { mode: 'adaptive', controller });
    const tiles = state.tiles.map((t) => ({ ...t, reasons: [...t.reasons] }));
    const s = out.stats;
    record.timeline.push({
      frame: f + 1,
      rateHist: s.rateHist,
      flickerTiles: s.flickerTiles,
      disoccludedTiles: s.disoccludedTiles,
      borrowedTiles: s.borrowedTiles,
      revealConstrained: s.revealConstrained,
      shadeFraction: Number(s.shadeFraction.toFixed(4)),
      temporalFraction: Number((s.temporalPixels / s.fullPixels).toFixed(4)),
    });
    if (pickFrames.includes(f)) {
      const tag = `${name}-f${String(f + 1).padStart(2, '0')}`;
      writePPM(`${OUT}/${tag}-picture.ppm`, out.display);
      writePPM(`${OUT}/${tag}-ratemap.ppm`, rateMapImage(tiles, dyn.gaze));
      record.framesDumped.push({
        frame: f + 1,
        picture: `${tag}-picture.ppm`,
        rateMap: `${tag}-ratemap.ppm`,
        gaze: { x: Math.round(dyn.gaze.x), y: Math.round(dyn.gaze.y) },
        rateHist: s.rateHist,
        disoccludedTiles: s.disoccludedTiles,
        borrowedTiles: s.borrowedTiles,
        revealConstrained: s.revealConstrained,
        flickerTiles: s.flickerTiles,
      });
    }
  }
  manifest.samples.push(record);
}

writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
const count = manifest.samples.reduce((a, r) => a + r.framesDumped.length, 0);
console.log(`wrote ${count} frame pairs (picture + rate map) and manifest to ${OUT}/`);
