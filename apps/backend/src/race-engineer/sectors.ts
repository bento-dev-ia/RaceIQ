import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USER_DATA_DIR } from "@raceiq/backend-core/runtime/config/paths";

/**
 * Sector history per game/car/track, persisted, with timing-screen colours:
 *  - purple: best ever for that sector (all sessions),
 *  - green: best of the session the lap was driven in,
 *  - yellow: slower than that.
 * Colours are "at the time the sector was set" and are replayed from the
 * stored laps, so deleting a bogus lap recolours everything after it.
 *
 * Sector times are measured here from the lap clock at each sector change
 * (S1 = clock at the first change, S2 = second − first, S3 = lap − second),
 * so they always add up to the lap. A sector far quicker than the driver's
 * usual (or under 8 s) is a telemetry glitch: the lap is kept but flagged
 * "suspect" and never counts as a best; it can also be deleted by hand.
 */

export type SectorColor = "purple" | "green" | "yellow" | "invalid" | "suspect";

export interface SectorLap {
  id: string;
  lapNumber: number;
  /** Epoch ms when the lap was completed. */
  at: number;
  /** Server-run session the lap belongs to. */
  session: string;
  lapMs: number;
  sectorsMs: number[];
  /** Game validity (track limits) and not an in/out lap. */
  valid: boolean;
  /** Auto-flagged as a telemetry glitch (impossible sector). */
  suspect: boolean;
}

export interface SectorLapView extends SectorLap {
  colors: SectorColor[];
  lapColor: SectorColor;
  thisSession: boolean;
}

export interface SectorsPayload {
  key: string;
  session: string;
  laps: SectorLapView[];
  current: { lapNumber: number; sectorsMs: (number | null)[]; colors: (SectorColor | null)[]; valid: boolean } | null;
  best: { all: (number | null)[]; session: (number | null)[]; lapAll: number | null; lapSession: number | null };
}

/** Subset of the live packet the tracker needs. */
export interface SectorFrame {
  lapNumber: number;
  /** Current lap clock, seconds. */
  currentLapS: number;
  /** Last completed lap, seconds (0 = none). */
  lastLapS: number;
  sectorIndex: number;
  isValidLap: boolean | null;
  /** "out" on track; anything else = pit lane / box. */
  pitStatus: string;
}

const DIR = join(USER_DATA_DIR, "race-engineer", "sectors");
const KEEP = 300;
const MIN_SECTOR_MS = 8000;
/** A sector this much quicker than the driver's median for it is a glitch. */
const SUSPECT_RATIO = 0.75;
/** …or this much shorter than the longest sector of the same lap. */
const IN_LAP_RATIO = 0.35;
/** How long to wait for the game to publish the official lap time after the line. */
const LAP_TIME_WAIT_MS = 3000;

