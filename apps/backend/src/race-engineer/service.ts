import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { GameId } from "@raceiq/shared/games/ids";
import type { NamedSegment } from "@raceiq/shared/racing/tracks/named-segments";
import { turnNumbers } from "@raceiq/shared/racing/tracks/segment-label";
import { subscribeLiveFrames, type LiveFrameSession } from "@raceiq/backend-core/telemetry/live-pipeline";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import type { AppSettings } from "@raceiq/backend-core/runtime/config/settings";
import { getLapMetaForProfileScope, getLapsByIds } from "@raceiq/backend-core/db/lap-read-queries";
import { resolveTrackSegments } from "@raceiq/tracks-catalogue/server";
import { getAccReader } from "../runtime/live-readers";
import { readAccGraphics, readAccTrackLength } from "./acc-graphics";
import { spokenCornerName } from "./phrases-pt-br";
import { RaceEngineerSession } from "./session";
import { resolveTrackLengthM } from "./track-length";
import { loadEngineerLaps, removeEngineerLap, saveEngineerLap } from "./lap-store";
import { SectorTracker, type SectorsPayload } from "./sectors";
import { prewarmSpeech, setEngineerVoiceId } from "./tts";
import { guideForTrack, guideForTurns } from "./track-knowledge";
import type { EngineerCallout, EngineerCorner, EngineerSample } from "./types";

/** WebSocket message the client speaks. */
export interface RaceEngineerCalloutMessage extends EngineerCallout {
  type: "race-engineer-callout";
  at: number;
}

type EngineerSettings = Pick<AppSettings, "raceEngineerEnabled" | "raceEngineerLearnFromBots"> & Partial<Pick<AppSettings, "raceEngineerOverlayScale" | "raceEngineerVoiceId">>;
let overlayScale = 1;

const SUPPORTED_GAMES: ReadonlySet<GameId> = new Set<GameId>(["acc"]);
const REFERENCE_LAPS = 10;

interface Context {
  key: string;
  session?: RaceEngineerSession;
}

let enabled = false;
let lastPrewarmKey = "";
let learnFromBots = false;
let ctx: Context | null = null;
let unsubscribe: (() => void) | null = null;

export function applyRaceEngineerSettings(settings: EngineerSettings): void {
  const wasEnabled = enabled;
  enabled = settings.raceEngineerEnabled;
  learnFromBots = settings.raceEngineerLearnFromBots;
  overlayScale = settings.raceEngineerOverlayScale ?? overlayScale;
  setEngineerVoiceId(settings.raceEngineerVoiceId);
  if (enabled !== wasEnabled) {
    ctx = null; // rebuild coach + reference from the DB on the next frame
    console.log(`[RaceEngineer] ${enabled ? "enabled" : "disabled"}`);
  }
}

export function startRaceEngineer(settings: EngineerSettings): void {
  applyRaceEngineerSettings(settings);
  unsubscribe ??= subscribeLiveFrames(onFrame);
}

export function stopRaceEngineer(): void {
  unsubscribe?.();
  unsubscribe = null;
  ctx = null;
}

function publish(callout: EngineerCallout): void {
  const message: RaceEngineerCalloutMessage = { type: "race-engineer-callout", at: Date.now(), ...callout };
  wsManager.broadcastNotification({ ...message });
  console.log(`[RaceEngineer] say (${callout.kind}): ${callout.text}`);
}

/** The overlay polls the ideal inputs; while it does, the reference is kept live even with the voice off. */
let overlayPolledAtMs = Number.NEGATIVE_INFINITY;
const OVERLAY_KEEPALIVE_MS = 15_000;

function overlayActive(nowMs = Date.now()): boolean {
  return nowMs - overlayPolledAtMs < OVERLAY_KEEPALIVE_MS;
}

export interface RaceEngineerIdealPayload {
  /** Changes whenever the track/car or the reference changes. */
  version: string;
  trackLengthM: number;
  stepM: number;
  throttle: number[];
  brake: number[];
  steer: number[];
  speed: number[];
  /** Reference targets per corner, for the overlay's "next corner" strip. */
  corners: {
    name: string;
    startM: number;
    brakeStartM: number | null;
    /** The fixed marker: metres before turn-in where braking starts. */
    brakeBeforeTurnInM: number | null;
    turnInM: number;
    gear: number;
    minKmh: number;
    /** The track guide's brake reference, spoken form ("freia na placa de 150"). */
    brakeCue: string | null;
    peakBrakePct: number | null;
    trailBraking: boolean | null;
  }[];
}

/**
 * Ideal (reference) pedal + steering inputs on a distance grid for the
 * in-game overlay. Returns `{ unchanged: true }` when `knownVersion` matches,
 * `null` while there is no live ACC session or no reference yet.
 */
/** Overlay size from settings (its position is dragged in-game and stored by the overlay). */
export function getRaceEngineerOverlayPlacement(): { scale: number } {
  return { scale: overlayScale };
}

