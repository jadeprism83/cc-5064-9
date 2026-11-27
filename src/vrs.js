// Variable-rate shading pipeline with a dynamic quality map.
//
// Honesty model: every rate decision in here consumes only signals declared as
// available at runtime — sparse geometry probes (depth/id), sparse shaded
// probes, last frame's rates, the gaze point and reprojected history validity.
// A full-resolution full-quality image is never rendered to drive decisions;
// reference.js renders one separately and its cost is counted on its own.
import { WIDTH, HEIGHT, intersectScene, hitAttributes } from './scene.js';
import { v3, sub, dot, norm } from './math.js';
import { shadeAtRay, toDisplay } from './shading.js';

// 8-pixel tiles: 640/8 = 80 columns and 360/8 = 45 rows, both integral.
export const TILE = 8;
export const TILES_X = WIDTH / TILE;
export const TILES_Y = HEIGHT / TILE;
export const TILE_COUNT = TILES_X * TILES_Y;

// Shading rates as linear pixel strides. Rate r means one shading anchor per
// r x r block, so the cost multiplier relative to full rate is 1 / r^2.
export const RATES = [1, 2, 4];
export const rateCost = (r) => 1 / (r * r);

// Vertical budget bands (tile rows): top peripheral, central foveal, bottom
// peripheral. Their budgets are the editable region budget controller.
export const BANDS = [
  { id: 'top', row0: 0, row1: 11, budget: 0.16 },
  { id: 'fovea', row0: 12, row1: 32, budget: 0.62 },
  { id: 'bottom', row0: 33, row1: 44, budget: 0.22 },
];

// Sparse probes per tile per frame (geometry + one full-rate shaded probe).
export const PROBES_PER_TILE = 4;
// Minimum feasible global shading budget. Every frame always pays for the
// sparse probes plus the coarsest (rate-4) anchor lattice: one anchor per
// 4x4 block, i.e. (TILE/4)^2 anchors per tile. A cap below this is physically
// impossible, so the controller clamps instead of silently overshooting.
const MIN_ANCHORS = TILE_COUNT * (TILE / 4) * (TILE / 4);
export const GLOBAL_BUDGET_MIN = Math.ceil(
  (TILE_COUNT * PROBES_PER_TILE + MIN_ANCHORS) / (WIDTH * HEIGHT) * 1000) / 1000;
const PROBE_OFFSETS = [
  [1.75, 1.75], [5.75, 1.75], [1.75, 5.75], [5.75, 5.75],
];

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const tileIndex = (tx, ty) => ty * TILES_X + tx;

// Flicker-guard timing (frames): an upgraded tile stays fine at least this long,
// and a downgrade needs this many consecutive low-demand frames.
const UPGRADE_HOLD = 6;
const DOWNGRADE_HOLD = 4;
// Frames a newly revealed region is held at fine sampling while detail converges.
const REVEAL_HOLD = 5;

// Asymmetric hysteresis around the two quality boundaries. Upgrade thresholds
// are deliberately lower than downgrade thresholds so a tile keeps fine
// sampling until its demand stays low, which suppresses map chatter.
function rate4(currentRate, demand, gazeScore, disoccluded, reasons) {
  if (disoccluded) {
    reasons.push('disocclusion: reserve fine block');
    return 1;
  }
  if (gazeScore > 0.82) {
    reasons.push('gaze fovea');
    return 1;
  }
  switch (currentRate) {
    case 1:
      if (demand < 0.28) { reasons.push('sustained low demand'); return 2; }
      return 1;
    case 2:
      if (demand > 0.42) { reasons.push('demand up: refine'); return 1; }
      if (demand < 0.16) { reasons.push('sustained low demand'); return 4; }
      return 2;
    default:
      if (demand > 0.34) { reasons.push('demand up: refine'); return 2; }
      if (demand > 0.5) return 1;
      return 4;
  }
}

export function createBudgetController(overrides = {}) {
  const bands = BANDS.map((b) => ({ ...b, budget: overrides[b.id] ?? b.budget }));
  return {
    bands,
    globalBudget: clamp(overrides.globalBudget ?? 0.34, GLOBAL_BUDGET_MIN, 1),
    allowBorrow: overrides.allowBorrow ?? true,
    setBudget(id, v) {
      const b = this.bands.find((x) => x.id === id);
      if (b) b.budget = clamp(v, 0.02, 0.95);
    },
    setGlobalBudget(v) {
      this.globalBudget = clamp(v, GLOBAL_BUDGET_MIN, 1);
    },
  };
}

