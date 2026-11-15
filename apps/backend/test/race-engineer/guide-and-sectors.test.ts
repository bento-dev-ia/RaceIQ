import { describe, expect, test } from "bun:test";
import { guidedPreCornerVariants, guidePhrase, preCornerPhrase, spokenCornerName } from "../../src/race-engineer/phrases-pt-br";
import { SectorTracker, type SectorFrame, type SectorLap } from "../../src/race-engineer/sectors";
import { guideForTrack, guideForTurns } from "../../src/race-engineer/track-knowledge";
import type { CornerReference } from "../../src/race-engineer/types";

describe("corner names on the radio", () => {
  test("numbers only, except the famous corners (short form)", () => {
    expect(spokenCornerName("Variante della Roggia", [4], 4)).toBe("Curva 4");
    expect(spokenCornerName("Variante del Rettifilo", [1, 2], 1)).toBe("Curva 1 e 2");
    expect(spokenCornerName("Curva Grande", [3], 3)).toBe("Curva 3");
    expect(spokenCornerName("Lesmo 2", [7], 7)).toBe("Lesmo 2");
    expect(spokenCornerName("Variante Ascari", [8], 8)).toBe("Ascari");
    expect(spokenCornerName("Curva Parabolica Alboreto", [11], 11)).toBe("Parabólica");
    expect(spokenCornerName("Eau Rouge", [3], 3)).toBe("Eau Rouge");
    expect(spokenCornerName("Bus Stop", [18], 18)).toBe("Bus Stop");
  });
});

describe("track guide numbers", () => {
  const monza = guideForTrack("0");
  const t4 = guideForTurns(monza, [4])!;

  test("Monza uses the Audi R8 numbers from the Track Titan video", () => {
    expect(monza?.car).toContain("Audi R8");
    expect(t4).toMatchObject({ gear: 2, apexKmh: 83, brake: "na placa de 150" });
    expect(guideForTurns(monza, [11])).toMatchObject({ gear: 3, apexKmh: 127, brake: "na placa de 100" });
    expect(guideForTurns(guideForTrack("spa"), [18])).toMatchObject({ gear: 1, apexKmh: 63 });
  });

  test("briefing is gear, apex speed and the board", () => {
    expect(guidePhrase("Curva 4", t4, false)).toBe("Curva 4, segunda, 83, freia na placa de 150.");
    expect(guidePhrase("Curva 3", guideForTurns(monza, [3])!, false)).toBe("Curva 3, pé embaixo.");
  });

  test("a coaching tip is anchored on the guide, brake errors against the board", () => {
    const ref = { gear: 3, minKmh: 70, brakeBeforeTurnInM: 130 } as CornerReference;
    expect(preCornerPhrase("Curva 4", ref, { kind: "brake-late", brakeShiftM: -20 }, t4))
      .toBe("Curva 4, segunda, 83, freia na placa de 150. Freia mais cedo, na referência.");
    expect(preCornerPhrase("Curva 4", ref, { kind: "min-speed-low", refMinKmh: 70 }, t4))
      .toBe("Curva 4, segunda, 83, freia na placa de 150. Leva mais velocidade, 83 no ápice.");
    expect(new Set(guidedPreCornerVariants("Curva 4", t4)).size).toBeGreaterThan(8);
  });
});

describe("sector history", () => {
  /** Drive a full lap of three sectors through the tracker. */
  function drive(tracker: SectorTracker, lapNumber: number, sectorsS: number[], start: number, opts: { valid?: boolean } = {}): number {
    let now = start;
    const total = sectorsS.reduce((a, b) => a + b, 0);
    const frame = (clock: number, sector: number): SectorFrame => ({ lapNumber, currentLapS: clock, lastLapS: 0, sectorIndex: sector, isValidLap: opts.valid ?? true, pitStatus: "out" });
    let clock = 0;
    for (let s = 0; s < sectorsS.length; s++) {
      for (let k = 0; k < 5; k++) {
        tracker.feed(frame(clock, s), now);
        clock += sectorsS[s] / 5;
        now += (sectorsS[s] / 5) * 1000;
      }
    }
    // Cross the line: lap counter ticks, clock resets, the game publishes the lap time.
    tracker.feed({ lapNumber: lapNumber + 1, currentLapS: 0.02, lastLapS: 0, sectorIndex: 0, isValidLap: true, pitStatus: "out" }, now);
    tracker.feed({ lapNumber: lapNumber + 1, currentLapS: 0.05, lastLapS: total, sectorIndex: 0, isValidLap: true, pitStatus: "out" }, now + 30);
    return now + 60;
  }

  function start(tracker: SectorTracker, lapNumber: number, now: number): void {
    tracker.feed({ lapNumber, currentLapS: 0.01, lastLapS: 0, sectorIndex: 0, isValidLap: true, pitStatus: "out" }, now);
  }

  test("purple / green / yellow per sector, at the time it was set", () => {
    const t = new SectorTracker("test", "s1", []);
    let now = 1000;
    start(t, 0, now);
    now = drive(t, 0, [35, 37, 35], now);
    now = drive(t, 1, [34.5, 37.5, 35.2], now);
    now = drive(t, 2, [34.8, 36.9, 35.5], now);
    const v = t.view(10);
    expect(v.laps).toHaveLength(3);
    const [third, second, first] = v.laps;
    expect(first.colors).toEqual(["purple", "purple", "purple"]);
    expect(second.colors).toEqual(["purple", "yellow", "yellow"]);
    expect(third.colors).toEqual(["yellow", "purple", "yellow"]);
    expect(first.sectorsMs).toEqual([35000, 37000, 35000]);
    expect(first.lapMs).toBe(107000);
  });

  test("an impossible sector is flagged and never blocks purple; deleting recolours", () => {
    const glitch: SectorLap = { id: "glitch-1", lapNumber: 1, at: 1, session: "old", lapMs: 60000, sectorsMs: [9000, 30000, 21000], valid: true, suspect: false };
    const t = new SectorTracker("test", "s2", [glitch]);
    let now = 1000;
    start(t, 4, now);
    now = drive(t, 4, [35, 37, 35], now);
    // The stored glitch (not flagged when it was saved) holds every all-time best: session best only…
    expect(t.view(5).laps[0].colors).toEqual(["green", "green", "green"]);
    // …until it is deleted by hand.
    expect(t.remove("glitch-1")?.id).toBe("glitch-1");
    expect(t.view(5).laps[0].colors).toEqual(["purple", "purple", "purple"]);
    // A new glitch is caught automatically.
    now = drive(t, 5, [9, 37, 35], now);
    expect(t.view(5).laps[0].suspect).toBe(true);
    now = drive(t, 6, [34.9, 37, 35], now);
    expect(t.view(5).laps[0].colors[0]).toBe("purple");
  });

  test("invalid laps are grey and do not count", () => {
    const t = new SectorTracker("test", "s3", []);
    let now = 1000;
    start(t, 0, now);
    now = drive(t, 0, [33, 36, 34], now, { valid: false });
    now = drive(t, 1, [35, 37, 35], now);
    const [valid, invalid] = t.view(5).laps;
    expect(invalid.colors).toEqual(["invalid", "invalid", "invalid"]);
    expect(valid.colors).toEqual(["purple", "purple", "purple"]);
  });
});