export function getRaceEngineerIdeal(knownVersion: string | null): RaceEngineerIdealPayload | { unchanged: true; version: string } | null {
  overlayPolledAtMs = Date.now();
  const engineer = ctx?.session;
  if (!ctx || !engineer) return null;
  const reference = engineer.coach.reference;
  const version = `${ctx.key}|${reference.version}`;
  if (knownVersion === version) return { unchanged: true, version };
  const ideal = reference.idealInputs(engineer.trackLengthM);
  if (!ideal) return null;
  const round = (values: Float32Array, digits: number): number[] => Array.from(values, (v) => Number(v.toFixed(digits)));
  return {
    version,
    trackLengthM: engineer.trackLengthM,
    stepM: ideal.stepM,
    throttle: round(ideal.throttle, 3),
    brake: round(ideal.brake, 3),
    steer: round(ideal.steer, 3),
    speed: round(ideal.speed, 1),
    corners: engineer.coach.corners.flatMap((corner) => {
      const ref = reference.get(corner.key);
      if (!ref) return [];
      return [{
        name: corner.spokenName,
        startM: corner.startM,
        brakeStartM: ref.brakeStartM,
        brakeBeforeTurnInM: ref.brakeBeforeTurnInM === null ? null : Math.round(ref.brakeBeforeTurnInM),
        turnInM: ref.turnInM,
        // Track guide numbers win over the driver's own laps.
        gear: corner.guide && corner.guide.gear > 0 ? corner.guide.gear : ref.gear,
        minKmh: corner.guide?.apexKmh ?? Math.round(ref.minKmh),
        brakeCue: corner.guide ? (corner.guide.flat ? "pé embaixo" : corner.guide.brake ? `freia ${corner.guide.brake}` : "sem freio") : null,
        peakBrakePct: Number.isFinite(ref.peakBrake) ? Math.round(ref.peakBrake * 100) : null,
        trailBraking: ref.trailBraking,
      }];
    }),
  };
}

// ── Sector history ───────────────────────────────────────────────────────
let sectors: SectorTracker | null = null;

function feedSectors(packet: Readonly<TelemetryPacket>, session: LiveFrameSession, nowMs: number): void {
  const storeKey = `${session.gameId}-${session.carId}-${session.trackId}`;
  if (sectors?.key !== storeKey) sectors = new SectorTracker(storeKey);
  const acc = packet.acc;
  if (!acc || typeof acc.currentSectorIndex !== "number") return;
  sectors.feed({
    lapNumber: packet.LapNumber,
    currentLapS: packet.CurrentLap,
    lastLapS: packet.LastLap,
    sectorIndex: acc.currentSectorIndex,
    isValidLap: acc.isValidLap ?? null,
    pitStatus: String(acc.pitStatus ?? "out"),
  }, nowMs);
}

/** Recent laps with sector colours, for the overlay and the app. */
export function getRaceEngineerSectors(limit: number): SectorsPayload | null {
  overlayPolledAtMs = Date.now();
  return sectors?.view(limit) ?? null;
}

/**
 * Delete a lap from the sector history (e.g. a telemetry glitch with an
 * impossible sector). If it was one of the engineer's reference laps, it is
 * dropped from there too and the reference is rebuilt.
 */
export function deleteRaceEngineerLap(id: string): boolean {
  const removed = sectors?.remove(id);
  if (!sectors || !removed) return false;
  if (removeEngineerLap(sectors.key, removed.lapMs / 1000)) {
    console.log(`[RaceEngineer] reference lap ${(removed.lapMs / 1000).toFixed(3)} removed — rebuilding the reference`);
    ctx = null;
  }
  return true;
}

function onFrame(packet: Readonly<TelemetryPacket>, session: LiveFrameSession | null): void {
  if (!(enabled || overlayActive()) || !session || !SUPPORTED_GAMES.has(packet.gameId)) return;
  feedSectors(packet, session, Date.now());
  const key = `${session.gameId}|${session.carId}|${session.trackId}`;
  if (ctx?.key !== key) {
    const next: Context = { key };
    ctx = next;
    void buildSession(session).then((built) => {
      if (ctx === next) next.session = built ?? undefined;
    });
    return;
  }
  const engineer = ctx.session;
  if (!engineer) return;

  const graphics = getAccReader()?.getDebugBuffers()?.graphics;
  if (!graphics) return;
  const nowMs = Date.now();
  const view = readAccGraphics(graphics, engineer.wantsCars(nowMs, learnFromBots));
  const best = session.bestLapTime > 0 ? session.bestLapTime : packet.BestLap;
  const callouts = engineer.feed(packet, view, nowMs, best);
  if (enabled) for (const callout of callouts) publish(callout);
  // Refill the natural-voice cache whenever the reference or the focus may have changed.
  const lapKey = `${packet.LapNumber}|${engineer.coach.reference.version}`;
  if (enabled && lapKey !== lastPrewarmKey) {
    lastPrewarmKey = lapKey;
    const phrases = engineer.coach.plannedPhrases();
    // The page keeps the clips decoded in memory: what is on disk now, and the rest once generated.
    const announce = () => wsManager.broadcastNotification({ type: "race-engineer-preload", texts: phrases });
    announce();
    prewarmSpeech(phrases, announce);
  }
}

