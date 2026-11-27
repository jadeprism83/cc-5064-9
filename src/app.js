// Application controller for the raster debug window. Owns the pipeline state,
// the scenario clock, the editable budget controller and the play/pause/step
// transport. The UI layer (index.html) only renders what this exposes, so the
// quality-map decision path stays identical to the headless acceptance tests.
import { CAMERA_A } from './scene.js';
import { SCENARIOS, frameState } from './dynamics.js';
import {
  createPipelineState, createBudgetController, renderFrame,
  TILES_X, TILES_Y, BANDS,
} from './vrs.js';

export class VrsApp {
  constructor() {
    this.scenarioName = 'occluded';
    this.mode = 'adaptive';
    this.controller = createBudgetController();
    this.pipeline = createPipelineState();
    this.frameIndex = 0;
    this.playing = false;
    this.lastFrame = null;
    this.showOverlay = true;
    this.showAnomalies = true;
    this.showBorrow = true;
    this.manualGaze = null;
  }

  get scenario() { return SCENARIOS[this.scenarioName]; }

  setScenario(name) {
    this.scenarioName = name;
    this.reset();
  }

  setMode(mode) {
    this.mode = mode;
    this.reset();
  }

  reset() {
    this.pipeline = createPipelineState();
    this.frameIndex = 0;
    this.lastFrame = null;
  }

  setBandBudget(id, value) {
    this.controller.setBudget(id, value);
  }

  setGlobalBudget(value) {
    this.controller.setGlobalBudget(value);
  }

  setBorrow(on) {
    this.controller.allowBorrow = on;
  }

  step() {
    const scenario = this.scenario;
    if (this.frameIndex >= scenario.frames) {
      this.playing = false;
      return this.lastFrame;
    }
    const dyn = frameState(this.scenarioName, this.frameIndex);
    const gaze = this.manualGaze ?? dyn.gaze;
    const out = renderFrame(this.pipeline, CAMERA_A, gaze, dyn.objects, {
      mode: this.mode,
      controller: this.controller,
    });
    this.frameIndex++;
    this.lastFrame = {
      ...out,
      gaze,
      dyn,
      tiles: this.pipeline.tiles.map((t) => ({ ...t, reasons: [...t.reasons] })),
      frame: this.frameIndex,
      totalFrames: scenario.frames,
      bands: this.controller.bands.map((b) => ({ ...b })),
      globalBudget: this.controller.globalBudget,
      allowBorrow: this.controller.allowBorrow,
    };
    return this.lastFrame;
  }

  tileAt(px, py) {
    const tx = Math.max(0, Math.min(TILES_X - 1, Math.floor(px / 8)));
    const ty = Math.max(0, Math.min(TILES_Y - 1, Math.floor(py / 8)));
    return { tx, ty, tile: this.pipeline.tiles[ty * TILES_X + tx] };
  }

  // Human-readable explanation of why a tile currently holds its rate, used by
  // the UI tooltip and the side-panel "basis for up/down grade" readout.
  explainTile(tile) {
    if (!tile) return '';
    const rateName = tile.rate === 1 ? '全速率' : tile.rate === 2 ? '半速率' : '1/4 速率';
    return [
      `当前: ${rateName} (r=${tile.rate})`,
      `需求分: ${tile.demand.toFixed(3)}`,
      `重建误差 EMA: ${tile.errorEma.toFixed(3)} (${tile.errorAge < 5 ? '有效' : '历史失效'})`,
      `运动: ${tile.motion.toFixed(2)}  显露窗口: ${tile.inRevealWindow ? '是' : '否'}`,
      `借用邻区预算: ${tile.borrowed ? '是' : '否'}`,
      `依据: ${tile.reasons.join('；')}`,
    ].join('\n');
  }
}
