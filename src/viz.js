// Browser-side visualization helpers for the raster debug window.
// Draws the reconstructed frame, the per-tile shading-rate overlay, the gaze
// marker, budget bands and anomaly highlights onto 2D canvases.
import { TILE, TILES_X, TILES_Y, BANDS } from './vrs.js';
import { WIDTH, HEIGHT } from './scene.js';

export const RATE_COLORS = {
  1: [64, 220, 128],   // green: full rate
  2: [245, 190, 70],   // amber: half rate
  4: [235, 90, 90],    // red: quarter rate
};

export function blitFrame(ctx, display) {
  const img = ctx.createImageData(WIDTH, HEIGHT);
  img.data.set(display);
  ctx.putImageData(img, 0, 0);
}

// Shading-rate overlay: one coloured cell per tile, opacity scaled by rate.
export function drawRateOverlay(ctx, tiles, opts = {}) {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  for (let ty = 0; ty < TILES_Y; ty++) {
    for (let tx = 0; tx < TILES_X; tx++) {
      const t = tiles[ty * TILES_X + tx];
      const [r, g, b] = RATE_COLORS[t.rate];
      const alpha = t.rate === 1 ? 0.55 : t.rate === 2 ? 0.45 : 0.4;
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
    }
  }
  drawBandBoundaries(ctx);
  if (opts.anomalies) drawAnomalies(ctx, tiles);
  if (opts.borrow) drawBorrow(ctx, tiles);
}

function drawBandBoundaries(ctx) {
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  for (const band of BANDS) {
    const y = band.row1 * TILE + TILE;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WIDTH, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// Anomaly markers: invalid gathers (reconstruction had no compatible anchor),
// reveal tiles constrained by the budget cap, and tiles whose rate flipped.
export function drawAnomalies(ctx, tiles) {
  for (let ty = 0; ty < TILES_Y; ty++) {
    for (let tx = 0; tx < TILES_X; tx++) {
      const t = tiles[ty * TILES_X + tx];
      if (t.revealConstrained) {
        ctx.strokeStyle = 'rgb(255,80,255)';
        ctx.lineWidth = 2;
        ctx.strokeRect(tx * TILE + 1, ty * TILE + 1, TILE - 2, TILE - 2);
      }
      if (t.reasons.some((x) => x.includes('invalid gather'))) {
        ctx.fillStyle = 'rgba(255,0,0,0.9)';
        ctx.beginPath();
        ctx.arc(tx * TILE + TILE / 2, ty * TILE + TILE / 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawBorrow(ctx, tiles) {
  ctx.strokeStyle = 'rgb(90,170,255)';
  ctx.lineWidth = 1.5;
  for (let ty = 0; ty < TILES_Y; ty++) {
    for (let tx = 0; tx < TILES_X; tx++) {
      const t = tiles[ty * TILES_X + tx];
      if (t.borrowed) ctx.strokeRect(tx * TILE + 0.5, ty * TILE + 0.5, TILE - 1, TILE - 1);
    }
  }
}

export function drawGaze(ctx, gaze) {
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(gaze.x, gaze.y, TILE * 1.4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(gaze.x - 6, gaze.y);
  ctx.lineTo(gaze.x + 6, gaze.y);
  ctx.moveTo(gaze.x, gaze.y - 6);
  ctx.lineTo(gaze.x, gaze.y + 6);
  ctx.stroke();
}

// Compact legend / status line data for the side panel.
export function rateSummary(tiles) {
  const hist = { 1: 0, 2: 0, 4: 0 };
  for (const t of tiles) hist[t.rate]++;
  const total = tiles.length;
  return [
    { rate: 1, label: '全速率 (1x)', pct: hist[1] / total, count: hist[1] },
    { rate: 2, label: '半速率 (1/4 着色)', pct: hist[2] / total, count: hist[2] },
    { rate: 4, label: '1/4 速率 (1/16 着色)', pct: hist[4] / total, count: hist[4] },
  ];
}
