/**
 * Trail-braking trainer: a deliberately simple top-down car model that
 * rewards the real technique.
 *
 *  - Friction circle: braking and cornering share one grip budget.
 *  - Load transfer: the front tyres gain grip while the brake is still on
 *    (weight on the nose) and lose some when you are off the brake or on the
 *    throttle — so releasing the brake *as* you turn in lets the car rotate,
 *    releasing it all before turn-in makes it push wide, and holding too much
 *    brake while steering overruns the circle and the front slides.
 *
 * Units: metres, seconds, m/s. Heading 0 = +y; positive steer/curvature = right.
 */

export interface CornerSpec {
  id: "hairpin" | "medium" | "fast";
  /** Centre-line radius, m. */
  radius: number;
  /** Turn angle, rad (right-hander). */
  angle: number;
  /** Straight before the corner, m. */
  approach: number;
  /** Straight after the corner counted for the result, m. */
  exit: number;
  /** Speed at the start, km/h. */
  startKmh: number;
}

export const ROAD_HALF_WIDTH = 6;

export const CORNERS: Record<CornerSpec["id"], CornerSpec> = {
  hairpin: { id: "hairpin", radius: 18, angle: Math.PI, approach: 320, exit: 140, startKmh: 230 },
  medium: { id: "medium", radius: 45, angle: Math.PI / 2, approach: 320, exit: 160, startKmh: 240 },
  fast: { id: "fast", radius: 110, angle: Math.PI / 3, approach: 320, exit: 180, startKmh: 260 },
};

export interface Inputs {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1..1 (right +)
}

export interface CarState {
  x: number;
  y: number;
  heading: number;
  v: number;
  t: number;
  /** Progress along the centre line, m. */
  s: number;
  /** Signed offset from the centre line, m (right +). */
  lateral: number;
  /** Longitudinal and lateral acceleration used, m/s² (for the friction-circle dot). */
  ax: number;
  ay: number;
  /** Grip available at this instant, m/s². */
  grip: number;
  /** The front is sliding (asked for more than the circle allows). */
  sliding: boolean;
  offTrack: boolean;
  gear: number;
  rpm: number;
}

export interface Sample extends Inputs {
  t: number;
  s: number;
  v: number;
  lateral: number;
  /** Fraction of the friction circle in use (can exceed 1 while sliding). */
  usage: number;
  sliding: boolean;
  gear: number;
  rpm: number;
}

// ── Gearbox (GT3-like sequential, 6 speeds) ──────────────────────────────

/** Speed at the limiter in each gear, km/h (index 0 unused). */
export const GEAR_TOP_KMH = [0, 98, 138, 174, 208, 244, 292];
export const REDLINE_RPM = 8500;
const LIMITER_RPM = 8800;
/** A downshift that would spin the engine past this is refused (like ACC's protection). */
export const MAX_DOWNSHIFT_RPM = 8900;

export function rpmFor(v: number, gear: number): number {
  return (v * 3.6 / GEAR_TOP_KMH[gear]) * REDLINE_RPM;
}

/** Torque shape: weak low down, flat 6000–8200, nothing past the limiter. */
export function torqueFactor(rpm: number): number {
  if (rpm >= LIMITER_RPM) return 0;
  if (rpm < 3000) return 0.45;
  if (rpm < 6000) return 0.45 + 0.55 * ((rpm - 3000) / 3000);
  if (rpm <= 8200) return 1;
  return 1 - 0.7 * ((rpm - 8200) / (LIMITER_RPM - 8200));
}

/** Highest-torque gear for a speed: the lowest gear that keeps the engine under ~8000 rpm. */
export function bestGearFor(v: number): number {
  for (let g = 1; g <= 6; g++) if (rpmFor(v, g) <= 8000) return g;
  return 6;
}

/** Engine braking off the throttle, m/s²: stronger at high revs. */
function engineBrakeAtRpm(rpm: number): number {
  return 0.4 + 1.6 * Math.min(1, rpm / REDLINE_RPM);
}