export function createPipelineState() {
  const tiles = [];
  for (let i = 0; i < TILE_COUNT; i++) {
    tiles.push({
      rate: 4,
      ratePrev: 4,
      upgradeHold: 0,
      downgradePend: 0,
      // EMA of the local reconstruction error, only updated from sparse
      // full-rate probes that are valid this frame.
      errorEma: 0,
      errorAge: 99,
      // Last frame's probe depth/id used to detect motion / disocclusion.
      prevDepth: NaN,
      prevId: -1,
      prevProbeId: [-1, -1, -1, -1],
      prevProbeDepth: [NaN, NaN, NaN, NaN],
      prevOccluderHits: 0,
      revealHold: 0,
      inRevealWindow: false,
      motion: 0,
      disoccluded: false,
      demand: 0,
      demandEma: 0,
      frameCount: 0,
      reasons: [],
      flickerCount: 0,
      // Debug: when true this tile was upgraded by borrowing neighbour budget.
      borrowed: false,
      revealConstrained: false,
    });
  }
  return {
    frame: 0,
    tiles,
    // Per-pixel history for temporal reconstruction.
    hist: {
      color: new Float32Array(WIDTH * HEIGHT * 3),
      depth: new Float32Array(WIDTH * HEIGHT).fill(NaN),
      id: new Int16Array(WIDTH * HEIGHT).fill(-1),
      weight: new Float32Array(WIDTH * HEIGHT),
      rate: new Uint8Array(WIDTH * HEIGHT).fill(4),
      has: new Uint8Array(WIDTH * HEIGHT),
    },
    prevCamera: null,
    prevGaze: null,
    stats: null,
  };
}

// --- sparse geometry + shading probes --------------------------------------

function runProbes(camera, dynObjects) {
  const n = TILE_COUNT * PROBES_PER_TILE;
  const depth = new Float32Array(n);
  const ids = new Int16Array(n);
  const color = new Float32Array(n * 3);
  const hitFlag = new Uint8Array(n);
  const occluderFlag = new Uint8Array(n);
  let traceCalls = 0;
  let shadeCalls = 0;
  const trace = { shadeCalls: 0 };

  for (let ty = 0; ty < TILES_Y; ty++) {
    for (let tx = 0; tx < TILES_X; tx++) {
      const base = (tileIndex(tx, ty)) * PROBES_PER_TILE;
      for (let p = 0; p < PROBES_PER_TILE; p++) {
        const sx = Math.min(WIDTH - 1, tx * TILE + PROBE_OFFSETS[p][0]);
        const sy = Math.min(HEIGHT - 1, ty * TILE + PROBE_OFFSETS[p][1]);
        const ray = makeProbeRay(camera, sx, sy);
        const hit = intersectScene(ray, dynObjects);
        traceCalls++;
        const k = base + p;
        if (!hit) {
          depth[k] = NaN;
          ids[k] = -1;
          const sky = [0.02, 0.03, 0.06];
          color[k * 3] = sky[0]; color[k * 3 + 1] = sky[1]; color[k * 3 + 2] = sky[2];
          continue;
        }
        hitFlag[k] = 1;
        depth[k] = hit.t;
        ids[k] = hit.objectId;
        if (hit.object.dynamic === 'slider') occluderFlag[k] = 1;
        hit.attr = hitAttributes(hit, ray);
        const c = shadeAtRay(ray, hit, 0, 0, trace);
        shadeCalls++;
        color[k * 3] = c[0]; color[k * 3 + 1] = c[1]; color[k * 3 + 2] = c[2];
      }
    }
  }
  return { depth, ids, color, hitFlag, occluderFlag, traceCalls, shadeCalls };
}

function makeProbeRay(cam, sx, sy) {
  const ndcx = (sx / WIDTH) * 2 - 1;
  const ndcy = 1 - (sy / HEIGHT) * 2;
  const dir = norm(add3(
    cam.f,
    scale3(cam.right, ndcx * cam.tanHalf * cam.aspect),
    scale3(cam.upv, ndcy * cam.tanHalf),
  ));
  return { o: cam.eye, d: dir };
}
const add3 = (a, b, c) => v3(a.x + b.x + c.x, a.y + b.y + c.y, a.z + b.z + c.z);
const scale3 = (a, s) => v3(a.x * s, a.y * s, a.z * s);

