import { describe, expect, test } from "bun:test";
import { BotLapRecorder, TrackLine } from "../../src/race-engineer/bot-recorder";
import type { EngineerSample } from "../../src/race-engineer/types";

const R = 400;
const L = 2 * Math.PI * R;
const pos = (d: number) => ({ x: R * Math.cos(d / R), z: R * Math.sin(d / R) });

describe("race engineer bot recorder", () => {
  test("learns a bot lap from positions only on a circular track", () => {
    const line = new TrackLine(L);
    // Player lap 1 (building) then lap 2 starts → line finalized.
    for (let d = 0; d < L; d += 1) line.observePlayer(1, d, pos(d).x, pos(d).z);
    line.observePlayer(2, 0.5, pos(0.5).x, pos(0.5).z);
    expect(line.ready).toBe(true);

    const laps: { samples: EngineerSample[]; lapTimeS: number }[] = [];
    const recorder = new BotLapRecorder(line, (samples, lapTimeS) => laps.push({ samples, lapTimeS }));
    const speed = 50; // m/s = 180 km/h
    let botD = L - 200; // start just before the line so the first crossing opens a lap
    for (let ms = 0; ms < 3 * (L / speed) * 1000; ms += 80) {
      botD = (L - 200 + (speed * ms) / 1000) % L;
      recorder.observe([{ id: 7, ...pos(botD) }], ms);
    }
    expect(laps.length).toBeGreaterThanOrEqual(1);
    expect(laps[0].lapTimeS).toBeCloseTo(L / speed, 0);
    const mid = laps[0].samples[Math.floor(laps[0].samples.length / 2)];
    expect(mid.v).toBeGreaterThan(170);
    expect(mid.v).toBeLessThan(190);
    expect(Number.isNaN(mid.brake)).toBe(true);
  });
});