function fileFor(key: string): string {
  return join(DIR, `${key.replace(/[^a-z0-9_.-]+/gi, "_")}.json`);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface PendingLap {
  lap: Omit<SectorLap, "lapMs" | "sectorsMs" | "suspect">;
  splitsMs: number[];
  provisionalMs: number;
  lastLapBeforeMs: number;
  deadline: number;
}

export class SectorTracker {
  readonly key: string;
  readonly session: string;
  private laps: SectorLap[];
  private lapNumber = Number.NaN;
  private sectorIndex = -1;
  private splitsMs: number[] = [];
  private clean = false;
  private invalid = false;
  private lastClockMs = 0;
  private lastLapMs = 0;
  private pending: PendingLap | null = null;
  private sectorCount = 3;

  private readonly persist: boolean;

  /** `laps` given = in-memory only (tests, replays); otherwise loaded from and saved to disk. */
  constructor(key: string, session = Date.now().toString(36), laps?: SectorLap[]) {
    this.key = key;
    this.session = session;
    this.persist = laps === undefined;
    this.laps = laps ?? this.load();
  }

  private load(): SectorLap[] {
    try {
      const data = JSON.parse(readFileSync(fileFor(this.key), "utf8")) as { laps?: SectorLap[] };
      return Array.isArray(data.laps) ? data.laps : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    if (!this.persist) return;
    try {
      mkdirSync(DIR, { recursive: true });
      const file = fileFor(this.key);
      writeFileSync(`${file}.tmp`, JSON.stringify({ laps: this.laps.slice(-KEEP) }));
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      console.warn("[RaceEngineer] could not save sector history:", error instanceof Error ? error.message : error);
    }
  }

  feed(f: SectorFrame, nowMs: number): void {
    const clockMs = Math.round(f.currentLapS * 1000);
    const lastLapMs = Math.round(f.lastLapS * 1000);
    if (this.pending) {
      if (lastLapMs > 0 && lastLapMs !== this.pending.lastLapBeforeMs) this.commit(lastLapMs);
      else if (nowMs > this.pending.deadline) this.commit(this.pending.provisionalMs);
    }

    if (f.lapNumber !== this.lapNumber) {
      const finished = Number.isFinite(this.lapNumber) && this.clean && this.splitsMs.length === this.sectorCount - 1;
      if (finished) {
        this.pending = {
          lap: { id: `${nowMs.toString(36)}-${this.lapNumber}`, lapNumber: this.lapNumber + 1, at: nowMs, session: this.session, valid: !this.invalid },
          splitsMs: this.splitsMs,
          provisionalMs: this.lastClockMs,
          lastLapBeforeMs: this.lastLapMs,
          deadline: nowMs + LAP_TIME_WAIT_MS,
        };
      }
      this.lapNumber = f.lapNumber;
      this.splitsMs = [];
      this.invalid = false;
      // Only laps started on track at the line (sector 1, clock near zero) can be timed.
      this.clean = f.sectorIndex === 0 && f.pitStatus === "out" && clockMs < 5000;
      this.sectorIndex = f.sectorIndex;
    } else if (f.sectorIndex !== this.sectorIndex) {
      if (f.sectorIndex === this.sectorIndex + 1 && clockMs > 0) {
        this.splitsMs.push(clockMs);
        this.sectorCount = Math.max(this.sectorCount, f.sectorIndex + 1);
      } else if (f.sectorIndex !== 0) {
        this.clean = false; // skipped a sector (teleport / reset)
      }
      this.sectorIndex = f.sectorIndex;
    }
    if (f.isValidLap === false) this.invalid = true;
    if (f.pitStatus !== "out") this.invalid = true;
    if (clockMs + 2000 < this.lastClockMs && this.sectorIndex !== 0) this.clean = false; // clock reset mid-lap
    this.lastClockMs = clockMs;
    this.lastLapMs = lastLapMs;
  }

  private commit(lapMs: number): void {
    const p = this.pending;
    this.pending = null;
    if (!p || !(lapMs > 0)) return;
    const cumulative = [...p.splitsMs, lapMs];
    const sectorsMs = cumulative.map((v, i) => v - (i === 0 ? 0 : cumulative[i - 1]));
    if (sectorsMs.some((s) => !(s > 0))) return;
    const lap: SectorLap = { ...p.lap, lapMs, sectorsMs, suspect: this.isSuspect(sectorsMs) };
    this.laps.push(lap);
    if (this.laps.length > KEEP) this.laps = this.laps.slice(-KEEP);
    this.save();
    const fmt = sectorsMs.map((s) => (s / 1000).toFixed(3)).join(" / ");
    console.log(`[RaceEngineer] sectors lap ${lap.lapNumber}: ${(lapMs / 1000).toFixed(3)} (${fmt})${lap.valid ? "" : " invalid"}${lap.suspect ? " SUSPECT" : ""}`);
  }

  private isSuspect(sectorsMs: number[]): boolean {
    const longest = Math.max(...sectorsMs);
    const history = this.laps.filter((l) => l.valid && !l.suspect && l.sectorsMs.length === sectorsMs.length).slice(-30);
    return sectorsMs.some((s, i) => {
      if (s < MIN_SECTOR_MS) return true;
      // Real sectors are never a third of another one on the same lap (Spa's shortest ≈ 0.6 of its longest).
      if (s < longest * IN_LAP_RATIO) return true;
      const usual = history.length >= 3 ? median(history.map((l) => l.sectorsMs[i])) : null;
      return usual !== null && s < usual * SUSPECT_RATIO;
    });
  }

  /** Delete a lap by id. Returns the removed lap, or null when not found. */
  remove(id: string): SectorLap | null {
    const index = this.laps.findIndex((l) => l.id === id);
    if (index < 0) return null;
    const [removed] = this.laps.splice(index, 1);
    this.save();
    return removed;
  }

  view(limit = 10): SectorsPayload {
    const n = this.sectorCount;
    const bestAll: (number | null)[] = Array(n).fill(null);
    const bestBySession = new Map<string, (number | null)[]>();
    let lapAll: number | null = null;
    const lapBySession = new Map<string, number | null>();
    const better = (v: number, best: number | null) => best === null || v <= best;

    const views: SectorLapView[] = this.laps.map((lap) => {
      const sess = bestBySession.get(lap.session) ?? Array(n).fill(null);
      bestBySession.set(lap.session, sess);
      const thisSession = lap.session === this.session;
      if (!lap.valid || lap.suspect) {
        const c: SectorColor = lap.suspect ? "suspect" : "invalid";
        return { ...lap, colors: lap.sectorsMs.map(() => c), lapColor: c, thisSession };
      }
      const colors = lap.sectorsMs.map((s, i): SectorColor => {
        const color: SectorColor = better(s, bestAll[i]) ? "purple" : better(s, sess[i]) ? "green" : "yellow";
        if (better(s, bestAll[i])) bestAll[i] = s;
        if (better(s, sess[i])) sess[i] = s;
        return color;
      });
      const lapSess = lapBySession.get(lap.session) ?? null;
      const lapColor: SectorColor = better(lap.lapMs, lapAll) ? "purple" : better(lap.lapMs, lapSess) ? "green" : "yellow";
      if (better(lap.lapMs, lapAll)) lapAll = lap.lapMs;
      if (better(lap.lapMs, lapSess)) lapBySession.set(lap.session, lap.lapMs);
      return { ...lap, colors, lapColor, thisSession };
    });

    const sessBest = bestBySession.get(this.session) ?? Array(n).fill(null);
    let current: SectorsPayload["current"] = null;
    if (Number.isFinite(this.lapNumber) && this.clean) {
      const cumulative = this.splitsMs;
      const sectorsMs: (number | null)[] = Array.from({ length: n }, (_, i) => (i < cumulative.length ? cumulative[i] - (i === 0 ? 0 : cumulative[i - 1]) : null));
      const colors = sectorsMs.map((s, i): SectorColor | null => {
        if (s === null) return null;
        if (this.invalid) return "invalid";
        return better(s, bestAll[i]) ? "purple" : better(s, sessBest[i]) ? "green" : "yellow";
      });
      current = { lapNumber: this.lapNumber + 1, sectorsMs, colors, valid: !this.invalid };
    }

    return {
      key: this.key,
      session: this.session,
      laps: views.slice(-limit).reverse(),
      current,
      best: { all: bestAll, session: sessBest, lapAll, lapSession: lapBySession.get(this.session) ?? null },
    };
  }
}
