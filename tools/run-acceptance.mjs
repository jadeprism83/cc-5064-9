// Acceptance test runner for the dynamic VRS quality map.
//
// Runs every scenario through the adaptive pipeline, renders the full-quality
// reference only for acceptance frames (its cost is reported separately), and
// checks:
//   1. segment 1 vs segment 2 fence reveal under an identical gaze path,
//   2. the first frame a newly exposed gap is visible (reserve fine block),
//   3. the opposite (gaze) side is not persistently degraded by preemption,
//   4. region budget coverage, frame cost and cross-band borrowing,
//   5. saccade / fine-texture motion / sudden reveal response time,
//   6. temporal flicker and realised compute savings.
//
// Run: node tools/run-acceptance.mjs [--write-images]
import { CAMERA_A, WIDTH, HEIGHT } from '../src/scene.js';
import { frameState, SCENARIOS, FENCE_XS, DYN_IDS } from '../src/dynamics.js';
import {
  createPipelineState, createBudgetController, renderFrame,
  TILES_X, TILES_Y, TILE, TILE_COUNT,
} from '../src/vrs.js';
import { renderReference, psnr, idMask } from '../src/reference.js';
import { writePPM } from './ppm.js';

const writeImages = process.argv.includes('--write-images');
const OUT = 'out/vrs';
const results = [];
let failures = 0;

function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  if (!cond) failures++;
}

function runScenario(name, controller, mode = 'adaptive') {
  const state = createPipelineState();
  const frames = [];
  const scenario = SCENARIOS[name];
  for (let f = 0; f < scenario.frames; f++) {
    const dyn = frameState(name, f);
    const out = renderFrame(state, CAMERA_A, dyn.gaze, dyn.objects, { mode, controller });
    // Snapshot per-tile state: the pipeline mutates one persistent state object,
    // so later frames would otherwise overwrite the history of earlier ones.
    const tileSnapshot = state.tiles.map((t) => ({ ...t, reasons: [...t.reasons] }));
    frames.push({ dyn, out, state, tiles: tileSnapshot });
  }
  return { state, frames };
}

const fenceIdSet = new Set(FENCE_XS.map((_, i) => DYN_IDS.fenceBase + i));

// --- 1. paired segments: identical gaze path, panel present vs removed ------
{
  const a = runScenario('occluded', createBudgetController());
  const b = runScenario('revealed', createBudgetController());

  const gazeSame = a.frames.every((fr, i) =>
    Math.abs(fr.dyn.gaze.x - b.frames[i].dyn.gaze.x) < 1e-9 &&
    Math.abs(fr.dyn.gaze.y - b.frames[i].dyn.gaze.y) < 1e-9);
  check('segments share an identical gaze trajectory', gazeSame);

  // First frame segment 2 exposes fence pixels that segment 1 never shows.
  let firstVisible = -1;
  for (let f = 0; f < b.frames.length; f++) {
    const ref = renderReference(CAMERA_A, b.frames[f].dyn.objects);
    const fencePx = idMask(ref.ids, fenceIdSet).reduce((s, v) => s + v, 0);
    if (fencePx > 0 && firstVisible < 0) firstVisible = f;
  }
  check('segment 2 has a frame with newly visible fence gaps', firstVisible >= 0, `firstVisible=${firstVisible}`);

  // On the first visible frame the reveal tiles must be at fine sampling and
  // the frame must stay inside the same shading budget as a normal frame.
  const fr = b.frames[firstVisible];
  const revealTiles = fr.tiles.filter((t) => t.inRevealWindow);
  const fineFraction = revealTiles.length
    ? revealTiles.filter((t) => t.rate === 1).length / revealTiles.length : 0;
  check('first-visible-frame reveal blocks reserved at rate 1', fineFraction >= 0.9,
    `${(fineFraction * 100).toFixed(0)}% of ${revealTiles.length} reveal tiles`);
  check('reveal frame stays within global shading budget',
    fr.out.stats.budgetUsedAnchors <= fr.out.stats.globalCapAnchors + 1,
    `used=${fr.out.stats.budgetUsedAnchors.toFixed(0)} cap=${fr.out.stats.globalCapAnchors.toFixed(0)}`);

  // Fence quality on the acceptance frame vs full-quality reference.
  const ref = renderReference(CAMERA_A, fr.dyn.objects);
  const fenceMask = idMask(ref.ids, fenceIdSet);
  const fenceMetric = psnr(fr.out.display, ref.display, fenceMask);
  check('fence region reconstructs above PSNR floor on first visible frame',
    fenceMetric.psnr >= 14, `fencePSNR=${fenceMetric.psnr.toFixed(2)}`);
  // Same shading budget across the two segments (peak spend must match cap).
  const peakA = Math.max(...a.frames.map((x) => x.out.stats.shadeFraction));
  const peakB = Math.max(...b.frames.map((x) => x.out.stats.shadeFraction));
  check('both segments respect the same shading budget ceiling',
    peakA <= 0.345 && peakB <= 0.345, `peakA=${peakA.toFixed(3)} peakB=${peakB.toFixed(3)}`);

  if (writeImages) {
    writePPM(`${OUT}/seg2-first-visible.ppm`, fr.out.display);
    writePPM(`${OUT}/seg2-first-visible-ref.ppm`, ref.display);
  }
}