// Probe-derived tile signals. Everything the quality map is allowed to know.
function tileSignals(state, probes, camera, gaze) {
  const out = [];
  for (let ty = 0; ty < TILES_Y; ty++) {
    for (let tx = 0; tx < TILES_X; tx++) {
      const i = tileIndex(tx, ty);
      const tile = state.tiles[i];
      tile.frameCount++;
      const base = i * PROBES_PER_TILE;
      let dMean = 0, idMode = new Map(), cMean = [0, 0, 0], hits = 0;
      let dMin = Infinity, dMax = -Infinity;
      for (let p = 0; p < PROBES_PER_TILE; p++) {
        const k = base + p;
        if (!probes.hitFlag[k]) continue;
        hits++;
        dMean += probes.depth[k];
        dMin = Math.min(dMin, probes.depth[k]);
        dMax = Math.max(dMax, probes.depth[k]);
        idMode.set(probes.ids[k], (idMode.get(probes.ids[k]) ?? 0) + 1);
        for (let ch = 0; ch < 3; ch++) cMean[ch] += probes.color[k * 3 + ch];
      }
      if (hits) {
        dMean /= hits;
        cMean = cMean.map((v) => v / hits);
      }
      let dominantId = -1, dominantCount = 0;
      for (const [id, cnt] of idMode) if (cnt > dominantCount) { dominantId = id; dominantCount = cnt; }

      // Local contrast from the sparse shaded probes: the runtime stand-in for
      // "would coarse shading lose detail here".
      let contrast = 0;
      if (hits > 1) {
        let acc = 0;
        for (let p = 0; p < PROBES_PER_TILE; p++) {
          const k = base + p;
          if (!probes.hitFlag[k]) continue;
          let e = 0;
          for (let ch = 0; ch < 3; ch++) e += (probes.color[k * 3 + ch] - cMean[ch]) ** 2;
          acc += e / 3;
        }
        contrast = Math.sqrt(acc / hits);
      }
      const depthSpread = hits ? dMax - dMin : 0;
      // Mixed probe ids mean a silhouette or thin feature crosses this tile;
      // even a single differing probe votes strongly so 1px fence rods are not
      // averaged away by coarse anchors.
      const mixedIds = idMode.size > 1 ? 1 : 0;
      const edge = clamp(
        (dominantCount < hits && hits > 1 ? 0.85 : 0) +
        clamp(depthSpread / Math.max(0.05, dMean), 0, 1) * 0.7 +
        mixedIds * 0.6,
        0, 1.5);

      // Per-probe ids/depths so a thin revealed object (a fence rod hits only
      // one of four probes) is not hidden behind the panel's dominant id.
      const probeIds = [], probeDepths = [];
      let occluderHits = 0;
      for (let p = 0; p < PROBES_PER_TILE; p++) {
        const k = base + p;
        probeIds.push(probes.hitFlag[k] ? probes.ids[k] : -1);
        probeDepths.push(probes.hitFlag[k] ? probes.depth[k] : NaN);
        if (probes.hitFlag[k] && probes.occluderFlag[k]) occluderHits++;
      }

      // Motion / disocclusion against the previous frame's probe geometry.
      // Frame 1 has no history at all: that is cold start, not a reveal.
      let motion = 0;
      let disoccluded = false;
      if (state.frame > 1 && Number.isFinite(tile.prevDepth) && hits) {
        let revealVotes = 0, motionVotes = 0, compared = 0;
        for (let p = 0; p < PROBES_PER_TILE; p++) {
          const pd = tile.prevProbeDepth[p];
          if (!Number.isFinite(pd) || !probes.hitFlag[base + p]) continue;
          compared++;
          const dNow = probeDepths[p];
          const rel = Math.abs(dNow - pd) / Math.max(0.05, pd);
          if (rel > 0.08) motionVotes++;
          if (tile.prevProbeId[p] !== probeIds[p] && dNow < pd - 0.05) revealVotes++;
        }
        if (compared) {
          motion = clamp(motionVotes / compared, 0, 1);
          disoccluded = revealVotes > 0;
        }
        // Set-based motion: a dynamic object (moving target) entering or leaving
        // the sparse probes changes the tile's id set even when no probe shares
        // a position with the object two frames running.
        const nowIds = new Set(probeIds.filter((x) => x >= 0));
        const prevIds = new Set(tile.prevProbeId.filter((x) => x >= 0));
        let changed = 0;
        for (const id of nowIds) if (!prevIds.has(id)) changed++;
        for (const id of prevIds) if (!nowIds.has(id)) changed++;
        if (changed > 0) motion = Math.max(motion, clamp(0.5 + changed * 0.25, 0, 1));
        // Occluder coverage signal: any panel coverage that shrank frame to
        // frame means part of this tile is newly exposed (the panel edge often
        // crosses the middle of a tile, so a strict covered->clear test would
        // miss the partially revealed tiles where rods get clipped).
        if (tile.prevOccluderHits > occluderHits) disoccluded = true;
      } else if (state.frame > 1 && hits && tile.errorAge > 4) {
        disoccluded = true;
      }
      tile.motion = motion;
      // A reveal event fires only when occluder coverage actually shrinks (or a
      // nearer surface replaces a farther probe). revealHold then keeps the tile
      // fine for a short convergence window, but the disoccluded event flag
      // itself does not linger across the whole screen.
      const revealNow = disoccluded;
      if (revealNow) tile.revealHold = REVEAL_HOLD;
      else tile.revealHold = Math.max(0, tile.revealHold - 1);
      tile.disoccluded = revealNow;
      tile.inRevealWindow = tile.revealHold > 0;
      if (hits) {
        tile.prevDepth = dMean;
        tile.prevId = dominantId;
        tile.prevProbeId = probeIds;
        tile.prevProbeDepth = probeDepths;
      }
      tile.prevOccluderHits = occluderHits;

      // Gaze distance in pixels; foveal radius is one tile width.
      const cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2;
      const gazeDist = Math.hypot(cx - gaze.x, cy - gaze.y);

      out.push({ i, tx, ty, hits, contrast, edge, motion, disoccluded, gazeDist, dominantId, dMean, cMean, base });
    }
  }
  return out;
}

// --- quality map decision ---------------------------------------------------

