import { describe, expect, test } from "bun:test";
import { analyzeLap } from "../../src/race-engineer/corner-analysis";
import { RaceEngineerCoach, type CoachFrame } from "../../src/race-engineer/coach";
import { diagnoseCorner } from "../../src/race-engineer/diagnosis";
import { formatDelta, formatLapTime, postCornerPhrase, preCornerPhrase, spokenCornerName } from "../../src/race-engineer/phrases-pt-br";
import { CornerReferenceSet } from "../../src/race-engineer/reference";
import type { EngineerCorner, EngineerSample } from "../../src/race-engineer/types";

const TRACK = 3000;
/** Contiguous segments like RaceIQ's: each corner segment holds its braking zone and exit. */
const CORNERS: EngineerCorner[] = [
  { key: "t1", spokenName: "Curva 1", startM: 500, endM: 1100 },
  { key: "t2", spokenName: "Curva 2", startM: 1300, endM: 1900 },
  { key: "t3", spokenName: "La Source", startM: 2100, endM: 2700 },
];
/** Turn-in point of each corner. */
const TURN_IN: Record<string, number> = { t1: 800, t2: 1600, t3: 2400 };

interface CornerStyle { brakeBefore: number; minKmh: number; peak: number; trail: number; gear: number; throttleAfterApex: number }
const GOOD: CornerStyle = { brakeBefore: 100, minKmh: 110, peak: 0.9, trail: 30, gear: 3, throttleAfterApex: 10 };

/** Synthetic lap: 240 km/h straights, linear braking to minKmh at apex (turn-in + 50), linear exit. */
function makeLap(styles: Partial<Record<string, Partial<CornerStyle>>> = {}): EngineerSample[] {
  const samples: EngineerSample[] = [];
  let t = 0;
  for (let d = 0; d <= TRACK; d += 5) {
    let v = 240;
    let brake = 0;
    let throttle = 1;
    let gear = 6;
    let steer = 0;
    for (const c of CORNERS) {
      const s = { ...GOOD, ...styles[c.key] };
      const turnIn = TURN_IN[c.key];
      const apex = turnIn + 50;
      const brakeAt = turnIn - s.brakeBefore;
      if (d >= turnIn && d <= turnIn + 100) steer = 0.3;
      if (d >= brakeAt && d <= apex) {
        v = 240 - ((d - brakeAt) / (apex - brakeAt)) * (240 - s.minKmh);
        brake = d <= turnIn + s.trail ? s.peak : 0;
        throttle = 0;
        gear = d >= turnIn ? s.gear : 5;
      } else if (d > apex && d <= apex + 300) {
        v = s.minKmh + ((d - apex) / 300) * (240 - s.minKmh);
        throttle = d >= apex + s.throttleAfterApex ? 1 : 0.2;
        gear = d <= apex + 30 ? s.gear : 5;
      }
    }
    if (samples.length > 0) t += 5 / (((samples[samples.length - 1].v + v) / 2) / 3.6);
    samples.push({ d, t, v, gear, brake, throttle, steer });
  }
  return samples;
}

const asBot = (lap: EngineerSample[]) => lap.map((s) => ({ ...s, brake: Number.NaN, throttle: Number.NaN, steer: Number.NaN, gear: -1 }));

describe("race engineer corner analysis", () => {
  test("measures brake point to turn-in, trail braking, gear and min speed", () => {
    const pass = analyzeLap(makeLap(), CORNERS).get("t1")!;
    expect(pass.turnInM).toBe(800);
    expect(pass.brakeBeforeTurnInM).toBe(100);
    expect(pass.trailBraking).toBe(true);
    expect(pass.gear).toBe(3);
    expect(Math.round(pass.minKmh)).toBe(110);
    expect(Math.round(pass.peakBrake * 100)).toBe(90);
    expect(pass.throttleOnM).toBe(860);
  });

  test("bot traces without pedals estimate the brake point from speed", () => {
    const pass = analyzeLap(asBot(makeLap()), CORNERS).get("t2")!;
    expect(pass.brakeStartM).toBe(1500);
    expect(pass.trailBraking).toBeNull();
  });
});

describe("race engineer diagnosis", () => {
  test("flags early braking (with the shift in metres) and missing trail braking", () => {
    const ref = new CornerReferenceSet(CORNERS);
    ref.addDriverLap(makeLap());
    const attempt = analyzeLap(makeLap({ t1: { brakeBefore: 160, trail: 0 } }), CORNERS).get("t1")!;
    const issues = diagnoseCorner(attempt, ref.get("t1")!);
    // 60 m early, coached in a capped 30 m step.
    expect(issues[0]).toMatchObject({ kind: "brake-early", brakeShiftM: 30 });
    expect(issues.map((i) => i.kind)).toContain("trail-brake");
  });

  test("best segment per corner comes from different laps", () => {
    const ref = new CornerReferenceSet(CORNERS);
    ref.addDriverLap(makeLap({ t1: { minKmh: 90 } }));
    ref.addDriverLap(makeLap({ t2: { minKmh: 90 } }));
    expect(Math.round(ref.get("t1")!.minKmh)).toBe(110);
    expect(Math.round(ref.get("t2")!.minKmh)).toBe(110);
  });

  test("a faster bot overrides speeds and brake point but keeps driver gear and turn-in", () => {
    const ref = new CornerReferenceSet(CORNERS);
    ref.addDriverLap(makeLap());
    ref.addBotLap(asBot(makeLap({ t1: { minKmh: 125, brakeBefore: 80 } })));
    const t1 = ref.get("t1")!;
    expect(t1.botOverride).toBe(true);
    expect(t1.brakeBeforeTurnInM).toBe(80);
    expect(t1.gear).toBe(3);
  });
});

