import { analyzeCornerPass, exitPointM, traceTimeAt } from "./corner-analysis";
import { diagnoseCorner } from "./diagnosis";
import {
  ENGINEER_ON_PHRASE,
  NO_REFERENCE_PHRASE,
  REFERENCE_READY_PHRASE,
  briefingPhrase,
  guidePhrase,
  lapSummaryPhrase,
  postCornerPhrase,
  preCornerPhrase,
} from "./phrases-pt-br";
import { CornerReferenceSet } from "./reference";
import type { CornerIssue, CornerPass, EngineerCallout, EngineerCorner, EngineerSample } from "./types";

export interface CoachFrame extends EngineerSample {
  lapNumber: number;
  /** Game validity flag for the lap in progress (null = unknown). */
  lapValid: boolean | null;
  /** Last completed lap time in seconds (0 when none). */
  lastLapS: number;
  /** Session best in seconds (0 when none). */
  bestLapS: number;
  /** Wall clock in ms — used to know when the previous callout finished. */
  nowMs: number;
}

export interface CoachOptions {
  /** Silence before every brake point, metres. */
  silenceBeforeBrakeM?: number;
  /** How many corners to coach per lap. */
  focusCount?: number;
  /** Post-corner threshold for focus corners, seconds. */
  focusDeltaS?: number;
  /** Post-corner threshold for the other corners, seconds. */
  otherDeltaS?: number;
  /** Brief every non-focus corner (gear, speed, brake point). Default true. */
  briefAll?: boolean;
}

interface Attempt {
  pass: CornerPass;
  deltaS: number;
  issues: CornerIssue[];
}

interface Pending {
  callout: EngineerCallout;
  /** Lap distance after which it can no longer be said. */
  expiresAtM: number;
  /** Lap the callout belongs to (stale ones are dropped on lap change). */
  lap: number;
}

/** A focus corner's tip becomes sayable once its silence zone is this close. */
const PRE_CORNER_LOOKAHEAD_M = 1500;
const MAX_COACHABLE_DELTA_S = 2;
/** Briefings for non-focus corners open this close to the corner's silence zone. */
const BRIEFING_LOOKAHEAD_M = 700;

/** Rough TTS duration in seconds for a pt-BR phrase at rate ~1.1 (≈3 words/s). */
export function estimateSpeechSeconds(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return 0.7 + words * 0.32; // + radio pips before and after
}

/**
 * Live coaching state machine. Feed it every frame; it returns callouts to
 * speak *now*. It never talks inside a braking/corner zone and only when the
 * phrase fits before the next one.
 */
export class RaceEngineerCoach {
  readonly reference: CornerReferenceSet;
  private readonly silenceM: number;
  private readonly focusCount: number;
  private readonly focusDeltaS: number;
  private readonly otherDeltaS: number;

  private lapSamples: EngineerSample[] = [];
  private lapValid = true;
  private currentLap = -1;
  private lastD = -1;
  private lastCornerDone = -1;
  private speakingUntilMs = 0;
  private greeted = false;
  private announcedReady = false;
  private readonly attempts = new Map<string, Attempt>();
  private focus: string[] = [];
  private pending: Pending[] = [];

  readonly corners: readonly EngineerCorner[];
  readonly trackLengthM: number;

  constructor(
    corners: readonly EngineerCorner[],
    trackLengthM: number,
    reference?: CornerReferenceSet,
    options: CoachOptions = {},
  ) {
    this.corners = corners;
    this.trackLengthM = trackLengthM;
    this.reference = reference ?? new CornerReferenceSet(corners);
    this.silenceM = options.silenceBeforeBrakeM ?? 150;
    // Every corner where time is lost gets its tip; the costliest ones win when the gaps are short.
    this.focusCount = options.focusCount ?? corners.length;
    this.focusDeltaS = options.focusDeltaS ?? 0.1;
    this.otherDeltaS = options.otherDeltaS ?? 0.3;
    this.briefAll = options.briefAll ?? true;
  }