function decideRates(state, signals, controller, mode, probeShadeCalls) {
  const { tiles } = state;
  const requests = [];

  for (const s of signals) {
    const tile = tiles[s.i];
    const reasons = [];
    let want;

    if (mode === 'fixed') {
      // Initial-version fixed concentric partition, still selectable.
      want = s.gazeDist < TILE * 2.2 ? 1 : s.gazeDist < TILE * 5 ? 2 : 4;
      reasons.push(s.gazeDist < TILE * 2.2 ? 'foveal fixed zone' : s.gazeDist < TILE * 5 ? 'mid fixed zone' : 'peripheral fixed zone');
    } else {
      // Gaze term: distance drives the base rate.
      const gazeScore = clamp(1 - s.gazeDist / (TILE * 9), 0, 1);
      // Edge term from probe geometry, plus probe texture contrast.
      const edgeScore = clamp(s.edge * 0.9 + s.contrast * 2.2, 0, 1);
      // Recent reconstruction error (history validity gates its weight).
      const validError = tile.errorAge < 5;
      const errorScore = validError ? clamp(tile.errorEma * 3.2, 0, 1) : 0;
      if (!validError) reasons.push('error history invalid');
      const motionScore = s.motion;
      const demandRaw =
        gazeScore * 0.38 +
        edgeScore * 0.27 +
        errorScore * 0.22 +
        motionScore * 0.13;
      // Temporal smoothing of the demand itself: probe noise cannot flip the
      // quality map frame to frame, while genuine changes converge in ~3 frames.
      const demand = tile.demandEma = tile.frameCount > 1
        ? tile.demandEma * 0.55 + demandRaw * 0.45
        : demandRaw;
      tile.demand = demand;

      // Asymmetric hysteresis: upgrading uses a lower bar (fast detail recovery),
      // downgrading needs demand to fall well below the upgrade bar.
      want = rate4(tile.rate, demand, gazeScore, s.disoccluded || tile.inRevealWindow, reasons);
    }

    // Temporal flicker control: change at most one rate step per frame.
    // Upgrades (rate goes down => finer sampling) react immediately so newly
    // fixated or revealed detail recovers fast; downgrades are held back for
    // several frames and require sustained low demand, which stops oscillation.
    // Disocclusion overrides the hold because stale coarse history must not
    // persist into a newly visible gap.
    let rate = tile.rate;
    const wantUpgrade = want < rate;
    const wantDowngrade = want > rate;
    const revealActive = s.disoccluded || tile.inRevealWindow;
    if (wantDowngrade && !revealActive && (tile.upgradeHold > 0 || tile.downgradePend < DOWNGRADE_HOLD)) {
      want = rate;
      if (tile.upgradeHold > 0) reasons.push('upgrade hold: detail recovery');
      else reasons.push('downgrade pending: flicker guard');
    }
    if (want < rate) rate = Math.max(RATES[0], rate / 2);
    else if (want > rate) rate = Math.min(RATES[RATES.length - 1], rate * 2);

    tile.ratePrev = tile.rate;
    tile.rate = rate;
    if (rate < tile.ratePrev) {
      tile.upgradeHold = UPGRADE_HOLD;
      tile.downgradePend = 0;
      tile.flickerCount++;
    } else if (rate > tile.ratePrev) {
      tile.upgradeHold = 0;
      tile.downgradePend = 0;
      tile.flickerCount++;
    } else {
      tile.upgradeHold = Math.max(0, tile.upgradeHold - 1);
      tile.downgradePend = wantDowngrade ? tile.downgradePend + 1 : 0;
    }
    tile.reasons = reasons.length ? reasons : ['within hysteresis band'];
    tile.borrowed = false;
    tile.revealConstrained = false;
    requests.push({ i: s.i, tx: s.tx, ty: s.ty, rate, demand: mode === 'fixed' ? 1 - s.gazeDist / (WIDTH * 0.7) : tile.demand, disoccluded: revealActive });
  }

  return enforceBudget(requests, controller, probeShadeCalls);
}