/** Engine braking when already in the best gear for v (what the ideal assumes). */
function engineBrakeDecel(v: number): number {
  return v > 2 ? engineBrakeAtRpm(rpmFor(v, bestGearFor(v))) : 0;
}

export type ShiftResult = { ok: true; car: CarState } | { ok: false; reason: "overrev" | "limit" };

/** Sequential shift; downshifts that would over-rev are refused. */
export function shift(car: CarState, dir: 1 | -1): ShiftResult {
  const gear = car.gear + dir;
  if (gear < 1 || gear > 6) return { ok: false, reason: "limit" };
  const rpm = rpmFor(car.v, gear);
  if (dir < 0 && rpm > MAX_DOWNSHIFT_RPM) return { ok: false, reason: "overrev" };
  return { ok: true, car: { ...car, gear, rpm } };
}

const G = 9.81;
/** Curvature at full steering lock, 1/m (≈ 8 m turning radius). */
const MAX_CURVATURE = 0.125;
const POWER_PER_KG = 285; // W/kg ≈ GT3
const DRAG_K = 0.0004; // m⁻¹ — top speed ≈ 320 km/h
const MAX_ENGINE_ACCEL = 8;

/** Base friction coefficient with a little aero: grows with speed. */
function mu(v: number): number {
  return Math.min(1.9, 1.35 + 0.4 * (v / 70) ** 2);
}

/**
 * Front grip multiplier from load transfer: up to +12% with ≥40% brake,
 * −12% coasting, a further −10% on full throttle.
 */
export function frontGripFactor(brake: number, throttle: number): number {
  return 0.88 + 0.24 * Math.min(1, brake / 0.4) - 0.1 * throttle;
}

// ── Track geometry (straight → right-hand arc → straight) ────────────────

export interface Projection { s: number; lateral: number; heading: number }

/**
 * Nearest centre-line position. Pieces can lie side by side (a hairpin's exit
 * runs back along its entry), so among the pieces the point projects onto,
 * the one closest to the previous progress `hintS` wins.
 */
export function project(spec: CornerSpec, x: number, y: number, hintS = 0): Projection {
  const { radius: R, angle: A, approach: L } = spec;
  const candidates: Projection[] = [];
  // approach straight: (0, 0) → (0, L), heading +y; right of the line = +x
  if (y <= L) candidates.push({ s: y, lateral: x, heading: 0 });
  // arc: centre (R, L); angle 0 at the arc start, growing clockwise toward +x
  const dx = x - R, dy = y - L;
  let phi = Math.atan2(dy, -dx);
  if (phi < 0) phi += 2 * Math.PI;
  if (phi <= A) candidates.push({ s: L + phi * R, lateral: R - Math.hypot(dx, dy), heading: phi });
  // exit straight
  const ex = R - R * Math.cos(A), ey = L + R * Math.sin(A);
  const hx = Math.sin(A), hy = Math.cos(A);
  const along = (x - ex) * hx + (y - ey) * hy;
  if (along >= 0) candidates.push({ s: L + A * R + along, lateral: (x - ex) * hy - (y - ey) * hx, heading: A });
  if (candidates.length === 0) return { s: hintS, lateral: Number.POSITIVE_INFINITY, heading: 0 };
  // Plausible pieces (near the road) first, then the one nearest the previous progress.
  const near = candidates.filter((c) => Math.abs(c.lateral) < ROAD_HALF_WIDTH * 3);
  const pool = near.length > 0 ? near : candidates;
  return pool.reduce((best, c) => (Math.abs(c.s - hintS) < Math.abs(best.s - hintS) ? c : best));
}

export function trackLength(spec: CornerSpec): number {
  return spec.approach + spec.angle * spec.radius + spec.exit;
}