async function buildSession(session: LiveFrameSession): Promise<RaceEngineerSession | null> {
  try {
    const { segments, totalDist } = await resolveTrackSegments(session.trackId, session.gameId);
    const metas = (await getLapMetaForProfileScope(session.gameId, session.carId, session.trackId))
      .filter((lap) => lap.isValid && lap.lapTime > 0)
      .sort((a, b) => a.lapTime - b.lapTime)
      .slice(0, REFERENCE_LAPS);
    const laps = metas.length > 0 ? await getLapsByIds(metas.map((m) => m.id)) : [];
    const stored = laps.map((lap) => packetsToSamples(lap.telemetry)).filter((s) => s.length > 50);
    const storeKey = `${session.gameId}-${session.carId}-${session.trackId}`;
    const ownLaps = loadEngineerLaps(storeKey);

    const staticData = getAccReader()?.getDebugBuffers()?.staticData;
    const splineLength = staticData ? readAccTrackLength(staticData) : 0;
    const trackLengthM = splineLength > 0
      ? splineLength
      : resolveTrackLengthM(session.trackId, session.gameId, [...stored.map((s) => s[s.length - 1].d), totalDist]);
    const trackGuide = guideForTrack(session.trackId);
    const corners = cornersFromSegments(segments, trackLengthM).map((c) => ({ ...c, guide: guideForTurns(trackGuide, c.turns ?? []) }));
    if (corners.length === 0 || !(trackLengthM > 0)) {
      publish({ kind: "status", priority: 1, text: "Essa pista ainda não tem curvas mapeadas. Engenheiro em espera." });
      return null;
    }
    // Session laps measure distance by integration, which can be far off (partial or pit laps):
    // only those that span the whole track are trusted; the engineer's own laps always are.
    const trusted = stored.filter((s) => Math.abs(s[s.length - 1].d / trackLengthM - 1) <= 0.03).map((s) => rescale(s, trackLengthM));
    const engineer = new RaceEngineerSession(corners, trackLengthM, [...ownLaps, ...trusted], (lapTimeS, total) => {
      console.log(`[RaceEngineer] bot lap learned (${lapTimeS.toFixed(3)}s), total ${total}`);
      if (total === 1) publish({ kind: "status", priority: 1, text: "Volta do bot gravada. Vou usar como referência onde ele for mais rápido." });
    });
    engineer.coach.onReferenceLap = (samples, lapTimeS) => saveEngineerLap(storeKey, samples, lapTimeS);
    console.log(`[RaceEngineer] ${session.trackId}: ${corners.length} corners, ${engineer.coach.reference.lapCount} reference laps (${ownLaps.length} own, ${trusted.length} of ${stored.length} session laps), ${trackLengthM.toFixed(0)} m`);
    return engineer;
  } catch (error) {
    console.error("[RaceEngineer] failed to build context:", error);
    return null;
  }
}

/** Stored lap packets → engineer samples (distance from the lap's first packet). */
export function packetsToSamples(packets: readonly TelemetryPacket[]): EngineerSample[] {
  const out: EngineerSample[] = [];
  if (packets.length === 0) return out;
  const origin = packets[0].DistanceTraveled;
  for (const p of packets) {
    const d = p.DistanceTraveled - origin;
    if (!Number.isFinite(d) || (out.length > 0 && d < out[out.length - 1].d)) continue;
    out.push({ d, t: p.CurrentLap, v: p.Speed * 3.6, gear: p.Gear, brake: p.Brake / 255, throttle: p.Accel / 255, steer: p.Steer / 127 });
  }
  return out;
}

/** Stored laps measure distance by integration; stretch them to the track length used live. */
export function rescale(samples: EngineerSample[], trackLengthM: number): EngineerSample[] {
  const lapDist = samples[samples.length - 1].d;
  if (!(lapDist > 0) || Math.abs(lapDist / trackLengthM - 1) > 0.08) return samples;
  const k = trackLengthM / lapDist;
  return samples.map((s) => ({ ...s, d: s.d * k }));
}

export function cornersFromSegments(segments: readonly NamedSegment[], trackLengthM: number): EngineerCorner[] {
  const corners: EngineerCorner[] = [];
  let cornerNumber = 0;
  segments.forEach((segment, index) => {
    if (segment.type !== "corner") return;
    cornerNumber++;
    if (!(segment.endFrac > segment.startFrac)) return; // wraps the line: skip
    const turns = turnNumbers(segment);
    corners.push({
      key: `${index}`,
      spokenName: spokenCornerName(segment.name, turns, cornerNumber),
      startM: segment.startFrac * trackLengthM,
      endM: segment.endFrac * trackLengthM,
      turns: turns.length > 0 ? [...turns] : [cornerNumber],
    });
  });
  return corners;
}

