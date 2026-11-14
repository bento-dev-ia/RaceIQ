import type { CornerPass, EngineerCorner, EngineerSample, TimeTrace } from "./types";

/** How far before the segment start braking may begin (segments usually contain it). */
export const BRAKE_LOOKBACK_M = 60;
const BRAKE_ON = 0.08;
const BRAKE_ONSET = 0.05;
const TRAIL_MIN_M = 10;
const THROTTLE_ON = 0.5;
const STEER_TURN_IN = 0.08;
const TRACE_STEP_M = 5;

/** Linear interpolation of lap time at distance `d` (samples sorted by d). */
export function timeAt(samples: readonly EngineerSample[], d: number): number | null {
  if (samples.length < 2) return null;
  if (d < samples[0].d || d > samples[samples.length - 1].d) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].d <= d) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.d - a.d;
  if (span <= 0) return a.t;
  return a.t + ((d - a.d) / span) * (b.t - a.t);
}

/** Elapsed time from segment start at `relD` metres into the segment. */
export function traceTimeAt(trace: TimeTrace, relD: number): number | null {
  const { d, t } = trace;
  if (d.length < 2 || relD < d[0] || relD > d[d.length - 1]) return null;
  let i = 1;
  while (i < d.length - 1 && d[i] < relD) i++;
  const span = d[i] - d[i - 1];
  return span <= 0 ? t[i] : t[i - 1] + ((relD - d[i - 1]) / span) * (t[i] - t[i - 1]);
}

function sliceByDistance(samples: readonly EngineerSample[], from: number, to: number): EngineerSample[] {
  const out: EngineerSample[] = [];
  for (const s of samples) {
    if (s.d < from) continue;
    if (s.d > to) break;
    out.push(s);
  }
  return out;
}

/**
 * Per-corner metrics for one pass through a segment, analysed up to `untilM`
 * (defaults to the segment end). Returns null when the samples don't cover it.
 */
export function analyzeCornerPass(
  samples: readonly EngineerSample[],
  corner: EngineerCorner,
  untilM: number = corner.endM,
): CornerPass | null {
  const end = Math.min(untilM, corner.endM);
  if (end <= corner.startM || samples.length < 2) return null;
  // A segment starting on the line: the first live sample lands a few metres in.
  if (corner.startM < samples[0].d && samples[0].d - corner.startM <= 15) {
    corner = { ...corner, startM: samples[0].d };
  }
  const tStart = timeAt(samples, corner.startM);
  const tEnd = timeAt(samples, end);
  if (tStart === null || tEnd === null || tEnd <= tStart) return null;

  const seg = sliceByDistance(samples, corner.startM, end);
  if (seg.length < 4) return null;
  const window = sliceByDistance(samples, Math.max(0, corner.startM - BRAKE_LOOKBACK_M), end);

  // Apex = slowest point of the segment.
  let apex = seg[0];
  for (const s of seg) if (s.v < apex.v) apex = s;
  const apexM = apex.d;

  // Braking: strongest brake before the apex, walked back to its onset.
  const brakeKnown = window.some((s) => Number.isFinite(s.brake));
  let peakBrake = brakeKnown ? 0 : Number.NaN;
  let peakIdx = -1;
  if (brakeKnown) {
    for (let i = 0; i < window.length && window[i].d <= apexM; i++) {
      if (window[i].brake > peakBrake) { peakBrake = window[i].brake; peakIdx = i; }
    }
  }
  let brakeStartM: number | null = null;
  let releaseM: number | null = null;
  if (brakeKnown && peakIdx >= 0 && peakBrake >= BRAKE_ON) {
    let onset = peakIdx;
    while (onset > 0 && window[onset - 1].brake >= BRAKE_ONSET) onset--;
    brakeStartM = window[onset].d;
    let release = peakIdx;
    while (release < window.length - 1 && window[release + 1].brake >= BRAKE_ON) release++;
    releaseM = window[release].d;
  } else if (!brakeKnown) {
    brakeStartM = speedDropOnset(window, apexM);
  }

  // Turn-in: steering reaches 40% of its peak before the apex. A relative
  // threshold copes with curved approaches where the wheel is never straight.
  const steerKnown = window.some((s) => Number.isFinite(s.steer));
  let turnInM = Math.max(brakeStartM ?? corner.startM, apexM - 40);
  if (steerKnown) {
    const from = brakeStartM ?? corner.startM;
    let peakSteer = 0;
    for (const s of window) if (s.d >= from && s.d <= apexM) peakSteer = Math.max(peakSteer, Math.abs(s.steer));
    const threshold = Math.max(STEER_TURN_IN, peakSteer * 0.4);
    const hit = window.find((s) => s.d >= from && s.d <= apexM && Math.abs(s.steer) >= threshold);
    if (hit) turnInM = hit.d;
  }

  // Steering used through the corner (turn-in → just past the apex).
  let cornerSteer = steerKnown ? 0 : Number.NaN;
  if (steerKnown) for (const s of window) if (s.d >= turnInM && s.d <= apexM + 30) cornerSteer = Math.max(cornerSteer, Math.abs(s.steer));

  const entry = window.find((s) => s.d >= turnInM) ?? apex;
  // Gear at the apex; momentary downshifts while braking don't count.
  let gear = apex.gear > 0 ? apex.gear : -1;
  if (gear < 0) {
    for (const s of window) {
      if (s.d < turnInM || s.d > apexM + 30) continue;
      if (s.gear > 0 && (gear < 0 || s.gear < gear)) gear = s.gear;
    }
  }

  let throttleOnM: number | null = null;
  if (seg.some((s) => Number.isFinite(s.throttle))) {
    const hit = seg.find((s) => s.d >= apexM && s.throttle > THROTTLE_ON);
    if (hit) throttleOnM = hit.d;
  }

  const trace: TimeTrace = { d: [0], t: [0] };
  for (const s of seg) {
    const rel = s.d - corner.startM;
    if (rel - trace.d[trace.d.length - 1] >= TRACE_STEP_M) {
      trace.d.push(rel);
      trace.t.push(s.t - tStart);
    }
  }
  trace.d.push(end - corner.startM);
  trace.t.push(tEnd - tStart);

  return {
    key: corner.key,
    brakeStartM,
    turnInM,
    apexM,
    brakeBeforeTurnInM: brakeStartM === null ? null : Math.max(0, turnInM - brakeStartM),
    peakBrake,
    peakSteer: cornerSteer,
    trailBraking: brakeKnown ? releaseM !== null && releaseM - turnInM >= TRAIL_MIN_M : null,
    entryKmh: entry.v,
    minKmh: apex.v,
    exitKmh: seg[seg.length - 1].v,
    gear,
    throttleOnM,
    segTime: tEnd - tStart,
    trace,
  };
}