  private readonly briefAll: boolean;

  /** Called with every complete, valid lap that fed the reference (for persistence). */
  onReferenceLap?: (samples: readonly EngineerSample[], lapTimeS: number) => void;

  get focusKeys(): readonly string[] {
    return this.focus;
  }

  feed(frame: CoachFrame): EngineerCallout[] {
    if (!this.greeted) {
      this.greeted = true;
      this.announcedReady = this.reference.hasReference;
      this.enqueue({ kind: "status", priority: 1, text: this.reference.hasReference ? ENGINEER_ON_PHRASE : NO_REFERENCE_PHRASE }, Number.POSITIVE_INFINITY, frame.lapNumber);
    }

    if (frame.lapNumber !== this.currentLap) this.onLapChange(frame);
    if (frame.lapValid === false) this.lapValid = false;

    const d = frame.d;
    if (d >= 0 && d <= this.trackLengthM * 1.02 && (this.lapSamples.length === 0 || d >= this.lapSamples[this.lapSamples.length - 1].d)) {
      this.lapSamples.push({ d, t: frame.t, v: frame.v, gear: frame.gear, brake: frame.brake, throttle: frame.throttle, steer: frame.steer });
    }

    this.checkCornerExits(d);
    this.schedulePreCorner(d);
    this.lastD = d;
    return this.drain(frame);
  }

  /**
   * Brake zone + corner, where nothing may be said: from `silenceM` before the
   * reference brake point until the driver is back on throttle (reference
   * throttle pick-up), or 60% through the segment when that's unknown.
   * Track segments run all the way to the next corner, so using their end
   * would leave no room to talk on a technical circuit.
   */
  private zone(index: number): { start: number; end: number } {
    if (this.zonesVersion !== this.reference.version) {
      this.zones = this.corners.map((_, i) => this.computeZone(i));
      this.zonesVersion = this.reference.version;
    }
    return this.zones[index];
  }

  private zones: { start: number; end: number }[] = [];
  private zonesVersion = -1;

  private computeZone(index: number): { start: number; end: number } {
    const c = this.corners[index];
    const ref = this.reference.get(c.key);
    if (!ref) return { start: c.startM - this.silenceM, end: c.startM + (c.endM - c.startM) * 0.6 };
    const busyFrom = ref.brakeStartM ?? ref.turnInM;
    const busyUntil = ref.throttleOnM ?? ref.apexM + 40;
    return { start: busyFrom - this.silenceM, end: Math.min(c.endM, busyUntil + 20) };
  }

  private inZone(d: number): boolean {
    for (let i = 0; i < this.corners.length; i++) {
      const z = this.zone(i);
      if (d >= z.start && d <= z.end) return true;
    }
    return false;
  }

