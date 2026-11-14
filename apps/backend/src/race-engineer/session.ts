import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { AccGraphicsView } from "./acc-graphics";
import { BotLapRecorder, TrackLine } from "./bot-recorder";
import { RaceEngineerCoach } from "./coach";
import type { EngineerCallout, EngineerCorner, EngineerSample } from "./types";

const BOT_SAMPLE_INTERVAL_MS = 80;

/**
 * One car + track context: turns live ACC frames into coach frames and
 * optionally learns bot laps. Shared by the live service and the replay tool.
 */
export class RaceEngineerSession {
  readonly coach: RaceEngineerCoach;
  readonly line: TrackLine;
  readonly bots: BotLapRecorder;
  readonly trackLengthM: number;
  botLaps = 0;
  private lapNumber = Number.NaN;
  private lapChangedAtMs = 0;
  private lastBotSampleMs = Number.NEGATIVE_INFINITY;
  private readonly onBotLapLearned?: (lapTimeS: number, total: number) => void;

  constructor(
    corners: readonly EngineerCorner[],
    trackLengthM: number,
    storedLaps: readonly EngineerSample[][] = [],
    onBotLapLearned?: (lapTimeS: number, total: number) => void,
  ) {
    this.trackLengthM = trackLengthM;
    this.onBotLapLearned = onBotLapLearned;
    this.coach = new RaceEngineerCoach(corners, trackLengthM);
    for (const lap of storedLaps) this.coach.reference.addDriverLap(lap);
    this.line = new TrackLine(trackLengthM);
    this.bots = new BotLapRecorder(this.line, (samples, lapTimeS) => {
      this.coach.reference.addBotLap(samples);
      this.botLaps++;
      this.onBotLapLearned?.(lapTimeS, this.botLaps);
    });
  }

  /** True when the caller should read other cars' positions this frame. */
  wantsCars(nowMs: number, learnFromBots: boolean): boolean {
    return learnFromBots && nowMs - this.lastBotSampleMs >= BOT_SAMPLE_INTERVAL_MS;
  }

  feed(packet: Readonly<TelemetryPacket>, view: AccGraphicsView, nowMs: number, bestLapS: number): EngineerCallout[] {
    if (packet.LapNumber !== this.lapNumber) {
      this.lapNumber = packet.LapNumber;
      this.lapChangedAtMs = nowMs;
    }
    const L = this.trackLengthM;
    const pos = view.normalizedCarPosition;
    let d = pos * L;
    // normalizedCarPosition and LapNumber don't flip on the exact same frame.
    if (nowMs - this.lapChangedAtMs < 3000 && pos > 0.5) d -= L;
    else if (packet.CurrentLap > 10 && pos < 0.1 && nowMs - this.lapChangedAtMs > 10_000) d += L;

    const callouts = this.coach.feed({
      d,
      t: packet.CurrentLap,
      v: packet.Speed * 3.6,
      gear: packet.Gear,
      brake: packet.Brake / 255,
      throttle: packet.Accel / 255,
      steer: packet.Steer / 127,
      lapNumber: packet.LapNumber,
      // Out/in laps through the pit lane (limiter) must never become a reference.
      lapValid: packet.acc && packet.acc.pitStatus !== "out" ? false : packet.acc?.isValidLap ?? null,
      lastLapS: packet.LastLap,
      bestLapS,
      nowMs,
    });

    if (view.player || view.others.length > 0) {
      this.lastBotSampleMs = nowMs;
      if (view.player && d >= 0 && d <= L) this.line.observePlayer(packet.LapNumber, d, view.player.x, view.player.z);
      this.bots.observe(view.others, nowMs);
    }
    return callouts;
  }
}