/** Deceleration that only braking produces (≈0.7 g); lifting/coasting is far gentler. */
const BRAKING_DECEL_KMH_PER_S = 25;

/**
 * Brake-point estimate when pedals are unknown (bot traces): walk back from
 * the apex while the car is decelerating at braking rates. Returns null when
 * the corner is taken without real braking (≥10 km/h lost under braking).
 */
function speedDropOnset(window: readonly EngineerSample[], apexD: number): number | null {
  let apexIdx = -1;
  for (let i = 0; i < window.length && window[i].d <= apexD; i++) apexIdx = i;
  if (apexIdx < 1) return null;
  const decel = (i: number) => {
    const dt = window[i].t - window[i - 1].t;
    return dt > 0 ? (window[i - 1].v - window[i].v) / dt : 0;
  };
  // Find the strongest-braking sample before the apex, then extend back to onset.
  let peakIdx = -1;
  for (let i = apexIdx; i >= 1; i--) {
    if (decel(i) >= BRAKING_DECEL_KMH_PER_S) { peakIdx = i; break; }
  }
  if (peakIdx < 0) return null;
  let onset = peakIdx;
  while (onset > 1 && decel(onset - 1) >= BRAKING_DECEL_KMH_PER_S * 0.6) onset--;
  const lost = window[onset - 1].v - window[apexIdx].v;
  return lost >= 10 ? window[onset - 1].d : null;
}

/** Analyze every corner in one lap. Corners not covered are omitted. */
export function analyzeLap(samples: readonly EngineerSample[], corners: readonly EngineerCorner[]): Map<string, CornerPass> {
  const out = new Map<string, CornerPass>();
  for (const corner of corners) {
    const pass = analyzeCornerPass(samples, corner);
    if (pass) out.set(corner.key, pass);
  }
  return out;
}

/**
 * Where the corner is "done" for a post-corner verdict: shortly after the
 * reference picks the throttle back up, so the driver hears it on the exit.
 */
export function exitPointM(corner: EngineerCorner, ref: CornerPass | undefined): number {
  const anchor = ref?.throttleOnM ?? (ref ? ref.apexM + 40 : corner.startM + (corner.endM - corner.startM) * 0.6);
  return Math.min(corner.endM, anchor + 60);
}
