/**
 * Wheel + pedals through the browser Gamepad API (Logitech G29/G923, Fanatec,
 * Thrustmaster… all show up as gamepads with axes), with a one-time
 * calibration that finds which axis is which and where it rests. Keyboard
 * arrows are a fallback with progressive ramps, so trail-braking is still
 * possible without a wheel.
 */
import type { Inputs } from "./sim";

export interface AxisCal {
  axis: number;
  /** Value at rest (pedals released / wheel centred). */
  rest: number;
  /** Value fully pressed (pedals) or turned fully right (wheel). */
  full: number;
}

export interface Calibration {
  gamepadId: string;
  steer: AxisCal;
  throttle: AxisCal;
  brake: AxisCal;
  /** Paddle / button indexes (optional: without them the gearbox can be automatic). */
  shiftUp?: number;
  shiftDown?: number;
}

const SENSITIVITY_KEY = "raceiq.trailBraking.steerSensitivity";

/**
 * Fraction of full steering lock reached with the wheel turned as far as during
 * calibration. A 900° wheel turned fully maps to full lock at 1.0, which feels
 * twitchy; 0.5 is closer to a GT3's ratio.
 */
export function loadSensitivity(): number {
  try {
    const v = Number(localStorage.getItem(SENSITIVITY_KEY));
    return v >= 0.2 && v <= 1 ? v : 0.5;
  } catch {
    return 0.5;
  }
}

export function saveSensitivity(value: number): void {
  try {
    localStorage.setItem(SENSITIVITY_KEY, String(value));
  } catch {
    /* not persisted */
  }
}

/** Indexes of the buttons currently pressed. */
export function pressedButtons(pad: Gamepad): Set<number> {
  const out = new Set<number>();
  pad.buttons.forEach((b, i) => {
    if (b.pressed || b.value > 0.5) out.add(i);
  });
  return out;
}

/** Waits for a button that wasn't pressed at the start of the step. */
export class ButtonDetector {
  private readonly baseline: ReadonlySet<number>;
  private readonly taken: ReadonlySet<number>;

  constructor(pad: Gamepad, taken: ReadonlySet<number>) {
    this.baseline = pressedButtons(pad);
    this.taken = taken;
  }

  update(pad: Gamepad): number | null {
    for (const i of pressedButtons(pad)) if (!this.baseline.has(i) && !this.taken.has(i)) return i;
    return null;
  }
}

const STORAGE_KEY = "raceiq.trailBraking.calibration";

export function loadCalibration(): Calibration | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Calibration) : null;
  } catch {
    return null;
  }
}

export function saveCalibration(cal: Calibration): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
  } catch {
    /* private mode: calibrate again next time */
  }
}

/** The first connected gamepad that has enough axes for a wheel + pedals. */
export function findWheel(preferredId?: string): Gamepad | null {
  const pads = typeof navigator !== "undefined" && navigator.getGamepads ? [...navigator.getGamepads()].filter((p): p is Gamepad => !!p) : [];
  return pads.find((p) => p.id === preferredId) ?? pads.find((p) => p.axes.length >= 3) ?? null;
}

function norm(value: number, cal: AxisCal): number {
  const span = cal.full - cal.rest;
  return Math.abs(span) < 1e-3 ? 0 : (value - cal.rest) / span;
}

export function readWheel(pad: Gamepad, cal: Calibration): Inputs {
  const a = pad.axes;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    steer: clamp(norm(a[cal.steer.axis] ?? cal.steer.rest, cal.steer), -1, 1),
    throttle: clamp(norm(a[cal.throttle.axis] ?? cal.throttle.rest, cal.throttle), 0, 1),
    brake: clamp(norm(a[cal.brake.axis] ?? cal.brake.rest, cal.brake), 0, 1),
  };
}

// ── Calibration steps ────────────────────────────────────────────────────

