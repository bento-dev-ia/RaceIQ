import type { EngineerSample } from "./types";

/**
 * Learns bot (AI / other cars) reference laps from world positions only.
 *
 * ACC exposes every car's XYZ but pedals/gear only for the player, so:
 *  1. While the player drives, we record a centre line: (x, z) → lap distance,
 *     using the player's own coordinates from the same buffer (same frame).
 *  2. Every other car is projected onto that line to get its lap distance,
 *     and speed comes from Δdistance / Δtime.
 *  3. A full, plausible lap per car becomes an `EngineerSample[]` with
 *     unknown pedals (NaN) and gear (-1), fed to the reference as a bot lap.
 */

export interface CarPosition {
  id: number;
  x: number;
  z: number;
}

interface MapPoint { x: number; z: number; d: number }

const MAP_STEP_M = 2;
const SEARCH_WINDOW = 40; // ± map points for incremental projection
const MAX_OFFLINE_M = 25; // further than this from the line → not on track
const MIN_SPEED_KMH = 20;

/** Centre line built from the player's positions on one complete lap. */
export class TrackLine {
  private points: MapPoint[] = [];
  private building: MapPoint[] = [];
  private buildingLap = -1;
  readonly trackLengthM: number;

  constructor(trackLengthM: number) {
    this.trackLengthM = trackLengthM;
  }

  get ready(): boolean {
    return this.points.length > 50;
  }

  /** Feed the player's position. A clean lap from ~0 to ~L finalizes the line. */
  observePlayer(lap: number, d: number, x: number, z: number): void {
    if (this.ready) return;
    if (lap !== this.buildingLap) {
      const prev = this.building;
      if (prev.length > 50 && prev[0].d < 30 && prev[prev.length - 1].d > this.trackLengthM - 60) {
        this.points = prev;
      }
      this.building = [];
      this.buildingLap = lap;
    }
    const last = this.building[this.building.length - 1];
    if (!last || d - last.d >= MAP_STEP_M) {
      if (last && d < last.d) return;
      this.building.push({ x, z, d });
    }
  }

  /** Project a position; `hint` is the previous map index for this car (or -1). */
  project(x: number, z: number, hint: number): { d: number; index: number; offset: number } | null {
    const pts = this.points;
    if (pts.length === 0) return null;
    let from = 0;
    let to = pts.length - 1;
    if (hint >= 0) {
      from = hint - SEARCH_WINDOW;
      to = hint + SEARCH_WINDOW;
    }
    let bestI = -1;
    let bestDist2 = Infinity;
    for (let k = from; k <= to; k++) {
      const i = ((k % pts.length) + pts.length) % pts.length;
      const dx = pts[i].x - x;
      const dz = pts[i].z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist2) { bestDist2 = d2; bestI = i; }
    }
    const offset = Math.sqrt(bestDist2);
    if (offset > MAX_OFFLINE_M) {
      // Lost the car locally (pit, teleport) — retry with a global search once.
      return hint >= 0 ? this.project(x, z, -1) : null;
    }
    return { d: this.refine(bestI, x, z), index: bestI, offset };
  }

  /** Continuous distance: project onto whichever neighbouring segment is closer. */
  private refine(i: number, x: number, z: number): number {
    const pts = this.points;
    let best = pts[i].d;
    let bestErr = Infinity;
    for (const j of [i - 1, i]) {
      if (j < 0 || j + 1 >= pts.length) continue;
      const a = pts[j];
      const b = pts[j + 1];
      const sx = b.x - a.x;
      const sz = b.z - a.z;
      const len2 = sx * sx + sz * sz;
      if (len2 <= 0) continue;
      const u = Math.min(1, Math.max(0, ((x - a.x) * sx + (z - a.z) * sz) / len2));
      const px = a.x + u * sx;
      const pz = a.z + u * sz;
      const err = (px - x) ** 2 + (pz - z) ** 2;
      if (err < bestErr) { bestErr = err; best = a.d + u * (b.d - a.d); }
    }
    return best;
  }
}

