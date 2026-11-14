/**
 * Calibrates the pedal-less (bot) brake-point estimate against the player's
 * own laps, where the real brake pedal is known. Player samples are degraded
 * exactly like a bot trace (80 ms sampling, speed from position-derived
 * distance) and both brake points are compared per corner.
 *
 *   bun apps/backend/scripts/race-engineer/calibrate-bot-brake.ts <recording.bin[.gz]>
 */
import { readKunosFrames } from "@raceiq/capture-formats/kunos/dump";
import { STATIC } from "@raceiq/capture-formats/acc/structs";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { getAccTrackByName } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import { parseAccBuffers } from "@raceiq/game-acc/parser";
import { readWString } from "@raceiq/game-acc/utils";
import { resolveTrackSegments } from "@raceiq/tracks-catalogue/server";
import { initDb } from "@raceiq/backend-core/db/index";
import { initServerGameAdapters } from "../../src/games/init";
import { readAccGraphics } from "../../src/race-engineer/acc-graphics";
import { centralDifferenceSpeeds, smoothSpeeds } from "../../src/race-engineer/bot-recorder";
import { analyzeLap } from "../../src/race-engineer/corner-analysis";
import { cornersFromSegments } from "../../src/race-engineer/service";
import { resolveTrackLengthM } from "../../src/race-engineer/track-length";
import type { EngineerSample } from "../../src/race-engineer/types";

await initDb();
initGameAdapters();
initServerGameAdapters();

const frames = readKunosFrames(process.argv[2]);
const tn = frames.map((f) => readWString(f.staticData, STATIC.track.offset, STATIC.track.size)).find(Boolean) ?? "";
const trackId = String(getAccTrackByName(tn)?.id ?? tn);
const L = resolveTrackLengthM(trackId, "acc");
const corners = cornersFromSegments((await resolveTrackSegments(trackId, "acc")).segments, L);

const laps = new Map<number, EngineerSample[]>();
for (const f of frames) {
  const p = parseAccBuffers(f.physics, f.graphics, f.staticData, { carId: "", trackId });
  if (!p || p.IsRaceOn === 0) continue;
  const d = readAccGraphics(f.graphics, false).normalizedCarPosition * L;
  const lap = laps.get(p.LapNumber) ?? [];
  if (lap.length === 0 || (d > lap[lap.length - 1].d && d - lap[lap.length - 1].d < 50)) {
    lap.push({ d, t: p.CurrentLap, v: p.Speed * 3.6, gear: p.Gear, brake: p.Brake / 255, throttle: p.Accel / 255, steer: p.Steer / 127 });
  }
  laps.set(p.LapNumber, lap);
}

const errors: number[] = [];
for (const [lapNumber, samples] of laps) {
  if (samples.length < 200 || samples[0].d > 30 || samples[samples.length - 1].d < L - 80) continue;
  // Degrade like a bot: 80 ms sampling, no pedals, speed only from distance/time.
  const bot: EngineerSample[] = [];
  for (const s of samples) {
    if (bot.length === 0 || s.t - bot[bot.length - 1].t >= 0.08) bot.push({ ...s, v: 0, gear: -1, brake: Number.NaN, throttle: Number.NaN, steer: Number.NaN });
  }
  const botSamples = smoothSpeeds(centralDifferenceSpeeds(bot));
  const truth = analyzeLap(samples, corners);
  const est = analyzeLap(botSamples, corners);
  const row: string[] = [];
  for (const c of corners) {
    const a = truth.get(c.key)?.brakeStartM;
    const b = est.get(c.key)?.brakeStartM;
    if (a == null || b == null) { row.push(`${c.spokenName.slice(0, 8)}: -`); continue; }
    errors.push(b - a);
    row.push(`${c.spokenName.slice(0, 8)}: ${b - a >= 0 ? "+" : ""}${(b - a).toFixed(0)}m`);
  }
  console.log(`lap ${lapNumber}: ${row.join(" | ")}`);
}
errors.sort((x, y) => x - y);
const median = errors[Math.floor(errors.length / 2)] ?? 0;
const mean = errors.reduce((s, e) => s + e, 0) / Math.max(1, errors.length);
console.log(`estimate - truth: n=${errors.length} median ${median.toFixed(1)} m, mean ${mean.toFixed(1)} m, p10 ${errors[Math.floor(errors.length * 0.1)]?.toFixed(0)} m, p90 ${errors[Math.floor(errors.length * 0.9)]?.toFixed(0)} m`);