/** Centre-line point at progress s (for drawing the road). */
export function centreAt(spec: CornerSpec, s: number): { x: number; y: number; heading: number } {
  const { radius: R, angle: A, approach: L } = spec;
  if (s <= L) return { x: 0, y: s, heading: 0 };
  const arcLen = A * R;
  if (s <= L + arcLen) {
    const phi = (s - L) / R;
    return { x: R - R * Math.cos(phi), y: L + R * Math.sin(phi), heading: phi };
  }
  const along = s - L - arcLen;
  const ex = R - R * Math.cos(A), ey = L + R * Math.sin(A);
  return { x: ex + Math.sin(A) * along, y: ey + Math.cos(A) * along, heading: A };
}

// ── Simulation ───────────────────────────────────────────────────────────

export function initialState(spec: CornerSpec): CarState {
  // Start on the outside (left) of the road, as a racing line would.
  const v = spec.startKmh / 3.6;
  const gear = Math.max(bestGearFor(v), 4);
  return { x: -ROAD_HALF_WIDTH + 1.5, y: 0, heading: 0, v, t: 0, s: 0, lateral: -ROAD_HALF_WIDTH + 1.5, ax: 0, ay: 0, grip: mu(v) * G, sliding: false, offTrack: false, gear, rpm: rpmFor(v, gear) };
}

export interface StepOptions {
  /** Shift by itself (no gear score). */
  autoGear?: boolean;
}

/** Advance the car by dt seconds (call with small steps, ≤ 1/120 s). */
export function step(spec: CornerSpec, car: CarState, input: Inputs, dt: number, options: StepOptions = {}): CarState {
  const brake = Math.min(1, Math.max(0, input.brake));
  const throttle = brake > 0.05 ? 0 : Math.min(1, Math.max(0, input.throttle));
  const steer = Math.min(1, Math.max(-1, input.steer));
  const v = car.v;
  const grip = mu(v) * G;

  let gear = car.gear;
  if (options.autoGear) {
    if (rpmFor(v, gear) > 8300 && gear < 6) gear++;
    else if (gear > 1 && rpmFor(v, gear) < 5200 && rpmFor(v, gear - 1) < 8000) gear--;
  }
  const rpm = rpmFor(v, gear);
  const brakeDecel = v > 0.5 ? brake * grip : 0;
  const engine = Math.min(MAX_ENGINE_ACCEL, POWER_PER_KG / Math.max(v, 5)) * throttle * torqueFactor(rpm);
  const engineBrake = throttle < 0.05 && v > 2 ? engineBrakeAtRpm(rpm) : 0;
  const drag = DRAG_K * v * v + engineBrake;

  // Lateral: what the steering asks for vs what the (front) tyres can give
  // after braking has taken its share of the circle.
  const frontGrip = grip * frontGripFactor(brake, throttle);
  const lateralCap = Math.sqrt(Math.max(0, frontGrip * frontGrip - brakeDecel * brakeDecel));
  const wanted = steer * MAX_CURVATURE;
  const wantedAy = v * v * Math.abs(wanted);
  const sliding = wantedAy > lateralCap + 0.05;
  const curvature = sliding ? Math.sign(wanted) * (lateralCap / Math.max(v * v, 1)) : wanted;
  // A sliding front also scrubs speed.
  const scrub = sliding ? Math.min(4, (wantedAy - lateralCap) * 0.5) : 0;

  const nv = Math.max(0, v + (engine - drag - brakeDecel - scrub) * dt);
  const heading = car.heading + v * curvature * dt;
  const x = car.x + v * Math.sin(heading) * dt;
  const y = car.y + v * Math.cos(heading) * dt;
  const p = project(spec, x, y, car.s);
  return {
    x,
    y,
    heading,
    v: nv,
    t: car.t + dt,
    s: Math.max(car.s, p.s),
    lateral: p.lateral,
    ax: -(engine - drag - brakeDecel),
    ay: v * v * curvature,
    grip,
    sliding,
    offTrack: Math.abs(p.lateral) > ROAD_HALF_WIDTH + 1,
    gear,
    rpm: rpmFor(nv, gear),
  };
}