export type CalibrationStep = "steer" | "throttle" | "brake" | "shiftUp" | "shiftDown";
export const CALIBRATION_STEPS: readonly CalibrationStep[] = ["steer", "throttle", "brake", "shiftUp", "shiftDown"];
export const AXIS_STEPS: ReadonlySet<CalibrationStep> = new Set(["steer", "throttle", "brake"]);

/**
 * Watches one step: the axis that moves furthest from the baseline (and isn't
 * taken yet) wins once it has been held there for a moment.
 */
export class AxisDetector {
  private readonly baseline: readonly number[];
  private readonly taken: ReadonlySet<number>;
  private heldSince = 0;
  private candidate = -1;
  progress = 0;

  constructor(pad: Gamepad, taken: ReadonlySet<number>) {
    this.baseline = [...pad.axes];
    this.taken = taken;
  }

  /** Returns the calibrated axis when the movement has been held ≥ 0.6 s. */
  update(pad: Gamepad, nowMs: number): AxisCal | null {
    let best = -1;
    let bestDelta = 0;
    pad.axes.forEach((v, i) => {
      if (this.taken.has(i)) return;
      const d = Math.abs(v - (this.baseline[i] ?? 0));
      if (d > bestDelta) {
        bestDelta = d;
        best = i;
      }
    });
    this.progress = Math.min(1, bestDelta / 0.7);
    if (best < 0 || bestDelta < 0.6) {
      this.candidate = -1;
      return null;
    }
    if (best !== this.candidate) {
      this.candidate = best;
      this.heldSince = nowMs;
      return null;
    }
    if (nowMs - this.heldSince < 600) return null;
    return { axis: best, rest: this.baseline[best] ?? 0, full: pad.axes[best] };
  }
}

// ── Keyboard fallback ────────────────────────────────────────────────────

/**
 * Arrow keys with ramps: ↑ throttle, ↓ brake (release is gradual too), ← →
 * steering; Z / X shift down / up; Space or Enter restart.
 */
export class KeyboardInput {
  private readonly down = new Set<string>();
  private state: Inputs = { throttle: 0, brake: 0, steer: 0 };
  private shiftQueue = 0;
  private restartQueued = false;
  private readonly onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
    if (e.type === "keydown" && !e.repeat) {
      const key = e.key.toLowerCase();
      if (key === "z") this.shiftQueue = -1;
      else if (key === "x") this.shiftQueue = 1;
      else if (key === " " || key === "enter") {
        this.restartQueued = true;
        e.preventDefault();
      }
    }
    if (!e.key.startsWith("Arrow")) return;
    e.preventDefault();
    if (e.type === "keydown") this.down.add(e.key);
    else this.down.delete(e.key);
  };

  /** -1 / 0 / +1 shift request since the last call. */
  takeShift(): number {
    const s = this.shiftQueue;
    this.shiftQueue = 0;
    return s;
  }

  takeRestart(): boolean {
    const r = this.restartQueued;
    this.restartQueued = false;
    return r;
  }

  attach(): () => void {
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
    return () => {
      window.removeEventListener("keydown", this.onKey);
      window.removeEventListener("keyup", this.onKey);
      this.down.clear();
    };
  }

  get active(): boolean {
    return this.down.size > 0 || this.state.brake > 0.01 || Math.abs(this.state.steer) > 0.01;
  }

  update(dt: number): Inputs {
    const toward = (v: number, target: number, rate: number) => (v < target ? Math.min(target, v + rate * dt) : Math.max(target, v - rate * dt));
    const s = this.state;
    const steerTarget = (this.down.has("ArrowRight") ? 0.45 : 0) - (this.down.has("ArrowLeft") ? 0.45 : 0);
    this.state = {
      throttle: toward(s.throttle, this.down.has("ArrowUp") ? 1 : 0, 4),
      brake: toward(s.brake, this.down.has("ArrowDown") ? 1 : 0, this.down.has("ArrowDown") ? 5 : 1.6),
      steer: toward(s.steer, steerTarget, 1.2),
    };
    return this.state;
  }
}