// Region budget controller with cross-band borrowing. A fast target entering a
// low-quality band shows up as a high-demand tile; it may borrow the unused
// share of neighbouring bands instead of being stuck at the local cap.
//
// Disoccluded tiles are reserved at fine sampling: the routine first takes back
// budget from non-disoccluded tiles (lowest demand first), and only constrains
// the reveal when no reclaimable budget remains.
function enforceBudget(requests, controller, probeShadeCalls) {
  const anchorsPerTile = (r) => (TILE / r) * (TILE / r);
  const fullAnchors = TILE * TILE;
  // The shading budget covers every shaded sample: sparse probes plus anchors.
  // Both segments of the reveal experiment therefore spend the same total
  // shading budget, differing only in where the fine samples are spent.
  const globalCap = Math.max(0, controller.globalBudget * WIDTH * HEIGHT - probeShadeCalls);
  const bandOf = (q) => controller.bands.findIndex((b) => q.ty >= b.row0 && q.ty <= b.row1);
  const used = () => requests.reduce((a, q) => a + anchorsPerTile(q.rate), 0);

  // Pass 0: reserve fine sampling for every active reveal tile. Their extra
  // anchors are paid for in the same global cap by reclaiming ordinary tiles in
  // later passes, so a reveal never silently exceeds the shading budget.
  for (const q of requests) {
    if (q.disoccluded && q.rate > 1) {
      q.rate = 1;
      const tile = state_tile(q.i);
      if (tile && !tile.reasons.includes('reveal reserve: fine block')) tile.reasons.push('reveal reserve: fine block');
    }
  }

  // Pass 1: per-band caps, reclaiming only from ordinary (non-reveal) tiles.
  for (let bi = 0; bi < controller.bands.length; bi++) {
    const band = controller.bands[bi];
    const members = requests.filter((q) => bandOf(q) === bi);
    const cap = band.budget * members.length * fullAnchors;
    let bandUsed = members.reduce((a, q) => a + anchorsPerTile(q.rate), 0);
    if (bandUsed <= cap) continue;
    const demotable = members
      .filter((q) => !q.disoccluded && q.rate < 4)
      .sort((a, b) => a.demand - b.demand);
    for (const q of demotable) {
      if (bandUsed <= cap) break;
      const before = anchorsPerTile(q.rate);
      q.rate = Math.min(4, q.rate * 2);
      bandUsed -= before - anchorsPerTile(q.rate);
      state_annotateDemote(q);
    }
  }

  // Pass 2: cross-band borrowing for high-demand tiles, reveal first.
  if (controller.allowBorrow) {
    const bandUsed = controller.bands.map((b, bi) =>
      requests.filter((q) => bandOf(q) === bi).reduce((a, q) => a + anchorsPerTile(q.rate), 0));
    const bandCaps = controller.bands.map((b, bi) => {
      const n = requests.filter((q) => bandOf(q) === bi).length;
      return b.budget * n * fullAnchors;
    });
    let totalUsed = used();
    const upgradable = requests
      .filter((q) => q.rate > 1 && (q.disoccluded || q.demand > 0.5))
      .sort((a, b) => Number(b.disoccluded) - Number(a.disoccluded) || b.demand - a.demand);
    for (const q of upgradable) {
      const home = bandOf(q);
      const cost = anchorsPerTile(q.rate / 2) - anchorsPerTile(q.rate);
      const order = [home, home - 1, home + 1].filter((x) => x >= 0 && x < controller.bands.length);
      for (const bi of order) {
        if (bandCaps[bi] - bandUsed[bi] >= cost && totalUsed + cost <= globalCap) {
          q.rate /= 2;
          bandUsed[bi] += cost;
          totalUsed += cost;
          q.borrowed = bi !== home;
          state_annotateBorrow(q, controller.bands[bi].id, q.borrowed);
          break;
        }
      }
    }
  }

  // Pass 3: global cap. Reclaim from ordinary tiles before touching reveals;
  // if the reveal itself cannot fit, scale it last and flag the shortfall so the
  // debug view can show budget pressure rather than silently dropping detail.
  let totalUsed = used();
  if (totalUsed > globalCap) {
    const ordinary = requests.filter((q) => !q.disoccluded && q.rate < 4).sort((a, b) => a.demand - b.demand);
    for (const q of ordinary) {
      if (totalUsed <= globalCap) break;
      const before = anchorsPerTile(q.rate);
      q.rate = Math.min(4, q.rate * 2);
      totalUsed -= before - anchorsPerTile(q.rate);
      state_annotateDemote(q);
    }
  }
  let revealConstrained = 0;
  if (totalUsed > globalCap) {
    const reveals = requests.filter((q) => q.disoccluded && q.rate < 4).sort((a, b) => a.demand - b.demand);
    for (const q of reveals) {
      if (totalUsed <= globalCap) break;
      const before = anchorsPerTile(q.rate);
      q.rate = Math.min(4, q.rate * 2);
      totalUsed -= before - anchorsPerTile(q.rate);
      q.revealConstrained = true;
      revealConstrained++;
    }
  }

  for (const q of requests) {
    const tile = state_tile(q.i);
    if (tile) {
      tile.rate = q.rate;
      tile.revealConstrained = !!q.revealConstrained;
    }
  }
  return { requests, totalUsed, globalCap, revealConstrained };
}

// Indirection so the pure budget routine can annotate persistent tile state.
let _stateRef = null;
function state_tile(i) { return _stateRef ? _stateRef.tiles[i] : null; }
function state_annotateDemote(q) {
  const t = state_tile(q.i);
  if (t && !t.reasons.includes('budget cap demote')) t.reasons.push('budget cap demote');
}
function state_annotateBorrow(q, bandId, cross) {
  const t = state_tile(q.i);
  if (!t) return;
  t.borrowed = cross;
  t.reasons.push(cross ? `borrow ${bandId} budget` : `${bandId} headroom`);
}

// --- anchor shading + reconstruction ---------------------------------------

