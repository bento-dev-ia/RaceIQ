/**
 * Replays an ACC shared-memory recording through the voice race engineer and
 * prints every callout with lap / distance / speed, so the coaching can be
 * reviewed without driving.
 *
 *   bun apps/backend/scripts/race-engineer/replay-acc.ts <recording.bin[.gz]> [--bots]
 */
import { readKunosFrames } from "@raceiq/capture-formats/kunos/dump";
import { STATIC } from "@raceiq/capture-formats/acc/structs";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { getAccCarByModel } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAccTrackByName } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import { parseAccBuffers } from "@raceiq/game-acc/parser";
import { readWString } from "@raceiq/game-acc/utils";
import { resolveTrackSegments } from "@raceiq/tracks-catalogue/server";
import { initServerGameAdapters } from "../../src/games/init";
import { readAccGraphics, readAccTrackLength } from "../../src/race-engineer/acc-graphics";
import { cornersFromSegments } from "../../src/race-engineer/service";
import { RaceEngineerSession } from "../../src/race-engineer/session";
import { resolveTrackLengthM } from "../../src/race-engineer/track-length";
import { initDb } from "@raceiq/backend-core/db/index";

await initDb();

const path = process.argv[2];
const learnBots = process.argv.includes("--bots");
if (!path) {
  console.error("usage: replay-acc.ts <recording> [--bots]");
  process.exit(1);
}

initGameAdapters();
initServerGameAdapters();

const frames = readKunosFrames(path);
let carId = "";
let trackId = "";
for (const f of frames) {
  const cm = readWString(f.staticData, STATIC.carModel.offset, STATIC.carModel.size);
  const tn = readWString(f.staticData, STATIC.track.offset, STATIC.track.size);
  if (cm && tn) {
    carId = String(getAccCarByModel(cm)?.id ?? cm);
    trackId = String(getAccTrackByName(tn)?.id ?? tn);
    console.log(`car=${cm} (${carId}) track=${tn} (${trackId}) frames=${frames.length}`);
    break;
  }
}

const { segments } = await resolveTrackSegments(trackId, "acc");
const totalDist = frames.map((f) => readAccTrackLength(f.staticData)).find((l) => l > 0) ?? resolveTrackLengthM(trackId, "acc");
const corners = cornersFromSegments(segments, totalDist);
console.log(`track length ${totalDist.toFixed(0)} m, ${corners.length} corners: ${corners.map((c) => c.spokenName).join(" | ")}`);
if (corners.length === 0) process.exit(0);

const session = new RaceEngineerSession(corners, totalDist, [], (lapTimeS, total) => console.log(`   [bot lap #${total}: ${lapTimeS.toFixed(2)}s]`));
// Recordings are not fixed-rate: advance the clock with the game's own lap timer.
let nowMs = 0;
let lastLap = -1;
let lastLapTimer = Number.NaN;
const gaps = session.coach.speakingGaps();
console.log(`speaking gaps (m): ${gaps.map((g) => `${g.from.toFixed(0)}-${g.to.toFixed(0)} (${(g.to - g.from).toFixed(0)})`).join(", ") || "none yet"}`);
for (const f of frames) {
  const packet = parseAccBuffers(f.physics, f.graphics, f.staticData, { carId, trackId });
  if (!packet || packet.IsRaceOn === 0) continue;
  const step = packet.CurrentLap - lastLapTimer;
  // Repeated frames (same lap timer) add no time; lap resets / pauses add one frame.
  nowMs += Number.isFinite(step) && step >= 0 && step < 0.5 ? step * 1000 : 16;
  lastLapTimer = packet.CurrentLap;
  if (packet.LapNumber !== lastLap) {
    lastLap = packet.LapNumber;
    const focus = session.coach.focusKeys.map((k) => corners.find((c) => c.key === k)?.spokenName).join(", ");
    console.log(`-- lap ${packet.LapNumber} (last ${packet.LastLap.toFixed(3)}s, valid=${packet.acc?.isValidLap}) focus before lap: [${focus}]`);
    if (process.env.ENGINEER_DEBUG) console.log(session.coach.debugAttempts());
  }
  const view = readAccGraphics(f.graphics, session.wantsCars(nowMs, learnBots));
  for (const c of session.feed(packet, view, nowMs, packet.BestLap)) {
    const d = (view.normalizedCarPosition * totalDist).toFixed(0);
    console.log(`  L${packet.LapNumber} ${d.padStart(5)}m ${(packet.Speed * 3.6).toFixed(0).padStart(3)}km/h [${c.kind}] ${c.text}`);
  }
}
for (const c of corners) {
  const r = session.coach.reference.get(c.key);
  if (r) console.log(`   ref ${c.spokenName}: gear ${r.gear}, min ${r.minKmh.toFixed(0)} km/h, brake ${r.brakeBeforeTurnInM?.toFixed(0) ?? "-"} m before turn-in, peak ${(r.peakBrake * 100).toFixed(0)}%, trail ${r.trailBraking}, ${r.botOverride ? "bot" : r.source}`);
}
console.log(`speaking gaps with reference (m): ${session.coach.speakingGaps().map((g) => `${g.from.toFixed(0)}-${g.to.toFixed(0)} (${(g.to - g.from).toFixed(0)})`).join(", ")}`);
console.log(`focus: ${session.coach.focusKeys.map((k) => corners.find((c) => c.key === k)?.spokenName).join(", ") || "-"}; reference laps: ${session.coach.reference.lapCount}; bot laps: ${session.botLaps}`);