interface CarTrace {
  hint: number;
  lapStartMs: number;
  lastD: number;
  lastMs: number;
  samples: EngineerSample[];
  broken: boolean;
}

/** Tracks every other car and emits completed bot laps. */
export class BotLapRecorder {
  private readonly traces = new Map<number, CarTrace>();
  readonly line: TrackLine;
  private readonly onLap: (samples: EngineerSample[], lapTimeS: number) => void;

  constructor(line: TrackLine, onLap: (samples: EngineerSample[], lapTimeS: number) => void) {
    this.line = line;
    this.onLap = onLap;
  }

  observe(cars: readonly CarPosition[], nowMs: number): void {
    if (!this.line.ready) return;
    const L = this.line.trackLengthM;
    for (const car of cars) {
      let trace = this.traces.get(car.id);
      const projected = this.line.project(car.x, car.z, trace?.hint ?? -1);
      if (!projected) {
        if (trace) trace.broken = true;
        continue;
      }
      if (!trace) {
        trace = { hint: projected.index, lapStartMs: -1, lastD: projected.d, lastMs: nowMs, samples: [], broken: true };
        this.traces.set(car.id, trace);
        continue;
      }
      trace.hint = projected.index;
      const dt = (nowMs - trace.lastMs) / 1000;
      if (dt <= 0) continue;
      let delta = projected.d - trace.lastD;
      const crossed = delta < -L / 2;
      if (crossed) delta += L;
      if (delta < -5 || delta > 120) trace.broken = true; // went backwards / teleported

      if (crossed) {
        // Interpolate the exact line-crossing time.
        const frac = (L - trace.lastD) / Math.max(delta, 1e-3);
        const crossMs = trace.lastMs + frac * dt * 1000;
        this.finishLap(trace, crossMs);
        trace.lapStartMs = crossMs;
        trace.samples = [];
        trace.broken = false;
      }

      if (trace.lapStartMs >= 0 && !trace.broken) {
        const v = (delta / dt) * 3.6;
        const t = (nowMs - trace.lapStartMs) / 1000;
        trace.samples.push({ d: projected.d, t, v, gear: -1, brake: Number.NaN, throttle: Number.NaN, steer: Number.NaN });
      }
      trace.lastD = projected.d;
      trace.lastMs = nowMs;
    }
  }

  private finishLap(trace: CarTrace, crossMs: number): void {
    if (trace.broken || trace.lapStartMs < 0 || trace.samples.length < 100) return;
    const samples = smoothSpeeds(centralDifferenceSpeeds(trace.samples));
    const L = this.line.trackLengthM;
    const covered = samples[0].d < 40 && samples[samples.length - 1].d > L - 80;
    const slow = samples.some((s) => s.v < MIN_SPEED_KMH);
    if (!covered || slow) return;
    this.onLap(samples, (crossMs - trace.lapStartMs) / 1000);
  }
}

/**
 * Speed from distance over a ±k sample window (~0.5 s at 80 ms sampling).
 * Frame-to-frame differences of projected positions are too noisy: a single
 * jittery sample would otherwise become the corner's "minimum speed".
 */
export function centralDifferenceSpeeds(samples: readonly EngineerSample[], k = 3): EngineerSample[] {
  return samples.map((s, i) => {
    const a = samples[Math.max(0, i - k)];
    const b = samples[Math.min(samples.length - 1, i + k)];
    const dt = b.t - a.t;
    return dt > 0 ? { ...s, v: ((b.d - a.d) / dt) * 3.6 } : s;
  });
}

/** Centred moving average over ~5 samples: position-derived speed is noisy. */
export function smoothSpeeds(samples: readonly EngineerSample[], radius = 2): EngineerSample[] {
  return samples.map((s, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(samples.length - 1, i + radius); k++) {
      sum += samples[k].v;
      n++;
    }
    return { ...s, v: sum / n };
  });
}