function shadeAnchors(camera, dynObjects, requests, state) {
  // Anchor grid stored per pixel of the anchor lattice; reconstruction gathers
  // the four nearest anchors of each tile neighbourhood.
  const anchorColor = new Float32Array(WIDTH * HEIGHT * 3);
  const anchorDepth = new Float32Array(WIDTH * HEIGHT).fill(NaN);
  const anchorId = new Int16Array(WIDTH * HEIGHT).fill(-1);
  const anchorSet = new Uint8Array(WIDTH * HEIGHT);
  const anchorRate = new Uint8Array(WIDTH * HEIGHT).fill(4);
  let traceCalls = 0;
  const trace = { shadeCalls: 0 };

  for (const q of requests) {
    const tile = state.tiles[q.i];
    const r = q.rate;
    const x0 = q.tx * TILE, y0 = q.ty * TILE;
    for (let ay = y0; ay < y0 + TILE; ay += r) {
      for (let ax = x0; ax < x0 + TILE; ax += r) {
        if (anchorSet[ay * WIDTH + ax]) continue;
        const ray = makeProbeRay(camera, ax + 0.5, ay + 0.5);
        const hit = intersectScene(ray, dynObjects);
        traceCalls++;
        const idx = ay * WIDTH + ax;
        if (!hit) {
          anchorColor[idx * 3] = 0.02; anchorColor[idx * 3 + 1] = 0.03; anchorColor[idx * 3 + 2] = 0.06;
          anchorDepth[idx] = Infinity;
          anchorId[idx] = -1;
        } else {
          hit.attr = hitAttributes(hit, ray);
          // Footprint in uv: pixel stride scaled by the surface's uv extent.
          const fp = (r / TILE) * 0.25;
          const c = shadeAtRay(ray, hit, fp, fp, trace);
          anchorColor[idx * 3] = c[0]; anchorColor[idx * 3 + 1] = c[1]; anchorColor[idx * 3 + 2] = c[2];
          anchorDepth[idx] = hit.t;
          anchorId[idx] = hit.objectId;
        }
        anchorSet[idx] = 1;
        anchorRate[idx] = r;
      }
    }
    tile.rate = r;
  }
  return { anchorColor, anchorDepth, anchorId, anchorSet, anchorRate, traceCalls, shadeCalls: trace.shadeCalls };
}

// Nearest existing anchor lattice point to a pixel coordinate. Anchors live on
// per-tile grids whose stride is that tile's rate, so the lattice is irregular
// across tile borders; this walks to the enclosing anchors instead of assuming
// a uniform global stride.
function nearestAnchor(px, py, anchors, state) {
  const tx = clamp(Math.floor(px / TILE), 0, TILES_X - 1);
  const ty = clamp(Math.floor(py / TILE), 0, TILES_Y - 1);
  const r = state.tiles[tileIndex(tx, ty)].rate;
  const x0 = tx * TILE, y0 = ty * TILE;
  const ax = clamp(x0 + Math.round((px - x0) / r) * r, x0, Math.min(WIDTH - 1, x0 + TILE - r));
  const ay = clamp(y0 + Math.round((py - y0) / r) * r, y0, Math.min(HEIGHT - 1, y0 + TILE - r));
  return ay * WIDTH + ax;
}

function gatherSpatial(px, py, anchors, state) {
  const r = state.tiles[tileIndex(
    clamp(Math.floor(px / TILE), 0, TILES_X - 1),
    clamp(Math.floor(py / TILE), 0, TILES_Y - 1),
  )].rate;
  // Sample the anchor lattice at +/- one stride so bilinear weights are exact
  // at rate 1 (stride 1 => the pixel's own anchor dominates).
  const cand = [
    nearestAnchor(px, py, anchors, state),
    nearestAnchor(px + r, py, anchors, state),
    nearestAnchor(px, py + r, anchors, state),
    nearestAnchor(px + r, py + r, anchors, state),
  ];
  const unique = [...new Set(cand)].filter((ai) => anchors.anchorSet[ai]);
  let depthRef = NaN, idRef = -1;
  for (const ai of unique) {
    if (Number.isFinite(anchors.anchorDepth[ai])) { depthRef = anchors.anchorDepth[ai]; idRef = anchors.anchorId[ai]; break; }
  }
  let wsum = 0;
  const acc = [0, 0, 0];
  for (const ai of unique) {
    const ax = ai % WIDTH, ay = Math.floor(ai / WIDTH);
    const d = anchors.anchorDepth[ai];
    const depthOk = !Number.isFinite(d) || !Number.isFinite(depthRef) ||
      Math.abs(d - depthRef) / Math.max(0.05, depthRef) < 0.12;
    const idOk = anchors.anchorId[ai] === idRef || anchors.anchorId[ai] === -1 || idRef === -1;
    // Bilinear kernel on the lattice, heavily gated across silhouette edges.
    const wx = 1 - Math.min(1, Math.abs((ax + 0.5) - (px + 0.5)) / r);
    const wy = 1 - Math.min(1, Math.abs((ay + 0.5) - (py + 0.5)) / r);
    const bilateral = depthOk && idOk ? 1 : 0.05;
    const w = Math.max(0.0001, wx * wy) * bilateral;
    for (let ch = 0; ch < 3; ch++) acc[ch] += anchors.anchorColor[ai * 3 + ch] * w;
    wsum += w;
  }
  if (!wsum) return null;
  return { color: acc.map((v) => v / wsum), depth: depthRef, id: idRef };
}