export function sampleOf(car: CarState, input: Inputs): Sample {
  const usage = Math.hypot(car.ax, car.ay) / car.grip;
  return { ...input, t: car.t, s: car.s, v: car.v, lateral: car.lateral, usage, sliding: car.sliding, gear: car.gear, rpm: car.rpm };
}

// ── Ideal reference (for the "you vs ideal" chart) ───────────────────────

export interface IdealPoint { s: number; brake: number; steer: number; kmh: number; gear: number }

/**
 * A textbook trail-brake for this corner: full brake on a straight line,
 * then the brake bleeds off linearly while the steering winds on, reaching
 * zero at the apex (mid-corner); throttle from the apex.
 */
export function idealTrace(spec: CornerSpec): IdealPoint[] {
  const STEP = 1;
  const end = trackLength(spec);
  const n = Math.floor(end / STEP) + 1;
  // Path along the ideal line, with its curvature.
  const pts = Array.from({ length: n }, (_, i) => linePoint(spec, i * STEP));
  const kappa = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const h1 = Math.atan2(b.x - a.x, b.y - a.y), h2 = Math.atan2(c.x - b.x, c.y - b.y);
    let dh = h2 - h1;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    const len = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) / 2;
    kappa[i] = dh / Math.max(len, 0.01);
  }
  // Smooth the numeric curvature a little.
  const k = Float64Array.from(kappa, (_, i) => {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) { sum += kappa[j]; cnt++; }
    return sum / cnt;
  });
  const segLen = Array.from({ length: n }, (_, i) => (i === 0 ? 0 : Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)));

  // Lateral capacity for a brake level (same physics as `step`), with a margin for real drivers.
  const MARGIN = 0.95;
  const lateralCap = (v: number, b: number) => mu(v) * G * MARGIN * Math.sqrt(Math.max(0, frontGripFactor(b, 0) ** 2 - b * b));
  /** Most brake (0..1) that still leaves enough lateral grip for curvature κ at speed v; -1 if none. */
  const maxBrake = (v: number, kap: number): number => {
    const need = v * v * Math.abs(kap);
    for (let b = 1; b >= 0; b -= 0.02) if (lateralCap(v, b) >= need) return b;
    return -1;
  };
  // Speed limit from cornering alone (best brake level for lateral grip ≈ 0.4).
  const vLimit = Float64Array.from(k, (kap) => {
    if (Math.abs(kap) < 1e-4) return 1e9;
    let v = 30;
    for (let it = 0; it < 6; it++) v = Math.sqrt(lateralCap(v, 0.4) / Math.abs(kap));
    return v;
  });
  // Backward pass: braking into each limit within the friction circle.
  const back = Float64Array.from(vLimit);
  for (let i = n - 2; i >= 0; i--) {
    const v = back[i + 1];
    const b = Math.max(0, maxBrake(v, k[i + 1]));
    const decel = b * mu(v) * G + DRAG_K * v * v + engineBrakeDecel(v);
    back[i] = Math.min(vLimit[i], Math.sqrt(v * v + 2 * decel * segLen[i + 1]));
  }
  // Forward pass: start speed, flat out where the limit allows.
  const v0 = spec.startKmh / 3.6;
  const fwd = new Float64Array(n);
  fwd[0] = Math.min(v0, back[0]);
  for (let i = 1; i < n; i++) {
    const v = fwd[i - 1];
    const accel = Math.min(MAX_ENGINE_ACCEL, POWER_PER_KG / Math.max(v, 5)) - DRAG_K * v * v;
    fwd[i] = Math.min(back[i], Math.sqrt(Math.max(0, v * v + 2 * accel * segLen[i])));
  }
  const out: IdealPoint[] = [];
  for (let i = 0; i < n; i += 2) {
    const v = fwd[i];
    const next = fwd[Math.min(n - 1, i + 1)];
    // What the brakes must add on top of drag and engine braking (in the right gear).
    const decelNeeded = (v * v - next * next) / (2 * Math.max(segLen[Math.min(n - 1, i + 1)], 0.01)) - DRAG_K * v * v - engineBrakeDecel(v);
    const brake = decelNeeded > 0.3 ? Math.min(1, decelNeeded / (mu(v) * G)) : 0;
    out.push({ s: i * STEP, brake, steer: Math.max(-1, Math.min(1, k[i] / MAX_CURVATURE)), kmh: v * 3.6, gear: bestGearFor(v) });
  }
  return shapeTrailBrake(spec, out);
}

