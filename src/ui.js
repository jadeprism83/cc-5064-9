// Wires the raster debug window DOM to the VrsApp controller. The canvases are
// the graphical entry point for every VRS capability: moving the gaze point and
// editing the region budgets immediately update the shading-rate distribution
// and the reconstructed picture.
import { VrsApp } from './app.js';
import { blitFrame, drawRateOverlay, drawGaze, rateSummary } from './viz.js';
import { WIDTH, HEIGHT } from './scene.js';

const app = new VrsApp();
const mainCtx = document.getElementById('mainCanvas').getContext('2d');
const rateCtx = document.getElementById('rateCanvas').getContext('2d');
const tooltip = document.getElementById('tooltip');
const reasonBox = document.getElementById('reasonBox');

const $ = (id) => document.getElementById(id);

function render() {
  const frame = app.lastFrame;
  if (!frame) return;
  blitFrame(mainCtx, frame.display);
  if ($('overlayToggle').checked) {
    drawRateOverlay(rateCtx, frame.tiles, {
      anomalies: $('anomToggle').checked,
      borrow: $('borrowToggle').checked,
    });
  } else {
    rateCtx.clearRect(0, 0, WIDTH, HEIGHT);
  }
  drawGaze(mainCtx, frame.gaze);
  drawGaze(rateCtx, frame.gaze);
  updateStats(frame);
}

function updateStats(f) {
  const s = f.stats;
  $('stFrame').textContent = `${f.frame}/${f.totalFrames}`;
  $('stFrac').textContent = `${(s.shadeFraction * 100).toFixed(1)}%`;
  const over = s.budgetUsedAnchors > s.globalCapAnchors + 1;
  $('stBudget').innerHTML = `${s.budgetUsedAnchors.toFixed(0)} / ${s.globalCapAnchors.toFixed(0)} ` +
    (over ? '<span class="warn">超预算</span>' : '<span class="ok">在内</span>');
  $('stFlicker').textContent = s.flickerTiles;
  $('stReveal').textContent = s.disoccludedTiles + (s.revealConstrained ? ` (受限 ${s.revealConstrained})` : '');
  $('stBorrow').textContent = s.borrowedTiles;
  $('stTemporal').textContent = `${(100 * s.temporalPixels / s.fullPixels).toFixed(1)}%`;
  const invalid = s.invalidPixels;
  $('stInvalid').innerHTML = invalid === 0 ? '0 <span class="ok">正常</span>' : `<span class="warn">${invalid}</span>`;
  $('stHist').textContent = `${s.rateHist[1]} / ${s.rateHist[2]} / ${s.rateHist[4]}`;
}

// --- transport --------------------------------------------------------------
let timer = null;
function setPlaying(on) {
  app.playing = on;
  $('playBtn').textContent = on ? '暂停' : '播放';
  if (timer) { clearInterval(timer); timer = null; }
  if (on) {
    timer = setInterval(() => {
      app.step();
      render();
      if (app.frameIndex >= app.scenario.frames) setPlaying(false);
    }, 120);
  }
}

$('playBtn').addEventListener('click', () => {
  if (app.frameIndex >= app.scenario.frames) app.reset();
  setPlaying(!app.playing);
});
$('stepBtn').addEventListener('click', () => { setPlaying(false); app.step(); render(); });
$('resetBtn').addEventListener('click', () => { setPlaying(false); app.reset(); app.step(); render(); });

$('scenario').addEventListener('change', (e) => {
  setPlaying(false);
  app.setScenario(e.target.value);
  app.step();
  render();
});
$('mode').addEventListener('change', (e) => {
  setPlaying(false);
  app.setMode(e.target.value);
  app.step();
  render();
});
for (const id of ['overlayToggle', 'anomToggle', 'borrowToggle']) {
  $(id).addEventListener('change', render);
}

// --- editable budget controller ---------------------------------------------
const bandSliders = [
  ['budTop', 'top'], ['budFovea', 'fovea'], ['budBottom', 'bottom'],
];
function syncBudgetOutputs() {
  for (const [sliderId, bandId] of bandSliders) {
    const band = app.controller.bands.find((b) => b.id === bandId);
    $(sliderId).value = band.budget;
    $(sliderId + 'Val').textContent = band.budget.toFixed(2);
  }
  $('budGlobal').value = app.controller.globalBudget;
  $('budGlobalVal').textContent = app.controller.globalBudget.toFixed(2);
}
for (const [sliderId, bandId] of bandSliders) {
  $(sliderId).addEventListener('input', (e) => {
    app.setBandBudget(bandId, parseFloat(e.target.value));
    syncBudgetOutputs();
    app.step();
    render();
  });
}
$('budGlobal').addEventListener('input', (e) => {
  app.setGlobalBudget(parseFloat(e.target.value));
  syncBudgetOutputs();
  app.step();
  render();
});
$('borrowEnable').addEventListener('change', (e) => {
  app.setBorrow(e.target.checked);
  app.step();
  render();
});

// --- gaze interaction and tile inspection -----------------------------------
function canvasToPixel(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) * (WIDTH / rect.width),
    y: (ev.clientY - rect.top) * (HEIGHT / rect.height),
  };
}
function attachInspect(canvas) {
  canvas.addEventListener('mousemove', (ev) => {
    const p = canvasToPixel(canvas, ev);
    const { tx, ty, tile } = app.tileAt(p.x, p.y);
    if (!tile) return;
    tooltip.style.display = 'block';
    tooltip.style.left = `${ev.clientX + 14}px`;
    tooltip.style.top = `${ev.clientY + 14}px`;
    tooltip.textContent = `瓦片 (${tx}, ${ty})\n` + app.explainTile(tile);
    reasonBox.textContent = `瓦片 (${tx}, ${ty})\n` + app.explainTile(tile);
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  // Click to pin the gaze point: the quality map must recover detail there.
  canvas.addEventListener('click', (ev) => {
    const p = canvasToPixel(canvas, ev);
    app.manualGaze = { x: p.x, y: p.y };
    app.step();
    render();
  });
}
attachInspect($('mainCanvas'));
attachInspect($('rateCanvas'));

// --- init --------------------------------------------------------------------
syncBudgetOutputs();
$('borrowEnable').checked = app.controller.allowBorrow;
app.step();
render();