// --- 2. opposite side must not be persistently degraded (preemption) ---------
{
  const base = runScenario('occluded', createBudgetController());
  const reveal = runScenario('suddenReveal', createBudgetController());
  // Gaze-side foveal column around x=330. Compare rate-1 tile counts there in
  // the steady state (last third of each clip).
  const fovealRate1 = (run) => {
    const tail = run.frames.slice(Math.floor(run.frames.length * 0.66));
    let fine = 0, total = 0;
    for (const fr of tail) {
      for (let ty = 0; ty < TILES_Y; ty++) {
        for (let tx = 36; tx < 46; tx++) {
          total++;
          if (fr.tiles[ty * TILES_X + tx].rate === 1) fine++;
        }
      }
    }
    return fine / total;
  };
  const baseFine = fovealRate1(base);
  const revealFine = fovealRate1(reveal);
  check('gaze-side fine coverage survives reveal preemption',
    revealFine >= baseFine * 0.85, `base=${(baseFine * 100).toFixed(1)}% reveal=${(revealFine * 100).toFixed(1)}%`);
}

// --- 3. region budget controller: coverage, frame cost, borrowing ------------
{
  // Tight peripheral budgets force the moving target's high-demand tiles to
  // borrow foveal/neighbour headroom.
  const ctrl = createBudgetController({ top: 0.08, fovea: 0.7, bottom: 0.08, globalBudget: 0.34 });
  const run = runScenario('targetMotion', ctrl);
  const anyBorrow = run.frames.some((fr) => fr.out.stats.borrowedTiles > 0);
  check('fast target triggers cross-band budget borrowing', anyBorrow,
    `peak borrowed tiles=${Math.max(...run.frames.map((f) => f.out.stats.borrowedTiles))}`);

  const withinCap = run.frames.every((fr) =>
    fr.out.stats.budgetUsedAnchors <= fr.out.stats.globalCapAnchors + 1);
  check('every frame stays within the edited global cap', withinCap);

  // Coverage: every tile carries a valid rate and anchors were shaded.
  const covered = run.frames.every((fr) =>
    fr.tiles.every((t) => [1, 2, 4].includes(t.rate)));
  check('all tiles have a valid shading rate', covered);

  // Disabling borrowing must keep the cap but remove borrowed annotations.
  const ctrlNoBorrow = createBudgetController({ allowBorrow: false });
  const runNo = runScenario('targetMotion', ctrlNoBorrow);
  check('borrow toggle disables cross-band loans',
    runNo.frames.every((fr) => fr.out.stats.borrowedTiles === 0));
  check('no-borrow runs still respect the global cap',
    runNo.frames.every((fr) => fr.out.stats.budgetUsedAnchors <= fr.out.stats.globalCapAnchors + 1));
}

// --- 4. response time: saccade, fine-texture motion, sudden reveal -----------
{
  // Saccade: after the gaze enters a coarse region, rate 1 must arrive within
  // the declared response window (2 frames: immediate upgrade step + apply).
  const sac = runScenario('saccade', createBudgetController());
  let response = -1;
  for (let f = 1; f < sac.frames.length; f++) {
    const g = sac.frames[f].dyn.gaze;
    const tx = clampTile(Math.floor(g.x / TILE), TILES_X), ty = clampTile(Math.floor(g.y / TILE), TILES_Y);
    if (sac.frames[f].tiles[ty * TILES_X + tx].rate === 1) { response = f; break; }
  }
  check('saccade focus region recovers detail within 2 frames', response >= 0 && response <= 2, `response frame=${response}`);

  // Sudden reveal: disocclusion event fires and rate 1 is applied the same frame.
  const rev = runScenario('suddenReveal', createBudgetController());
  const eventFrame = rev.frames.findIndex((fr) => fr.out.stats.disoccludedTiles > 0);
  const eventOk = eventFrame >= 0 &&
    rev.frames[eventFrame].tiles.some((t) => t.disoccluded && t.rate === 1);
  check('sudden reveal reserves fine sampling on the event frame', eventOk, `eventFrame=${eventFrame}`);

  // Error retention: history weights are validity-gated, so reveal tiles do not
  // keep stale temporal colour (temporal pixel share must drop on the event).
  const before = rev.frames[Math.max(0, eventFrame - 1)].out.stats.temporalPixels;
  const at = rev.frames[eventFrame].out.stats.temporalPixels;
  check('reveal event suppresses stale temporal reuse', at < before,
    `temporal before=${before} at=${at}`);
}

// --- 5. flicker and realised savings -----------------------------------------
{
  const run = runScenario('occluded', createBudgetController());
  const steady = run.frames.slice(8);
  const meanFlicker = steady.reduce((s, fr) => s + fr.out.stats.flickerTiles, 0) / steady.length;
  check('steady-state quality map flicker stays low', meanFlicker < 0.04 * TILE_COUNT,
    `mean flicker tiles=${meanFlicker.toFixed(1)} of ${TILE_COUNT}`);

  const last = run.frames[run.frames.length - 1];
  const ref = renderReference(CAMERA_A, last.dyn.objects);
  const savings = 1 - last.out.stats.shadeCalls / ref.stats.shadeCalls;
  check('adaptive pipeline realises substantial shading savings', savings >= 0.6,
    `savings=${(savings * 100).toFixed(1)}% adaptive=${last.out.stats.shadeCalls} reference=${ref.stats.shadeCalls}`);
  check('reference cost is counted separately',
    ref.stats.shadeCalls === WIDTH * HEIGHT && last.out.stats.shadeCalls < ref.stats.shadeCalls);
}

// --- 6. fixed partition mode remains available -------------------------------
{
  const fixed = runScenario('saccade', createBudgetController(), 'fixed');
  const rates = new Set(fixed.frames.flatMap((fr) => fr.tiles.map((t) => t.rate)));
  check('fixed partition mode still selectable and emits valid rates',
    rates.size > 0 && [...rates].every((r) => [1, 2, 4].includes(r)), [...rates].join(','));
}

// --- report ------------------------------------------------------------------
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

function clampTile(v, max) { return Math.max(0, Math.min(max - 1, v)); }