/**
 * The numeric brake demand is noisy (curvature from finite differences). Give
 * it the textbook shape it approximates: one ramp up to the peak, then a
 * release that only ever decreases until the apex, nothing after the apex.
 */
function shapeTrailBrake(spec: CornerSpec, pts: IdealPoint[]): IdealPoint[] {
  const cs = spec.approach, ce = spec.approach + spec.angle * spec.radius;
  let apex = -1;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].s < cs - 40 || pts[i].s > ce) continue;
    if (apex < 0 || pts[i].kmh < pts[apex].kmh) apex = i;
  }
  const first = pts.findIndex((p) => p.brake > 0.05);
  if (apex < 0 || first < 0 || first >= apex) return pts;
  const smooth = pts.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(first, i - 3); j <= Math.min(apex, i + 3); j++) { sum += pts[j].brake; n++; }
    return n > 0 ? sum / n : 0;
  });
  let peak = first;
  for (let i = first; i <= apex; i++) if (smooth[i] > smooth[peak] + 1e-6) peak = i;
  return pts.map((p, i) => {
    if (i < first || i > apex) return { ...p, brake: 0 };
    if (i <= peak) return { ...p, brake: i === peak ? smooth[peak] : Math.max(smooth[i], smooth[peak] * Math.min(1, (i - first + 1) / 3)) };
    // Upper envelope towards the apex: never less brake than the demand still ahead.
    let b = smooth[i];
    for (let j = i; j <= apex; j++) b = Math.max(b, smooth[j]);
    return { ...p, brake: b };
  });
}

/**
 * The ideal line: outside on the approach, clipping the inside at the apex,
 * back to the outside on exit (smooth cosine blends). Returns the offset from
 * the centre line (right +) at progress s.
 */
export function idealLateral(spec: CornerSpec, s: number): number {
  const w = ROAD_HALF_WIDTH - 1.2;
  const cs = spec.approach, ce = spec.approach + spec.angle * spec.radius;
  const apex = (cs + ce) / 2;
  const entry = cs - Math.min(60, 15 + spec.radius * 0.6);
  const exit = ce + Math.min(80, 25 + spec.radius * 0.8);
  const blend = (u: number) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;
  if (s <= entry || s >= exit) return -w;
  if (s <= apex) return -w + 2 * w * blend((s - entry) / (apex - entry));
  return w - 2 * w * blend((s - apex) / (exit - apex));
}

/** World point of the ideal line at progress s. */
export function linePoint(spec: CornerSpec, s: number): { x: number; y: number } {
  const c = centreAt(spec, s);
  const off = idealLateral(spec, s);
  return { x: c.x + off * Math.cos(c.heading), y: c.y - off * Math.sin(c.heading) };
}

// ── Scoring ──────────────────────────────────────────────────────────────

export interface ScorePart {
  key: "application" | "trail" | "smoothness" | "grip" | "gear" | "result";
  points: number;
  max: number;
}

export interface Score {
  total: number;
  parts: ScorePart[];
  /** Short pt-BR coaching lines, most important first. */
  tips: string[];
  timeS: number;
  minKmh: number;
  offTrack: boolean;
}

