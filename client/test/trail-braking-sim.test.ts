import { describe, expect, test } from "bun:test";
import {
  CORNERS,
  centreAt,
  idealApexGear,
  idealTrace,
  initialState,
  shift,
  linePoint,
  project,
  sampleOf,
  scoreAttempt,
  step,
  trackLength,
  type CornerSpec,
  type Inputs,
  type Sample,
} from "../src/lib/trail-braking/sim";

const DT = 1 / 120;

/** Robot driver: follows an outside–inside–outside line and a given brake plan. */
function drive(spec: CornerSpec, brakeAt: (s: number) => number, kmhAt: (s: number) => number): { samples: Sample[]; finished: boolean } {
  let car = initialState(spec);
  const samples: Sample[] = [];
  const end = trackLength(spec);
  for (let i = 0; i < 60 * 120 && car.s < end && !car.offTrack; i++) {
    // Pure pursuit toward a point on the ideal line a little ahead.
    const look = Math.max(8, car.v * 0.35);
    const target = linePoint(spec, car.s + look);
    const alpha = Math.atan2(target.x - car.x, target.y - car.y) - car.heading;
    const steer = (2 * Math.sin(alpha)) / Math.hypot(target.x - car.x, target.y - car.y) / 0.125;
    const brake = brakeAt(car.s);
    const input: Inputs = { brake, throttle: brake > 0 || car.v * 3.6 > kmhAt(car.s) + 1 ? 0 : 1, steer };
    car = step(spec, car, input, DT, { autoGear: true });
    samples.push(sampleOf(car, input));
  }
  return { samples, finished: car.s >= end && !car.offTrack };
}

describe("trail-braking trainer", () => {
  test("track projection follows the hairpin exit back down, not the entry", () => {
    const spec = CORNERS.hairpin;
    const exitPoint = centreAt(spec, spec.approach + spec.angle * spec.radius + 50);
    const p = project(spec, exitPoint.x, exitPoint.y, spec.approach + spec.angle * spec.radius + 40);
    expect(p.s).toBeCloseTo(spec.approach + spec.angle * spec.radius + 50, 0);
    expect(Math.abs(p.lateral)).toBeLessThan(0.01);
  });

  for (const id of ["hairpin", "medium", "fast"] as const) {
    test(`${id}: textbook trail-braking beats releasing the brake before turn-in`, () => {
      const spec = CORNERS[id];
      const ideal = idealTrace(spec);
      const at = (s: number) => ideal[Math.min(ideal.length - 1, Math.max(0, Math.round(s / 2)))];
      const idealBrake = (s: number) => at(s).brake;
      const idealKmh = (s: number) => at(s).kmh;
      const trail = drive(spec, idealBrake, idealKmh);
      // Same brake point, but the brake comes off completely as soon as the trail phase would begin.
      const firstBrake = ideal.find((p) => p.brake > 0.5)!.s;
      // …at whichever comes first: the ideal starting to bleed off, or the steering starting to wind on.
      const peakSteer = Math.max(...ideal.map((p) => Math.abs(p.steer)));
      const steerOnset = ideal.find((p) => p.s > firstBrake && Math.abs(p.steer) > peakSteer * 0.15)!.s;
      const releaseAt = Math.min(ideal.find((p) => p.s > firstBrake && p.brake < 0.9)!.s, steerOnset);
      const noTrail = drive(spec, (s) => (s < releaseAt ? idealBrake(s) : 0), idealKmh);

      const good = scoreAttempt(spec, trail.samples, trail.finished);
      const bad = scoreAttempt(spec, noTrail.samples, noTrail.finished);
      const part = (sc: typeof good, key: string) => sc.parts.find((p) => p.key === key)!.points;

      expect(trail.finished).toBe(true);
      expect(part(good, "trail")).toBeGreaterThan(part(bad, "trail"));
      expect(good.total).toBeGreaterThan(bad.total);
      expect(good.total).toBeGreaterThanOrEqual(60);
      expect(bad.tips.join(" ")).toMatch(/freio antes de virar|escorregou|Saiu da pista/);
    });
  }

  test("gearbox: refuses an over-revving downshift and scores the apex gear", () => {
    const spec = CORNERS.hairpin;
    // 150 km/h: 4th → 3rd is fine (~7300 rpm), 3rd → 2nd would be ~9200 rpm.
    const fast = { ...initialState(spec), v: 150 / 3.6, gear: 4 };
    const down = shift(fast, -1);
    expect(down.ok).toBe(true);
    const tooLow = shift({ ...fast, gear: 3 }, -1);
    expect(tooLow).toEqual({ ok: false, reason: "overrev" });

    const ideal = idealTrace(spec);
    const at = (s: number) => ideal[Math.min(ideal.length - 1, Math.max(0, Math.round(s / 2)))];
    const run = drive(spec, (s) => at(s).brake, (s) => at(s).kmh);
    const target = idealApexGear(spec);
    const right = scoreAttempt(spec, run.samples.map((s) => ({ ...s, gear: s.s > spec.approach - 30 ? target : s.gear })), run.finished, { manualGear: true });
    const wrong = scoreAttempt(spec, run.samples.map((s) => ({ ...s, gear: 5 })), run.finished, { manualGear: true });
    const gearPts = (sc: typeof right) => sc.parts.find((p) => p.key === "gear")!.points;
    expect(gearPts(right)).toBe(10);
    expect(gearPts(wrong)).toBeLessThan(5);
    expect(wrong.tips.join(" ")).toMatch(/Marcha alta no ápice/);
  });

  test("load transfer: braking adds front grip, coasting and throttle take it away", async () => {
    const { frontGripFactor } = await import("../src/lib/trail-braking/sim");
    expect(frontGripFactor(0.5, 0)).toBeGreaterThan(frontGripFactor(0, 0));
    expect(frontGripFactor(0, 1)).toBeLessThan(frontGripFactor(0, 0));
  });
});