  private nextZoneStart(d: number): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.corners.length; i++) {
      const s = this.zone(i).start;
      if (s > d && s < best) best = s;
    }
    if (best === Number.POSITIVE_INFINITY && this.corners.length > 0) best = this.zone(0).start + this.trackLengthM;
    return best;
  }

  private onLapChange(frame: CoachFrame): void {
    const finishedLap = this.currentLap;
    const samples = this.lapSamples;
    const wasValid = this.lapValid;
    this.currentLap = frame.lapNumber;
    this.lapSamples = [];
    this.lapValid = true;
    this.lastCornerDone = -1;
    // Unspoken tips for the new lap's corners get another chance on this lap.
    for (const p of this.pending) {
      if (p.callout.kind === "pre-corner" && p.callout.cornerKey) this.sentPre.delete(`${frame.lapNumber}:${p.callout.cornerKey}`);
    }
    this.pending = this.pending.filter((p) => p.callout.kind === "status");
    if (finishedLap < 0 || samples.length < 10) return;

    const complete = samples[0].d < 60 && samples[samples.length - 1].d > this.trackLengthM - 120;
    if (complete && wasValid) {
      const hadReference = this.reference.hasReference;
      this.reference.addDriverLap(samples);
      if (frame.lastLapS > 0) this.onReferenceLap?.(samples, frame.lastLapS);
      if (!hadReference && this.reference.hasReference && !this.announcedReady) {
        this.announcedReady = true;
        this.enqueue({ kind: "status", priority: 2, text: REFERENCE_READY_PHRASE }, Number.POSITIVE_INFINITY, frame.lapNumber);
      }
    }

    // Focus = where this lap lost the most to the (now updated) best segments.
    if (complete) this.reassessLap(samples);
    this.recomputeFocus();
    if (complete && frame.lastLapS > 0) {
      const focusName = this.focus.length > 0 ? this.cornerByKey(this.focus[0])?.spokenName ?? null : null;
      // The game's best already includes the lap just finished; compare to the best *before* it.
      const gameBest = frame.bestLapS > 0 && frame.bestLapS < frame.lastLapS - 0.0005 ? frame.bestLapS : null;
      const before = this.bestLapS !== null && gameBest !== null ? Math.min(this.bestLapS, gameBest) : this.bestLapS ?? gameBest;
      this.enqueue({ kind: "lap-summary", priority: 2, text: lapSummaryPhrase(frame.lastLapS, before, focusName) }, this.trackLengthM / 2, frame.lapNumber);
      if (wasValid && (this.bestLapS === null || frame.lastLapS < this.bestLapS)) this.bestLapS = frame.lastLapS;
    }
  }

  private bestLapS: number | null = null;

  /** Stretches of the lap where the engineer may talk (for tuning / diagnostics). */
  speakingGaps(): { from: number; to: number }[] {
    const zones = this.corners.map((_, i) => this.zone(i)).sort((a, b) => a.start - b.start);
    const gaps: { from: number; to: number }[] = [];
    let cursor = 0;
    for (const z of zones) {
      if (z.start > cursor) gaps.push({ from: cursor, to: z.start });
      cursor = Math.max(cursor, z.end);
    }
    if (cursor < this.trackLengthM) gaps.push({ from: cursor, to: this.trackLengthM });
    return gaps;
  }

  private reassessLap(samples: readonly EngineerSample[]): void {
    for (const corner of this.corners) {
      const ref = this.reference.get(corner.key);
      if (!ref) continue;
      const exitM = exitPointM(corner, ref);
      const pass = analyzeCornerPass(samples, corner, exitM);
      const refTime = traceTimeAt(ref.trace, exitM - corner.startM);
      if (!pass || refTime === null) continue;
      this.attempts.set(corner.key, { pass, deltaS: pass.segTime - refTime, issues: diagnoseCorner(pass, ref) });
    }
  }

  /** One line per analysed corner: delta and issues (diagnostics / replay tool). */
  debugAttempts(): string {
    return [...this.attempts.entries()]
      .map(([key, a]) => `   ${this.cornerByKey(key)?.spokenName}: ${a.deltaS >= 0 ? "+" : ""}${a.deltaS.toFixed(2)}s [${a.issues.map((i) => i.kind).join(",")}]`)
      .join("\n");
  }

  private recomputeFocus(): void {
    this.focus = [...this.attempts.entries()]
      .filter(([, a]) => a.deltaS > 0.05 && a.deltaS <= MAX_COACHABLE_DELTA_S && a.issues.length > 0)
      .sort((a, b) => b[1].deltaS - a[1].deltaS)
      .slice(0, this.focusCount)
      .map(([key]) => key);
  }

  private cornerByKey(key: string): EngineerCorner | undefined {
    return this.corners.find((c) => c.key === key);
  }

  private checkCornerExits(d: number): void {
    for (let i = this.lastCornerDone + 1; i < this.corners.length; i++) {
      const corner = this.corners[i];
      const ref = this.reference.get(corner.key);
      const exitM = exitPointM(corner, ref);
      if (d < exitM) break;
      this.lastCornerDone = i;
      if (this.lastD < 0 || this.lastD > exitM || !ref) continue;
      const pass = analyzeCornerPass(this.lapSamples, corner, exitM);
      const refTime = traceTimeAt(ref.trace, exitM - corner.startM);
      if (!pass || refTime === null) continue;
      const deltaS = pass.segTime - refTime;
      const issues = diagnoseCorner(pass, ref);
      this.attempts.set(corner.key, { pass, deltaS, issues });

      const isFocus = this.focus.includes(corner.key);
      const threshold = isFocus ? this.focusDeltaS : this.otherDeltaS;
      // > 2 s in one corner is an incident (spin, off, traffic), not technique.
      if (Math.abs(deltaS) >= threshold && Math.abs(deltaS) <= MAX_COACHABLE_DELTA_S) {
        const next = this.nextZoneStart(d);
        this.enqueue(
          { kind: "post-corner", priority: isFocus ? 3 : 2, cornerKey: corner.key, text: postCornerPhrase(deltaS, deltaS > 0 ? issues[0] : undefined, deltaS > 0 ? issues[1] : undefined) },
          next,
          this.currentLap,
        );
      }
    }
  }

  /**
   * Pre-corner tips for focus corners open two corners ahead and stay open
   * until that corner's silence zone begins.
   */
  private schedulePreCorner(d: number): void {
    for (const key of this.focus) {
      const index = this.corners.findIndex((c) => c.key === key);
      if (index < 0) continue;
      // Corners already passed this lap are next lap's: look across the line.
      const wraps = index <= this.lastCornerDone;
      const targetLap = wraps ? this.currentLap + 1 : this.currentLap;
      const sentKey = `${targetLap}:${key}`;
      if (this.sentPre.has(sentKey)) continue;
      const zoneStart = this.zone(index).start + (wraps ? this.trackLengthM : 0);
      if (zoneStart <= d || zoneStart - d > PRE_CORNER_LOOKAHEAD_M) continue;
      const attempt = this.attempts.get(key);
      const ref = this.reference.get(key);
      if (!attempt || !ref) continue;
      const issue = attempt.issues[0];
      let text = preCornerPhrase(this.corners[index].spokenName, ref, issue);
      // A visual turn-in reference from the track guide beats a number when the turn-in is what's wrong.
      const turnInCue = this.corners[index].guide?.turnIn;
      if (turnInCue && (issue?.kind === "turn-in-early" || issue?.kind === "turn-in-late")) text = `${text.slice(0, -1)}, ${turnInCue}.`;
      this.sentPre.add(sentKey);
      this.enqueue({ kind: "pre-corner", priority: 4, cornerKey: key, text }, zoneStart, this.currentLap);
    }
    this.scheduleBriefing(d);
  }

  /**
   * Every other corner gets a short briefing (name, gear, minimum speed, brake
   * point) right before it, lowest priority, so the driver always hears what
   * is coming even before there is anything to fix. Only the next corner is
   * considered; if the gap is too short the briefing is simply skipped.
   */
  private scheduleBriefing(d: number): void {
    if (!this.briefAll) return;
    const index = this.nextCornerIndex(d);
    if (index < 0) return;
    const corner = this.corners[index];
    if (this.focus.includes(corner.key)) return;
    const ref = this.reference.get(corner.key);
    // Without a reference of our own, a published track guide still gives the marker and gear.
    if (!ref && !corner.guide) return;
    const wraps = this.zone(index).start <= d;
    const targetLap = wraps ? this.currentLap + 1 : this.currentLap;
    const sentKey = `${targetLap}:brief:${corner.key}`;
    if (this.sentPre.has(sentKey)) return;
    const zoneStart = this.zone(index).start + (wraps ? this.trackLengthM : 0);
    if (zoneStart <= d || zoneStart - d > BRIEFING_LOOKAHEAD_M) return;
    this.sentPre.add(sentKey);
    // The guide's key tip is said once per session per corner; after that, only the numbers.
    const firstTime = !this.guideTipSaid.has(corner.key);
    let text: string;
    if (ref) {
      text = briefingPhrase(corner.spokenName, ref);
      if (corner.guide?.tip && firstTime) text += ` ${corner.guide.tip.charAt(0).toUpperCase()}${corner.guide.tip.slice(1)}.`;
    } else {
      text = guidePhrase(corner.spokenName, corner.guide!, firstTime);
    }
    if (corner.guide) this.guideTipSaid.add(corner.key);
    this.enqueue({ kind: "pre-corner", priority: 1, cornerKey: corner.key, text }, zoneStart, this.currentLap);
  }

  /**
   * Index of the corner whose silence zone comes next after `d`, by distance
   * ahead on track (wrapping past the line). Independent of which exits were
   * seen, so it is right even when the lap started from the pit lane.
   */
  private nextCornerIndex(d: number): number {
    let best = -1;
    let bestAhead = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.corners.length; i++) {
      let ahead = this.zone(i).start - d;
      if (ahead <= 0) ahead += this.trackLengthM;
      if (ahead < bestAhead) {
        bestAhead = ahead;
        best = i;
      }
    }
    return best;
  }

  private readonly sentPre = new Set<string>();
  private readonly guideTipSaid = new Set<string>();

  /**
   * Phrases this coach is likely to say next lap — briefings and tips for
   * every corner, plus post-corner verdicts near the current deltas — so a
   * natural-voice cache can be filled before they are needed.
   */
  plannedPhrases(): string[] {
    const out: string[] = [ENGINEER_ON_PHRASE, NO_REFERENCE_PHRASE, REFERENCE_READY_PHRASE];
    for (const corner of this.corners) {
      const ref = this.reference.get(corner.key);
      if (!ref) {
        if (corner.guide) out.push(guidePhrase(corner.spokenName, corner.guide, true), guidePhrase(corner.spokenName, corner.guide, false));
        continue;
      }
      const attempt = this.attempts.get(corner.key);
      if (this.focus.includes(corner.key) && attempt) out.push(preCornerPhrase(corner.spokenName, ref, attempt.issues[0]));
      else out.push(briefingPhrase(corner.spokenName, ref));
      if (attempt && attempt.deltaS > 0) {
        for (const d of [-0.1, 0, 0.1]) {
          const delta = Math.max(0.1, attempt.deltaS + d);
          out.push(postCornerPhrase(delta, attempt.issues[0], attempt.issues[1]));
        }
      }
    }
    for (let tenths = 1; tenths <= 5; tenths++) out.push(postCornerPhrase(-tenths / 10, undefined));
    return out;
  }

  private enqueue(callout: EngineerCallout, expiresAtM: number, lap: number): void {
    this.pending.push({ callout, expiresAtM, lap });
  }

  private drain(frame: CoachFrame): EngineerCallout[] {
    const d = frame.d;
    // Pre-corner callouts are only valid while their corner is actually just ahead
    // (the position jumps when leaving the pit box, which would otherwise keep a
    // stale "next corner" alive for most of a lap).
    this.pending = this.pending.filter((p) => (p.callout.kind === "status" || p.lap === this.currentLap) && d < p.expiresAtM
      && (p.callout.kind !== "pre-corner" || p.expiresAtM - d <= PRE_CORNER_LOOKAHEAD_M + 200));
    if (this.pending.length === 0 || frame.nowMs < this.speakingUntilMs || this.inZone(d)) return [];

    // The car keeps accelerating on the straight: budget 15% more distance.
    const mps = (Math.max(frame.v, 30) / 3.6) * 1.15;
    const room = this.nextZoneStart(d) - d;
    // Most important first; among equals, the one that expires soonest (nearest corner).
    this.pending.sort((a, b) => b.callout.priority - a.callout.priority || a.expiresAtM - b.expiresAtM);
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      const seconds = estimateSpeechSeconds(p.callout.text);
      if (seconds * mps > room) continue;
      this.pending.splice(i, 1);
      this.speakingUntilMs = frame.nowMs + seconds * 1000;
      return [p.callout];
    }
    return [];
  }
}