describe("race engineer phrases", () => {
  test("pt-BR formatting", () => {
    expect(formatDelta(0.23)).toBe("2 décimos");
    expect(formatDelta(0.08)).toBe("1 décimo");
    expect(formatDelta(1.34)).toBe("1,3 segundos");
    expect(formatLapTime(108.34)).toBe("1 minuto, 48 e 3");
    expect(spokenCornerName("", [5], 5)).toBe("Curva 5");
    expect(spokenCornerName("T10-11", [10, 11], 9)).toBe("Curva 10 e 11");
    expect(spokenCornerName("Eau Rouge", [3], 3)).toBe("Eau Rouge");
  });

  test("flags too much / too little steering only when it cost speed", () => {
    const set = new CornerReferenceSet(CORNERS);
    set.addDriverLap(makeLap());
    const ref = set.get("t3")!;
    expect(ref.peakSteer).toBeGreaterThan(0.05);
    const slow = { ...ref, minKmh: ref.minKmh - 12 };
    expect(diagnoseCorner({ ...slow, peakSteer: ref.peakSteer * 1.5 }, ref).map((i) => i.kind)).toContain("steer-too-much");
    expect(diagnoseCorner({ ...slow, peakSteer: ref.peakSteer * 0.5 }, ref).map((i) => i.kind)).toContain("steer-too-little");
    expect(diagnoseCorner({ ...ref, peakSteer: ref.peakSteer * 1.5 }, ref).map((i) => i.kind)).not.toContain("steer-too-much");
  });

  test("pre-corner phrase anchors gear + brake marker and gives one tip", () => {
    const ref = new CornerReferenceSet(CORNERS);
    ref.addDriverLap(makeLap());
    expect(preCornerPhrase("La Source", ref.get("t3")!, { kind: "trail-brake" }))
      .toBe("La Source, terceira, freia nos 100 metros. Solta o freio devagar até o ápice.");
    expect(preCornerPhrase("La Source", ref.get("t3")!, { kind: "brake-early", brakeShiftM: 22 }))
      .toBe("La Source, terceira, freia nos 100 metros. 20 metros mais tarde.");
    expect(preCornerPhrase("La Source", ref.get("t3")!, { kind: "turn-in-early", turnInShiftM: 18 }))
      .toBe("La Source, terceira, freia nos 100 metros. Espera, vira uns 20 metros mais tarde.");
    expect(postCornerPhrase(0.34, { kind: "brake-early" }, { kind: "turn-in-late" })).toBe("Perdeu 3 décimos, freou cedo e virou tarde.");
  });
});

function frames(lap: EngineerSample[], lapNumber: number, startMs: number, lastLapS: number): CoachFrame[] {
  return lap.map((s) => ({ ...s, lapNumber, lapValid: true, lastLapS, bestLapS: 0, nowMs: startMs + s.t * 1000 }));
}

describe("race engineer coach", () => {
  test("coaches the costliest corner, never inside a silence zone", () => {
    const coach = new RaceEngineerCoach(CORNERS, TRACK);
    const said: { d: number; kind: string; text: string }[] = [];
    let clock = 0;
    const slowT2 = { t2: { brakeBefore: 170, trail: 0 } };
    const laps = [makeLap(), makeLap(slowT2), makeLap(slowT2), makeLap()];
    let last = 0;
    laps.forEach((lap, i) => {
      for (const f of frames(lap, i + 1, clock, last)) {
        for (const c of coach.feed(f)) said.push({ d: f.d, kind: c.kind, text: c.text });
      }
      last = lap[lap.length - 1].t;
      clock += last * 1000;
    });

    expect(said[0].text).toContain("sem referência");
    expect(said.some((s) => s.text.startsWith("Referência pronta"))).toBe(true);
    const post = said.find((s) => s.kind === "post-corner");
    // Up to two causes, costliest first.
    expect(post?.text).toMatch(/^Perdeu [^,]+, freou cedo( e [^.]+)?\.$/);
    const pre = said.find((s) => s.kind === "pre-corner" && s.text.includes("mais tarde"));
    expect(pre?.text).toContain("Curva 2");
    expect(pre?.text).toContain("30 metros mais tarde");
    // Before any focus exists, the corners are briefed with gear, speed and brake point.
    const briefing = said.find((s) => s.kind === "pre-corner" && !s.text.includes("mais tarde"));
    expect(briefing?.text).toMatch(/^.+, (primeira|segunda|terceira|quarta|quinta|sexta), \d+(, freia nos \d+ metros)?\.$/);
    expect(said.some((s) => s.kind === "lap-summary")).toBe(true);
    // Never between (reference brake point - 150 m) and the reference throttle pick-up.
    for (const s of said) {
      for (const c of CORNERS) {
        const brake = TURN_IN[c.key] - 100;
        const throttle = TURN_IN[c.key] + 60;
        expect(s.d > brake - 150 && s.d < throttle).toBe(false);
      }
    }
  });
});
