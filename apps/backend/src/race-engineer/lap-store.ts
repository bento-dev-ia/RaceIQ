import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USER_DATA_DIR } from "@raceiq/backend-core/runtime/config/paths";
import type { EngineerSample } from "./types";

/**
 * The engineer's own reference laps, one file per game/car/track. Distances
 * are the live track position (normalizedCarPosition × length), which the
 * stored session laps don't provide reliably (their integrated distance can
 * be off by kilometres), so these are what survive a restart.
 */
const DIR = join(USER_DATA_DIR, "race-engineer");
const KEEP = 5;
const STEP_M = 2;

interface StoredLap {
  lapTimeS: number;
  /** Columns: d, t, v, gear, brake, throttle, steer — rounded, every ~2 m. */
  rows: number[][];
}

function fileFor(key: string): string {
  return join(DIR, `${key.replace(/[^a-z0-9_.-]+/gi, "_")}.json`);
}

export function loadEngineerLaps(key: string): EngineerSample[][] {
  try {
    const laps = JSON.parse(readFileSync(fileFor(key), "utf8")) as StoredLap[];
    return laps.map((lap) => lap.rows.map(([d, t, v, gear, brake, throttle, steer]) => ({ d, t, v, gear, brake, throttle, steer })));
  } catch {
    return [];
  }
}

/** Drop the stored reference lap with this lap time (± 5 ms). Returns whether one was removed. */
export function removeEngineerLap(key: string, lapTimeS: number): boolean {
  try {
    const laps = JSON.parse(readFileSync(fileFor(key), "utf8")) as StoredLap[];
    const kept = laps.filter((lap) => Math.abs(lap.lapTimeS - lapTimeS) > 0.005);
    if (kept.length === laps.length) return false;
    const file = fileFor(key);
    writeFileSync(`${file}.tmp`, JSON.stringify(kept));
    renameSync(`${file}.tmp`, file);
    return true;
  } catch {
    return false;
  }
}

/** Keep the fastest KEEP laps for this key. */
export function saveEngineerLap(key: string, samples: readonly EngineerSample[], lapTimeS: number): void {
  if (!(lapTimeS > 0) || samples.length < 50) return;
  try {
    let laps: StoredLap[] = [];
    try {
      laps = JSON.parse(readFileSync(fileFor(key), "utf8")) as StoredLap[];
    } catch {
      /* first lap for this combo */
    }
    const rows: number[][] = [];
    let lastD = Number.NEGATIVE_INFINITY;
    for (const s of samples) {
      if (s.d - lastD < STEP_M) continue;
      lastD = s.d;
      rows.push([Math.round(s.d * 10) / 10, Math.round(s.t * 1000) / 1000, Math.round(s.v * 10) / 10, s.gear, Math.round(s.brake * 1000) / 1000, Math.round(s.throttle * 1000) / 1000, Math.round(s.steer * 1000) / 1000]);
    }
    laps.push({ lapTimeS, rows });
    laps.sort((a, b) => a.lapTimeS - b.lapTimeS);
    mkdirSync(DIR, { recursive: true });
    const file = fileFor(key);
    writeFileSync(`${file}.tmp`, JSON.stringify(laps.slice(0, KEEP)));
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    console.warn("[RaceEngineer] could not save reference lap:", error instanceof Error ? error.message : error);
  }
}
