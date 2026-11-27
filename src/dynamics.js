// Per-frame dynamic scene state: the fine fence, its sliding occluder and the
// fast moving target. All geometry is expressed in the same world space as the
// static scene in scene.js and appended to the intersection list per frame, so
// the static table never mutates.
import { v3 } from './math.js';

// Fine fence: thin vertical rods at world x in [-2.35, -1.05], z=-2.2.
// Under CAMERA_A they project to screen x roughly 24..187, i.e. the left
// periphery, well outside the gaze window centred at (330,150).
export const FENCE_Z = -2.2;
export const FENCE_Y = { min: -1.45, max: 1.45 };
export const FENCE_XS = [-2.32, -2.18, -2.04, -1.9, -1.76, -1.62, -1.48, -1.34, -1.2, -1.06];
export const FENCE_R = 0.0055;

// Sliding panel in front of the fence (closer to camera => smaller z).
const SLIDER_Z = -1.82;
const SLIDER_HALF_U = 0.95;
const SLIDER_HALF_V = 1.62;
// Panel centre in segment 1: spans world x roughly [-2.65, -0.75], hiding every
// fence rod. In segment 2 it slides up; its bottom edge rises above the rods.
const SLIDER_HIDDEN_CX = -1.7;
const SLIDER_HIDDEN_CY = 0;
const SLIDER_GONE_CY = 4.6;

// Fast target: bright sphere crossing the frame at constant speed. Sized so the
// sparse per-tile probes reliably intersect it, and routed high enough to pass
// through the top peripheral budget band before reaching the fovea.
export const TARGET_R = 0.34;
const TARGET_Z = -3.4;
const TARGET_Y = 1.35;
const TARGET_X0 = -3.1;
const TARGET_X1 = 3.3;

export const DYN_IDS = {
  fenceBase: 32,
  slider: 48,
  target: 49,
};

function fenceObjects() {
  return FENCE_XS.map((x, i) => ({
    id: DYN_IDS.fenceBase + i,
    kind: 'rod',
    material: 'fence',
    x,
    z: FENCE_Z,
    r: FENCE_R,
    yMin: FENCE_Y.min,
    yMax: FENCE_Y.max,
    dynamic: 'fence',
  }));
}

function sliderObject(cy) {
  return {
    id: DYN_IDS.slider,
    kind: 'quad',
    material: 'panel',
    normal: v3(0, 0, 1),
    center: v3(SLIDER_HIDDEN_CX, cy, SLIDER_Z),
    u: v3(1, 0, 0),
    v: v3(0, 1, 0),
    half: { u: SLIDER_HALF_U, v: SLIDER_HALF_V },
    dynamic: 'slider',
  };
}

function targetObject(x) {
  return {
    id: DYN_IDS.target,
    kind: 'sphere',
    material: 'target',
    c: v3(x, TARGET_Y, TARGET_Z),
    r: TARGET_R,
    dynamic: 'target',
  };
}

// Scenarios share one clock. Each frame descriptor carries:
//  - objects: dynamic objects to append this frame
//  - camera / gaze trajectories
//  - flags the controller is allowed to read (no ground-truth error here)
export const SCENARIOS = {
  // Segment 1 reference: static camera, gaze sweeps, panel stays in front of
  // the fence so the rods are never visible.
  occluded: {
    label: 'Segment 1: gaze sweep, fence occluded',
    frames: 40,
    camera: 'staticA',
    panel: 'hidden',
    target: false,
  },
  // Segment 2: identical camera + gaze trajectory, panel slides away so the
  // fence gaps become visible for the first time.
  revealed: {
    label: 'Segment 2: same sweep, panel removed',
    frames: 40,
    camera: 'staticA',
    panel: 'slideAway',
    target: false,
  },
  // Fast horizontal saccade across the whole frame while the fence stays
  // hidden: tests recovery latency of newly fixated regions.
  saccade: {
    label: 'Fast saccade',
    frames: 36,
    camera: 'staticA',
    panel: 'hidden',
    target: false,
    gaze: 'sweepWide',
  },
  // Fine-textured moving target crossing the low-quality peripheral bands.
  targetMotion: {
    label: 'Fine-textured fast target',
    frames: 44,
    camera: 'staticA',
    panel: 'none',
    target: true,
    gaze: 'center',
  },
  // Sudden reveal without any gaze motion: disocclusion alone must force a
  // fine-sampling block even though every quality-map input except the
  // geometry-derived validity signal is unchanged.
  suddenReveal: {
    label: 'Sudden disocclusion, static gaze',
    frames: 30,
    camera: 'staticA',
    panel: 'slideAwayLate',
    target: false,
    gaze: 'center',
  },
};

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// Gaze sweep shared by segments 1 and 2: starts on the poster centre, drifts
// toward the left periphery (over the fence region) and back.
function sharedGaze(frame, frames) {
  const t = frame / (frames - 1);
  const e = easeInOut(t);
  return {
    x: 330 - 250 * Math.sin(e * Math.PI),
    y: 150 + 24 * Math.sin(e * Math.PI * 2),
  };
}

function gazeFor(scenario, frame, frames) {
  if (scenario.gaze === 'center') return { x: 330, y: 150 };
  if (scenario.gaze === 'sweepWide') {
    const t = easeInOut(frame / (frames - 1));
    return { x: 90 + 460 * t, y: 150 + 30 * Math.sin(t * Math.PI) };
  }
  return sharedGaze(frame, frames);
}

// Returns the dynamic world for one frame. `camera` is imported lazily by the
// caller; here we only return the key the renderer should resolve.
export function frameState(name, frame) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  const frames = scenario.frames;
  const objects = [];

  let panelCy = SLIDER_HIDDEN_CY;
  if (scenario.panel === 'none') {
    panelCy = SLIDER_GONE_CY;
  } else if (scenario.panel === 'slideAway') {
    // Begin moving immediately; the panel's bottom edge clears the fence over
    // roughly the first third of the clip.
    const t = Math.min(1, frame / (frames * 0.34));
    panelCy = SLIDER_HIDDEN_CY + (SLIDER_GONE_CY - SLIDER_HIDDEN_CY) * easeInOut(t);
  } else if (scenario.panel === 'slideAwayLate') {
    // Hold fully hidden past the history warm-up, then move quickly.
    const t = Math.max(0, Math.min(1, (frame - frames * 0.45) / (frames * 0.18)));
    panelCy = SLIDER_HIDDEN_CY + (SLIDER_GONE_CY - SLIDER_HIDDEN_CY) * easeInOut(t);
  }
  const panelVisible = panelCy - SLIDER_HALF_V < FENCE_Y.max + 0.1;
  if (panelVisible) objects.push(sliderObject(panelCy));

  objects.push(...fenceObjects());

  if (scenario.target) {
    const t = frame / (frames - 1);
    objects.push(targetObject(TARGET_X0 + (TARGET_X1 - TARGET_X0) * t));
  }

  return {
    name,
    frame,
    frames,
    objects,
    gaze: gazeFor(scenario, frame, frames),
    panelCy,
    panelVisible,
    panelBottom: panelCy - SLIDER_HALF_V,
  };
}

export const SLIDER = {
  z: SLIDER_Z,
  halfU: SLIDER_HALF_U,
  halfV: SLIDER_HALF_V,
  hiddenCx: SLIDER_HIDDEN_CX,
  hiddenCy: SLIDER_HIDDEN_CY,
  goneCy: SLIDER_GONE_CY,
};

export const TARGET = { r: TARGET_R, z: TARGET_Z, y: TARGET_Y, x0: TARGET_X0, x1: TARGET_X1 };
