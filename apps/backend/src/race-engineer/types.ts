/**
 * Race engineer (voice coach) — shared types.
 *
 * Everything in this folder works on a small, game-agnostic `EngineerSample`
 * (lap distance in metres + lap time) so the same math runs on stored laps,
 * the live feed and a bot trace reconstructed from world positions.
 */

export interface EngineerSample {
  /** Metres from the start/finish line on the current lap. */
  d: number;
  /** Lap time in seconds at this sample. */
  t: number;
  /** Speed in km/h. */
  v: number;
  /** Gear (0 = neutral/reverse, unknown for bot traces → -1). */
  gear: number;
  /** Brake pedal 0..1 (NaN when unknown, e.g. bot traces). */
  brake: number;
  /** Throttle pedal 0..1 (NaN when unknown). */
  throttle: number;
  /** Steering -1..1 (NaN when unknown). */
  steer: number;
}

/**
 * A corner as a contiguous track segment. RaceIQ segments tile the lap, so a
 * corner segment contains its braking zone, the corner and the exit.
 */
export interface EngineerCorner {
  key: string;
  /** Spoken name, e.g. "La Source" or "Curva 5". */
  spokenName: string;
  startM: number;
  endM: number;
  /** Official turn numbers covered by this segment. */
  turns?: number[];
  /** Published-guide knowledge for this corner, when the track has a guide. */
  guide?: { brake: string; gear: string; turnIn?: string; tip: string };
}

/** Lap time as a function of distance inside a corner segment (relative to segment start). */
export interface TimeTrace {
  d: number[];
  t: number[];
}

export interface CornerPass {
  key: string;
  /** Lap distance where braking started, or null if no braking. */
  brakeStartM: number | null;
  /** Lap distance of turn-in (first steering after braking; estimated when unknown). */
  turnInM: number;
  /** Lap distance of the apex (minimum speed). */
  apexM: number;
  /** Metres from brake point to turn-in — the spoken "brake at X metres". */
  brakeBeforeTurnInM: number | null;
  /** Peak brake 0..1 (NaN when unknown). */
  peakBrake: number;
  /** Most steering (|−1..1|) between turn-in and just past the apex (NaN when unknown). */
  peakSteer: number;
  /** Brake still applied (≥8%) for at least 10 m past turn-in. */
  trailBraking: boolean | null;
  entryKmh: number;
  minKmh: number;
  exitKmh: number;
  /** Lowest forward gear between turn-in and apex (-1 when unknown). */
  gear: number;
  /** Lap distance where throttle passed 50% after the apex (null when unknown). */
  throttleOnM: number | null;
  /** Time spent in the analysed part of the segment, seconds. */
  segTime: number;
  /** Time vs distance from segment start, for comparing at any exit point. */
  trace: TimeTrace;
}

export type ReferenceSource = "driver" | "bot";

export interface CornerReference extends CornerPass {
  source: ReferenceSource;
  /** When the bot is faster here, its speeds / brake point override the driver's. */
  botOverride?: boolean;
}

export type IssueKind =
  | "brake-early"
  | "brake-late"
  | "brake-harder"
  | "brake-softer"
  | "trail-brake"
  | "min-speed-low"
  | "gear"
  | "throttle-late"
  | "turn-in-early"
  | "turn-in-late"
  | "steer-too-much"
  | "steer-too-little";

export interface CornerIssue {
  kind: IssueKind;
  /** Metres to move the brake point (positive = later). */
  brakeShiftM?: number;
  /** Metres to move the turn-in (positive = later). */
  turnInShiftM?: number;
  refBrakeBeforeM?: number | null;
  refPeakBrakePct?: number;
  refMinKmh?: number;
  refGear?: number;
}

export type CalloutKind = "pre-corner" | "post-corner" | "lap-summary" | "status";

export interface EngineerCallout {
  kind: CalloutKind;
  text: string;
  cornerKey?: string;
  /** Higher wins when two callouts compete for the same window. */
  priority: number;
}