function reconstruct(camera, anchors, state, requests) {
  const out = new Float32Array(WIDTH * HEIGHT * 3);
  const outDepth = new Float32Array(WIDTH * HEIGHT);
  const outId = new Int16Array(WIDTH * HEIGHT);
  const usedTemporal = new Uint8Array(WIDTH * HEIGHT);
  const invalidMap = new Uint8Array(TILE_COUNT);
  let temporalPixels = 0, spatialPixels = 0, invalidPixels = 0;

  for (let py = 0; py < HEIGHT; py++) {
    for (let px = 0; px < WIDTH; px++) {
      const idx = py * WIDTH + px;
      const gathered = gatherSpatial(px, py, anchors, state);
      let spatial;
      if (gathered) {
        spatial = gathered.color;
        outDepth[idx] = gathered.depth;
        outId[idx] = gathered.id;
      } else {
        // No compatible anchor: fall back to the nearest tile anchor and flag
        // the tile for forced refinement next frame.
        const fb = nearestAnchor(px, py, anchors, state);
        spatial = [
          anchors.anchorColor[fb * 3] ?? 0.02,
          anchors.anchorColor[fb * 3 + 1] ?? 0.03,
          anchors.anchorColor[fb * 3 + 2] ?? 0.06,
        ];
        outDepth[idx] = anchors.anchorDepth[fb];
        outId[idx] = anchors.anchorId[fb];
        const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
        invalidMap[tileIndex(tx, ty)] = 1;
        invalidPixels++;
      }

      // Temporal reproject from previous camera. Disoccluded tiles get no
      // temporal help this frame: their history describes the removed occluder,
      // so carrying it would ghost the panel into the newly visible gap.
      let hist = null;
      const tx0 = clamp(Math.floor(px / TILE), 0, TILES_X - 1);
      const ty0 = clamp(Math.floor(py / TILE), 0, TILES_Y - 1);
      const tileNow = state.tiles[tileIndex(tx0, ty0)];
      if (state.prevCamera && !tileNow.inRevealWindow) {
        const rep = reproject(idx, outDepth[idx], outId[idx], camera, state);
        if (rep) {
          hist = rep;
          usedTemporal[idx] = 1;
          temporalPixels++;
        }
      }

      if (hist) {
        // Old coarse samples get less weight; validity already gates reuse.
        const w = hist.weight * (hist.rate >= 4 ? 0.25 : hist.rate === 2 ? 0.4 : 0.6);
        const k = clamp(w, 0, 0.85);
        for (let ch = 0; ch < 3; ch++) out[idx * 3 + ch] = spatial[ch] * (1 - k) + hist.color[ch] * k;
      } else {
        spatialPixels++;
        for (let ch = 0; ch < 3; ch++) out[idx * 3 + ch] = spatial[ch];
      }
    }
  }
  return { out, outDepth, outId, usedTemporal, invalidMap, temporalPixels, spatialPixels, invalidPixels };
}

// Reproject one previous-frame pixel into this frame using the previous camera
// and this frame's resolved depth. Validity requires matching object id and a
// depth-consistent hit; otherwise the history is dropped rather than trusted.
function reproject(idx, depthThis, idThis, camera, state) {
  if (!Number.isFinite(depthThis)) return null;
  const px = idx % WIDTH, py = Math.floor(idx / WIDTH);
  // Reconstruct the world point from this frame's camera + depth.
  const ray = makeProbeRay(camera, px + 0.5, py + 0.5);
  const world = v3(
    camera.eye.x + ray.d.x * depthThis,
    camera.eye.y + ray.d.y * depthThis,
    camera.eye.z + ray.d.z * depthThis,
  );
  const prev = state.prevCamera;
  const q = sub(world, prev.eye);
  const zc = dot(q, prev.f);
  if (zc <= 0.1) return null;
  const ndcx = dot(q, prev.right) / (zc * prev.tanHalf * prev.aspect);
  const ndcy = dot(q, prev.upv) / (zc * prev.tanHalf);
  const hx = (ndcx + 1) * 0.5 * WIDTH;
  const hy = (1 - ndcy) * 0.5 * HEIGHT;
  const ix = Math.round(hx - 0.5), iy = Math.round(hy - 0.5);
  if (ix < 1 || iy < 1 || ix >= WIDTH - 1 || iy >= HEIGHT - 1) return null;
  const hi = iy * WIDTH + ix;
  if (!state.hist.has[hi]) return null;
  if (state.hist.id[hi] !== idThis || idThis === -1) return null;
  if (Math.abs(state.hist.depth[hi] - zc) / Math.max(0.05, zc) > 0.05) return null;
  return {
    color: [state.hist.color[hi * 3], state.hist.color[hi * 3 + 1], state.hist.color[hi * 3 + 2]],
    weight: state.hist.weight[hi],
    rate: state.hist.rate[hi],
  };
}

