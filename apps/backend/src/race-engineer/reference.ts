import { analyzeLap } from "./corner-analysis";
import type { CornerPass, CornerReference, EngineerCorner, EngineerSample } from "./types";

/**
 * Per-corner reference: the fastest pass through each corner across the
 * driver's valid laps ("best segment"), optionally improved by a bot trace.
 */
export class CornerReferenceSet {
  private readonly driverBest = new Map<string, CornerReference>();
  private readonly botBest = new Map<string, CornerReference>();
  private _laps = 0;
  readonly corners: readonly EngineerCorner[];

  constructor(corners: readonly EngineerCorner[]) {
    this.corners = corners;
  }

  get lapCount(): number {
    return this._laps;
  }

  /** Bumped whenever any corner's reference may have changed (for caches). */
  get version(): number {
    return this._version;
  }
  private _version = 0;
  private readonly merged = new Map<string, CornerReference | undefined>();

  private changed(): void {
    this._version++;
    this.merged.clear();
  }

  get hasReference(): boolean {
    return this.driverBest.size > 0 || this.botBest.size > 0;
  }

  addDriverLap(samples: readonly EngineerSample[]): void {
    const passes = analyzeLap(samples, this.corners);
    if (passes.size === 0) return;
    this._laps++;
    for (const [key, pass] of passes) {
      const current = this.driverBest.get(key);
      if (!current || pass.segTime < current.segTime) {
        this.driverBest.set(key, { ...pass, source: "driver" });
        const corner = this.corners.find((c) => c.key === key);
        if (corner) this.driverInputs.set(key, samples.filter((s) => s.d >= corner.startM && s.d <= corner.endM));
      }
    }
    const lapTime = samples[samples.length - 1].t;
    if (lapTime > 0 && (this.baseLapTime === null || lapTime < this.baseLapTime)) {
      this.baseLapTime = lapTime;
      this.baseLap = samples;
    }
    this.changed();
  }

  /** Driver pedal/steering samples of the best pass through each corner. */
  private readonly driverInputs = new Map<string, readonly EngineerSample[]>();
  /** Fastest complete driver lap: fills the straights between corners. */
  private baseLap: readonly EngineerSample[] = [];
  private baseLapTime: number | null = null;

  /**
   * "Ideal lap" inputs on a fixed distance grid: the best pass through every
   * corner stitched onto the fastest lap. Bots only expose position, so the
   * pedals and steering always come from the driver's own laps.
   */
  idealInputs(trackLengthM: number, stepM = 2): IdealInputs | null {
    if (this.baseLap.length < 2 && this.driverInputs.size === 0) return null;
    const count = Math.max(1, Math.ceil(trackLengthM / stepM) + 1);
    const throttle = new Float32Array(count);
    const brake = new Float32Array(count);
    const steer = new Float32Array(count);
    const speed = new Float32Array(count);
    const fill = (samples: readonly EngineerSample[], fromM: number, toM: number): void => {
      if (samples.length === 0) return;
      let j = 0;
      for (let i = Math.max(0, Math.ceil(fromM / stepM)); i < count && i * stepM <= toM; i++) {
        const d = i * stepM;
        while (j < samples.length - 2 && samples[j + 1].d < d) j++;
        const a = samples[j];
        const b = samples[Math.min(j + 1, samples.length - 1)];
        if (d < a.d - stepM * 4 || d > b.d + stepM * 4) continue; // no data near this point
        const k = b.d > a.d ? Math.min(1, Math.max(0, (d - a.d) / (b.d - a.d))) : 0;
        throttle[i] = a.throttle + (b.throttle - a.throttle) * k;
        brake[i] = a.brake + (b.brake - a.brake) * k;
        steer[i] = a.steer + (b.steer - a.steer) * k;
        speed[i] = a.v + (b.v - a.v) * k;
      }
    };
    fill(this.baseLap, 0, trackLengthM);
    for (const corner of this.corners) {
      const inputs = this.driverInputs.get(corner.key);
      if (inputs) fill(inputs, corner.startM, corner.endM);
    }
    return { stepM, throttle, brake, steer, speed };
  }

  addBotLap(samples: readonly EngineerSample[]): void {
    for (const [key, pass] of analyzeLap(samples, this.corners)) {
      const current = this.botBest.get(key);
      if (!current || pass.segTime < current.segTime) this.botBest.set(key, { ...pass, source: "bot" });
    }
    this.changed();
  }

  clearBot(): void {
    this.botBest.clear();
    this.changed();
  }

  /**
   * Effective reference for a corner (memoised; called every live frame).
   * Bot data only carries speeds and an estimated brake point, so pedal/gear
   * details stay the driver's.
   */
  get(key: string): CornerReference | undefined {
    if (this.merged.has(key)) return this.merged.get(key);
    const value = this.compute(key);
    this.merged.set(key, value);
    return value;
  }

  private compute(key: string): CornerReference | undefined {
    const driver = this.driverBest.get(key);
    const bot = this.botBest.get(key);
    if (!bot || (driver && driver.segTime <= bot.segTime)) return driver;
    if (!driver) return bot;
    // Bot turn-in is only estimated, so measure its brake point against the driver's turn-in.
    const brakeStartM = bot.brakeStartM ?? driver.brakeStartM;
    return {
      ...driver,
      brakeStartM,
      brakeBeforeTurnInM: brakeStartM === null ? null : Math.max(0, driver.turnInM - brakeStartM),
      apexM: bot.apexM,
      entryKmh: bot.entryKmh,
      minKmh: bot.minKmh,
      exitKmh: bot.exitKmh,
      segTime: bot.segTime,
      trace: bot.trace,
      source: "driver",
      botOverride: true,
    };
  }

  /** Sum of reference segment times — a rough theoretical-best indicator. */
  theoreticalSegmentSum(): number {
    let total = 0;
    for (const c of this.corners) total += this.get(c.key)?.segTime ?? 0;
    return total;
  }
}

export interface IdealInputs {
  stepM: number;
  /** 0..1 per grid point. */
  throttle: Float32Array;
  brake: Float32Array;
  /** -1..1 per grid point (left negative). */
  steer: Float32Array;
  /** km/h per grid point. */
  speed: Float32Array;
}

export type { CornerPass };
