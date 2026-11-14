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
      if (!current || pass.segTime < current.segTime) this.driverBest.set(key, { ...pass, source: "driver" });
    }
    this.changed();
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

export type { CornerPass };