// Sparse full-rate probes vs the reconstructed value at the same pixels: the
// only runtime error measurement. No full-frame truth is involved.
function updateErrors(state, probes, recon) {
  for (let i = 0; i < TILE_COUNT; i++) {
    const tile = state.tiles[i];
    const base = i * PROBES_PER_TILE;
    let acc = 0, n = 0;
    const tx = i % TILES_X, ty = Math.floor(i / TILES_X);
    for (let p = 0; p < PROBES_PER_TILE; p++) {
      const k = base + p;
      if (!probes.hitFlag[k]) continue;
      const sx = tx * TILE + PROBE_OFFSETS[p][0];
      const sy = ty * TILE + PROBE_OFFSETS[p][1];
      const idx = Math.round(sy) * WIDTH + Math.round(sx);
      let e = 0;
      for (let ch = 0; ch < 3; ch++) e += (probes.color[k * 3 + ch] - recon.out[idx * 3 + ch]) ** 2;
      acc += Math.sqrt(e / 3);
      n++;
    }
    if (n > 0) {
      const e = acc / n;
      tile.errorEma = tile.errorAge < 5 ? tile.errorEma * 0.6 + e * 0.4 : e;
      tile.errorAge = 0;
    } else {
      tile.errorAge++;
    }
  }
}

function storeHistory(state, recon, requests) {
  const h = state.hist;
  h.has.fill(0);
  for (let py = 0; py < HEIGHT; py++) {
    for (let px = 0; px < WIDTH; px++) {
      const idx = py * WIDTH + px;
      const tx = clamp(Math.floor(px / TILE), 0, TILES_X - 1);
      const ty = clamp(Math.floor(py / TILE), 0, TILES_Y - 1);
      const tile = state.tiles[tileIndex(tx, ty)];
      h.color[idx * 3] = recon.out[idx * 3];
      h.color[idx * 3 + 1] = recon.out[idx * 3 + 1];
      h.color[idx * 3 + 2] = recon.out[idx * 3 + 2];
      h.depth[idx] = recon.outDepth[idx];
      h.id[idx] = recon.outId[idx];
      h.rate[idx] = tile.rate;
      h.weight[idx] = recon.usedTemporal[idx] ? Math.min(1, (h.weight[idx] || 0) + 0.25) : 0.35;
      h.has[idx] = Number.isFinite(recon.outDepth[idx]) || recon.outId[idx] === -1 ? 1 : 0;
    }
  }
}

// --- frame entry point ------------------------------------------------------

export function renderFrame(state, camera, gaze, dynObjects, opts = {}) {
  _stateRef = state;
  const mode = opts.mode === 'fixed' ? 'fixed' : 'adaptive';
  const controller = opts.controller ?? createBudgetController();
  state.frame++;

  const probes = runProbes(camera, dynObjects);
  const signals = tileSignals(state, probes, camera, gaze);
  const budgetResult = decideRates(state, signals, controller, mode, probes.shadeCalls);
  const requests = budgetResult.requests;
  const anchors = shadeAnchors(camera, dynObjects, requests, state);
  const recon = reconstruct(camera, anchors, state, requests);
  updateErrors(state, probes, recon);

  // Invalid spatial gathers force the tile to fine sampling next frame.
  for (let i = 0; i < TILE_COUNT; i++) {
    if (recon.invalidMap[i]) {
      state.tiles[i].rate = 1;
      state.tiles[i].upgradeHold = UPGRADE_HOLD;
      if (!state.tiles[i].reasons.includes('invalid gather: refine')) state.tiles[i].reasons.push('invalid gather: refine');
    }
  }

  storeHistory(state, recon, requests);
  state.prevCamera = camera;
  state.prevGaze = { ...gaze };

  const anchorCount = requests.reduce((a, q) => a + (TILE / q.rate) * (TILE / q.rate), 0);
  const rateHist = { 1: 0, 2: 0, 4: 0 };
  for (const q of requests) rateHist[q.rate]++;
  const flickerFrames = state.tiles.reduce((a, t) => a + (t.rate !== t.ratePrev ? 1 : 0), 0);
  const stats = {
    frame: state.frame,
    mode,
    traceCalls: probes.traceCalls + anchors.traceCalls,
    probeTraceCalls: probes.traceCalls,
    anchorTraceCalls: anchors.traceCalls,
    probeShadeCalls: probes.shadeCalls,
    shadeCalls: probes.shadeCalls + anchors.shadeCalls,
    anchorShadeCalls: anchors.shadeCalls,
    anchorCount,
    fullPixels: WIDTH * HEIGHT,
    shadeFraction: (probes.shadeCalls + anchors.shadeCalls) / (WIDTH * HEIGHT),
    rateHist,
    flickerTiles: flickerFrames,
    temporalPixels: recon.temporalPixels,
    spatialPixels: recon.spatialPixels,
    invalidPixels: recon.invalidPixels,
    disoccludedTiles: state.tiles.filter((t) => t.disoccluded).length,
    borrowedTiles: state.tiles.filter((t) => t.borrowed).length,
    revealConstrained: budgetResult.revealConstrained,
    budgetUsedAnchors: budgetResult.totalUsed,
    globalCapAnchors: budgetResult.globalCap,
  };
  state.stats = stats;
  _stateRef = null;

  // Display-ready image (gamma/tone map), plus the linear HDR buffer.
  const display = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const d = toDisplay([recon.out[i * 3], recon.out[i * 3 + 1], recon.out[i * 3 + 2]]);
    display[i * 4] = d[0] * 255;
    display[i * 4 + 1] = d[1] * 255;
    display[i * 4 + 2] = d[2] * 255;
    display[i * 4 + 3] = 255;
  }

  return { display, linear: recon.out, stats, requests, probes };
}