/** Ideal gear at the apex of this corner (shown before the attempt). */
export function idealApexGear(spec: CornerSpec): number {
  return bestGearFor(Math.min(...idealTrace(spec).map((p) => p.kmh)) / 3.6);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Grade one attempt from its samples. */
export function scoreAttempt(spec: CornerSpec, samples: readonly Sample[], finished: boolean, options: { manualGear?: boolean } = {}): Score {
  const tips: string[] = [];
  const offTrack = samples.some((s) => Math.abs(s.lateral) > ROAD_HALF_WIDTH + 1);
  const timeS = samples.length > 0 ? samples[samples.length - 1].t : 0;
  const cornerStart = spec.approach;
  const cornerEnd = spec.approach + spec.angle * spec.radius;
  const inCorner = samples.filter((s) => s.s >= cornerStart - 40 && s.s <= cornerEnd);
  const apexIdx = inCorner.length > 0 ? inCorner.reduce((best, s, i) => (s.v < inCorner[best].v ? i : best), 0) : -1;
  const apex = apexIdx >= 0 ? inCorner[apexIdx] : undefined;
  const minKmh = apex ? apex.v * 3.6 : 0;

  // 1. Application: reach strong pressure fast.
  const brakeStartIdx = samples.findIndex((s) => s.brake > 0.1);
  let application = 0;
  if (brakeStartIdx >= 0) {
    const t0 = samples[brakeStartIdx].t;
    const early = samples.filter((s) => s.t >= t0 && s.t <= t0 + 0.35);
    const peak = Math.max(...early.map((s) => s.brake));
    application = clamp01((peak - 0.4) / 0.5);
    if (peak < 0.75) tips.push("Pisa forte logo no início da freada: o carro está leve e aguenta quase 100% de freio em linha reta.");
  } else {
    tips.push("Você não freou: escolha um ponto de freada e pise forte.");
  }

  // 2. Trail: the brake still on (and coming off) while the steering winds on, ending near the apex.
  let trail = 0;
  if (apex) {
    const peakSteer = Math.max(...inCorner.map((s) => Math.abs(s.steer)), 0.01);
    const entry = samples.filter((s) => s.t <= apex.t && Math.abs(s.steer) >= peakSteer * 0.15);
    const overlap = entry.filter((s) => s.brake > 0.05).length / Math.max(1, entry.length);
    const lastBrake = [...samples].reverse().find((s) => s.brake > 0.05 && s.t <= apex.t + 1);
    const releaseGapS = lastBrake ? Math.abs(apex.t - lastBrake.t) : Number.POSITIVE_INFINITY;
    const overlapScore = clamp01(overlap / 0.5); // half the turn-in phase or more with some brake
    const timingScore = releaseGapS === Number.POSITIVE_INFINITY ? 0 : clamp01(1 - (releaseGapS - 0.3) / 1.2);
    trail = 0.6 * overlapScore + 0.4 * timingScore;
    if (overlap < 0.2) tips.push("Soltou o freio antes de virar: mantenha um pouco de freio enquanto gira o volante, a frente fica com mais aderência.");
    else if (releaseGapS > 0.8 && lastBrake && lastBrake.t < apex.t) tips.push("Terminou de soltar o freio cedo demais: vá soltando até perto do ápice.");
  }

  // 3. Smoothness: no re-application or stabbing once the release has begun.
  let reapply = 0;
  let peakSeen = 0;
  for (let i = 1; i < samples.length; i++) {
    peakSeen = Math.max(peakSeen, samples[i].brake);
    if (peakSeen > 0.5 && samples[i].brake > 0.05 && samples[i].brake - samples[i - 1].brake > 0.02 && samples[i].brake < peakSeen - 0.1) reapply += samples[i].brake - samples[i - 1].brake;
  }
  const smoothness = clamp01(1 - reapply / 0.4);
  if (reapply > 0.15) tips.push("Soltura irregular: tire o pé do freio num movimento contínuo, sem voltar a apertar.");

  // 4. Grip use during the entry: near the limit, not over it.
  let grip = 0;
  if (apex && brakeStartIdx >= 0) {
    const entry = samples.filter((s) => s.t >= samples[brakeStartIdx].t && s.t <= apex.t);
    const usage = entry.reduce((a, s) => a + Math.min(1, s.usage), 0) / Math.max(1, entry.length);
    const slideFrac = entry.filter((s) => s.sliding).length / Math.max(1, entry.length);
    grip = clamp01((usage - 0.55) / 0.35) * (1 - clamp01(slideFrac / 0.3));
    if (slideFrac > 0.1) tips.push("A frente escorregou: freio e volante juntos passaram do limite. Solte o freio um pouco mais rápido conforme vira.");
    else if (usage < 0.75) tips.push("Sobrou aderência na entrada: dá pra frear mais tarde ou levar mais freio até a curva.");
  }

  // 5. Result: stayed on the road and carried speed.
  const ideal = idealTrace(spec);
  const idealMin = Math.min(...ideal.map((p) => p.kmh));
  let result = 0;
  if (finished && !offTrack) result = 0.4 + 0.6 * clamp01(1 - Math.abs(minKmh - idealMin) / (idealMin * 0.35));
  if (offTrack) tips.unshift("Saiu da pista: freie um pouco antes até pegar o ritmo.");
  else if (finished && minKmh < idealMin * 0.8) tips.push(`Mínima baixa (${Math.round(minKmh)} km/h): dá pra levar uns ${Math.round(idealMin)} km/h no ápice.`);

  // 6. Gears (manual gearbox only): right gear at the apex, downshifts done while braking.
  let gearScore = 0;
  const apexGearTarget = bestGearFor((idealMin / 3.6));
  if (options.manualGear && apex) {
    const off = Math.abs(apex.gear - apexGearTarget);
    const turnInSample = samples.find((s) => s.s >= cornerStart - 5);
    const readyAtTurnIn = turnInSample ? Math.abs(turnInSample.gear - apexGearTarget) <= 1 : false;
    gearScore = clamp01(1 - off / 2) * 0.6 + (readyAtTurnIn ? 0.4 : 0);
    if (apex.gear > apexGearTarget) tips.push(`Marcha alta no ápice (${apex.gear}ª): reduza até a ${apexGearTarget}ª durante a freada.`);
    else if (apex.gear < apexGearTarget) tips.push(`Reduziu demais (${apex.gear}ª): a ${apexGearTarget}ª basta nessa curva.`);
    else if (!readyAtTurnIn) tips.push("Termine as reduções antes de virar: troque de marcha ainda em linha reta, junto com a freada.");
  }

  const parts: ScorePart[] = options.manualGear
    ? [
        { key: "application", points: Math.round(application * 15), max: 15 },
        { key: "trail", points: Math.round(trail * 30), max: 30 },
        { key: "smoothness", points: Math.round(smoothness * 15), max: 15 },
        { key: "grip", points: Math.round(grip * 15), max: 15 },
        { key: "gear", points: Math.round(gearScore * 10), max: 10 },
        { key: "result", points: Math.round(result * 15), max: 15 },
      ]
    : [
        { key: "application", points: Math.round(application * 15), max: 15 },
        { key: "trail", points: Math.round(trail * 35), max: 35 },
        { key: "smoothness", points: Math.round(smoothness * 15), max: 15 },
        { key: "grip", points: Math.round(grip * 15), max: 15 },
        { key: "result", points: Math.round(result * 20), max: 20 },
      ];
  if (tips.length === 0) tips.push("Trail braking de piloto! Agora tente frear um pouco mais tarde.");
  return { total: parts.reduce((a, p) => a + p.points, 0), parts, tips: tips.slice(0, 3), timeS, minKmh, offTrack };
}
