import type { CornerIssue, CornerPass, CornerReference } from "./types";

const BRAKE_POINT_TOL_M = 12;
const MAX_BRAKE_STEP_M = 30;
const BRAKE_PRESSURE_TOL = 0.12;
const MIN_SPEED_TOL_KMH = 5;
const THROTTLE_TOL_M = 15;

/**
 * What the driver did differently from the reference in one corner, most
 * time-costly first. Only measurable differences are reported; channels the
 * reference doesn't have (bot pedals) are skipped.
 */
export function diagnoseCorner(attempt: CornerPass, ref: CornerReference): CornerIssue[] {
  const issues: CornerIssue[] = [];
  const base = {
    refBrakeBeforeM: ref.brakeBeforeTurnInM,
    refPeakBrakePct: Number.isFinite(ref.peakBrake) ? Math.round(ref.peakBrake * 100) : undefined,
    refMinKmh: Math.round(ref.minKmh),
    refGear: ref.gear > 0 ? ref.gear : undefined,
  };
  const slowerMid = attempt.minKmh < ref.minKmh - MIN_SPEED_TOL_KMH;

  if (attempt.brakeStartM !== null && ref.brakeStartM !== null) {
    // + → brake later. Moved in steps of at most 30 m per lap: a fast bot can
    // brake 70 m deeper, and jumping straight there is how drivers crash.
    const raw = ref.brakeStartM - attempt.brakeStartM;
    const shift = Math.max(-MAX_BRAKE_STEP_M, Math.min(MAX_BRAKE_STEP_M, raw));
    if (shift > BRAKE_POINT_TOL_M) {
      issues.push({ kind: "brake-early", brakeShiftM: shift, ...base });
    } else if (shift < -BRAKE_POINT_TOL_M && slowerMid) {
      issues.push({ kind: "brake-late", brakeShiftM: shift, ...base });
    }
  } else if (attempt.brakeStartM !== null && ref.brakeStartM === null) {
    issues.push({ kind: "brake-early", ...base });
  }

  if (slowerMid && !issues.some((i) => i.kind === "brake-late")) {
    issues.push({ kind: "min-speed-low", ...base });
  }

  if (ref.gear > 0 && attempt.gear > 0 && attempt.gear !== ref.gear) {
    issues.push({ kind: "gear", ...base });
  }

  if (Number.isFinite(ref.peakBrake) && Number.isFinite(attempt.peakBrake) && ref.brakeStartM !== null) {
    if (ref.peakBrake - attempt.peakBrake > BRAKE_PRESSURE_TOL) {
      issues.push({ kind: "brake-harder", ...base });
    } else if (attempt.peakBrake - ref.peakBrake > BRAKE_PRESSURE_TOL && slowerMid) {
      issues.push({ kind: "brake-softer", ...base });
    }
  }

  if (ref.trailBraking === true && attempt.trailBraking === false) {
    issues.push({ kind: "trail-brake", ...base });
  }

  if (ref.throttleOnM !== null && attempt.throttleOnM !== null && attempt.throttleOnM > ref.throttleOnM + THROTTLE_TOL_M) {
    issues.push({ kind: "throttle-late", ...base });
  }
  return issues;
}
