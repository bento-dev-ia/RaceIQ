import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AXIS_STEPS,
  AxisDetector,
  ButtonDetector,
  CALIBRATION_STEPS,
  KeyboardInput,
  findWheel,
  loadCalibration,
  loadSensitivity,
  pressedButtons,
  readWheel,
  saveCalibration,
  saveSensitivity,
  type AxisCal,
  type Calibration,
  type CalibrationStep,
} from "@/lib/trail-braking/input";
import {
  CORNERS,
  REDLINE_RPM,
  ROAD_HALF_WIDTH,
  centreAt,
  frontGripFactor,
  idealApexGear,
  idealTrace,
  initialState,
  linePoint,
  sampleOf,
  scoreAttempt,
  shift,
  step,
  trackLength,
  type CarState,
  type CornerSpec,
  type Inputs,
  type Sample,
  type Score,
} from "@/lib/trail-braking/sim";
import { m } from "@/paraglide/messages";
import { getSemanticCanvasContext } from "@raceiq/scene-3d/rendering/css-canvas";
import { AttemptChart } from "./AttemptChart";

type Phase = "ready" | "running" | "done";
type CornerId = CornerSpec["id"];

const DT = 1 / 120;
const BEST_KEY = "raceiq.trailBraking.best";
const AUTO_GEAR_KEY = "raceiq.trailBraking.autoGear";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not persisted */
  }
}

const CORNER_LABEL: Record<CornerId, () => string> = {
  hairpin: m.trail_corner_hairpin,
  medium: m.trail_corner_medium,
  fast: m.trail_corner_fast,
};
const PART_LABEL: Record<Score["parts"][number]["key"], () => string> = {
  application: m.trail_part_application,
  trail: m.trail_part_trail,
  smoothness: m.trail_part_smoothness,
  grip: m.trail_part_grip,
  gear: m.trail_part_gear,
  result: m.trail_part_result,
};
const STEP_LABEL: Record<CalibrationStep, () => string> = {
  steer: m.trail_calib_steer,
  throttle: m.trail_calib_throttle,
  brake: m.trail_calib_brake,
  shiftUp: m.trail_calib_shift_up,
  shiftDown: m.trail_calib_shift_down,
};

// ── Drawing ──────────────────────────────────────────────────────────────

interface Skid { x: number; y: number }

function polygonAlong(ctx: CanvasRenderingContext2D, spec: CornerSpec, from: number, to: number, inner: number, outer: number, stepM = 2): void {
  ctx.beginPath();
  for (let s = from; s <= to; s += stepM) {
    const c = centreAt(spec, s);
    const x = c.x + inner * Math.cos(c.heading), y = c.y - inner * Math.sin(c.heading);
    if (s === from) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let s = to; s >= from; s -= stepM) {
    const c = centreAt(spec, s);
    ctx.lineTo(c.x + outer * Math.cos(c.heading), c.y - outer * Math.sin(c.heading));
  }
  ctx.closePath();
}

function drawCar(ctx: CanvasRenderingContext2D, car: CarState, braking: boolean): void {
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(-car.heading);
  // tyres
  ctx.fillStyle = "var(--trail-board-ink)";
  for (const [x, y] of [[-1.05, 1.35], [1.05, 1.35], [-1.05, -1.45], [1.05, -1.45]]) ctx.fillRect(x - 0.18, y - 0.36, 0.36, 0.72);
  // body (nose up = +y)
  ctx.fillStyle = car.sliding ? "var(--trail-car-sliding)" : "var(--trail-car)";
  ctx.beginPath();
  ctx.moveTo(-0.95, -2.2);
  ctx.lineTo(0.95, -2.2);
  ctx.lineTo(1.0, 1.2);
  ctx.quadraticCurveTo(0.9, 2.35, 0, 2.45);
  ctx.quadraticCurveTo(-0.9, 2.35, -1.0, 1.2);
  ctx.closePath();
  ctx.fill();
  // stripe, cockpit, wing
  ctx.fillStyle = "var(--trail-car-stripe)";
  ctx.fillRect(-0.18, -2.2, 0.36, 4.6);
  ctx.fillStyle = "var(--trail-cockpit)";
  ctx.beginPath();
  ctx.ellipse(0, 0.1, 0.62, 0.95, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "var(--trail-wing)";
  ctx.fillRect(-1.05, -2.5, 2.1, 0.3);
  // brake lights
  ctx.fillStyle = braking ? "var(--trail-brake-light-on)" : "var(--trail-brake-light-off)";
  ctx.fillRect(-0.85, -2.25, 0.45, 0.14);
  ctx.fillRect(0.4, -2.25, 0.45, 0.14);
  if (braking) {
    ctx.fillStyle = "var(--trail-brake-glow)";
    ctx.fillRect(-1.1, -2.9, 2.2, 0.7);
  }
  ctx.restore();
}

function drawScene(ctx: CanvasRenderingContext2D, spec: CornerSpec, car: CarState, input: Inputs, skids: readonly Skid[], w: number, h: number): void {
  const scale = Math.max(3.6, Math.min(9, 1200 / Math.max(car.v * 3.6, 70))) * (h / 600);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "var(--trail-grass)";
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h * 0.76);
  ctx.scale(scale, -scale);
  ctx.rotate(car.heading);
  ctx.translate(-car.x, -car.y);

  const end = trackLength(spec);
  const from = Math.max(0, car.s - 140), to = Math.min(end, car.s + 320);
  const cs = spec.approach, ce = spec.approach + spec.angle * spec.radius;

  // mowing stripes
  for (let s = Math.floor(from / 12) * 12; s < to; s += 12) {
    polygonAlong(ctx, spec, s, Math.min(to, s + 12), -70, 70, 3);
    ctx.fillStyle = Math.floor(s / 12) % 2 === 0 ? "var(--trail-grass-stripe-a)" : "var(--trail-grass-stripe-b)";
    ctx.fill();
  }
  // gravel run-off on the outside of the corner
  polygonAlong(ctx, spec, Math.max(from, cs - 40), Math.min(to, ce + 40), -(ROAD_HALF_WIDTH + 1.2), -(ROAD_HALF_WIDTH + 12));
  ctx.fillStyle = "var(--trail-gravel)";
  ctx.fill();
  // asphalt + white edge lines
  polygonAlong(ctx, spec, from, to, -ROAD_HALF_WIDTH - 0.3, ROAD_HALF_WIDTH + 0.3);
  ctx.fillStyle = "var(--trail-edge-line)";
  ctx.fill();
  polygonAlong(ctx, spec, from, to, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH);
  ctx.fillStyle = "var(--trail-asphalt)";
  ctx.fill();
  // kerbs: inside around the apex, outside at turn-in and exit
  const kerb = (a: number, b: number, side: number) => {
    for (let s = Math.max(from, a); s < Math.min(to, b); s += 2) {
      polygonAlong(ctx, spec, s, s + 2, side * ROAD_HALF_WIDTH, side * (ROAD_HALF_WIDTH + 1.1), 1);
      ctx.fillStyle = Math.floor(s / 2) % 2 === 0 ? "var(--trail-kerb-red)" : "var(--trail-kerb-white)";
      ctx.fill();
    }
  };
  kerb(cs - 6, ce + 6, 1);
  kerb(cs - 30, cs + 4, -1);
  kerb(ce - 4, ce + 40, -1);
  // braking zone lines on the tarmac + boards
  for (const d of [150, 100, 50]) {
    const s = cs - d;
    if (s < from || s > to) continue;
    polygonAlong(ctx, spec, s, s + 0.6, -ROAD_HALF_WIDTH, -ROAD_HALF_WIDTH + 1.5, 0.3);
    ctx.fillStyle = "var(--trail-brake-line)";
    ctx.fill();
    const c = centreAt(spec, s);
    ctx.save();
    ctx.translate(c.x - (ROAD_HALF_WIDTH + 3.5), c.y);
    ctx.scale(1, -1);
    ctx.fillStyle = "var(--trail-board)";
    ctx.fillRect(-2.3, -1.5, 4.6, 3);
    ctx.strokeStyle = "var(--trail-board-ink)";
    ctx.lineWidth = 0.2;
    ctx.strokeRect(-2.3, -1.5, 4.6, 3);
    ctx.fillStyle = "var(--trail-board-ink)";
    ctx.font = "bold 2.1px var(--font-sans)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(d), 0, 0.1);
    ctx.restore();
  }
  // ideal line, faint
  ctx.setLineDash([1.6, 1.6]);
  ctx.strokeStyle = "var(--trail-ideal-line)";
  ctx.lineWidth = 0.35;
  ctx.beginPath();
  for (let s = Math.max(0, car.s - 40); s <= to; s += 2) {
    const p = linePoint(spec, s);
    if (s === Math.max(0, car.s - 40)) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  // skid marks
  ctx.fillStyle = "var(--trail-skid)";
  for (const k of skids) ctx.fillRect(k.x - 0.25, k.y - 0.25, 0.5, 0.5);

  drawCar(ctx, car, input.brake > 0.05);
}

// ── Component ────────────────────────────────────────────────────────────

interface Hud { kmh: number; gear: number; rpm: number; throttle: number; brake: number; steer: number; gx: number; gy: number; sliding: boolean; wheel: boolean }

export function TrailBrakingTrainer() {
  const [cornerId, setCornerId] = useState<CornerId>("hairpin");
  const spec = CORNERS[cornerId];
  const ideal = useMemo(() => idealTrace(spec), [spec]);
  const targetGear = useMemo(() => idealApexGear(spec), [spec]);
  const [phase, setPhase] = useState<Phase>("ready");
  const [score, setScore] = useState<Score | null>(null);
  const [attempt, setAttempt] = useState<Sample[]>([]);
  const [best, setBest] = useState(() => readJson<Partial<Record<CornerId, number>>>(BEST_KEY, {}));
  const [calibration, setCalibration] = useState<Calibration | null>(loadCalibration);
  const [calibrating, setCalibrating] = useState<{ step: CalibrationStep; progress: number } | null>(null);
  const [calibrationSession, setCalibrationSession] = useState(0);
  const [sensitivity, setSensitivity] = useState(loadSensitivity);
  const [autoGear, setAutoGear] = useState(() => readJson(AUTO_GEAR_KEY, false));
  const [wheelPresent, setWheelPresent] = useState(() => findWheel() !== null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hud, setHud] = useState<Hud>({ kmh: 0, gear: 0, rpm: 0, throttle: 0, brake: 0, steer: 0, gx: 0, gy: 0, sliding: false, wheel: false });
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keyboard = useRef(new KeyboardInput());
  const sim = useRef<{ car: CarState; samples: Sample[]; acc: number; last: number; skids: Skid[] } | null>(null);
  const prevButtons = useRef<Set<number>>(new Set());
  const phaseRef = useRef<Phase>("ready");
  phaseRef.current = phase;
  const skipRequested = useRef(false);

  useEffect(() => keyboard.current.attach(), []);
  useEffect(() => {
    const update = () => setWheelPresent(findWheel() !== null);
    window.addEventListener("gamepadconnected", update);
    window.addEventListener("gamepaddisconnected", update);
    const poll = window.setInterval(update, 1500); // browsers only expose pads after an input
    return () => {
      window.removeEventListener("gamepadconnected", update);
      window.removeEventListener("gamepaddisconnected", update);
      window.clearInterval(poll);
    };
  }, []);

  const start = useCallback(() => {
    sim.current = { car: initialState(spec), samples: [], acc: 0, last: performance.now(), skids: [] };
    setScore(null);
    setAttempt([]);
    setNotice(null);
    setPhase("running");
  }, [spec]);

  // Main loop: physics at a fixed 120 Hz, drawing every animation frame.
  useEffect(() => {
    if (calibrating) return;
    let raf = 0;
    let lastHud = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const canvas = canvasRef.current;
      // Theme-aware context: resolves the var(--trail-*) colours used by drawScene.
      const ctx = canvas ? getSemanticCanvasContext(canvas) : null;
      if (!canvas || !ctx) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }

      // Inputs: wheel when calibrated and present (keyboard wins while used).
      const kbInput = keyboard.current.update(1 / 60);
      const pad = calibration ? findWheel(calibration.gamepadId) : null;
      const useWheel = !!pad && !!calibration && !keyboard.current.active;
      const raw = pad && calibration && useWheel ? readWheel(pad, calibration) : kbInput;
      const input: Inputs = { ...raw, steer: useWheel ? raw.steer * sensitivity : raw.steer };

      // Edges: shifting and restart (any wheel button that isn't a paddle restarts).
      let shiftDir = keyboard.current.takeShift();
      let restart = keyboard.current.takeRestart();
      if (pad) {
        const now2 = pressedButtons(pad);
        for (const b of now2) {
          if (prevButtons.current.has(b)) continue;
          if (calibration?.shiftUp === b) shiftDir = 1;
          else if (calibration?.shiftDown === b) shiftDir = -1;
          else restart = true;
        }
        prevButtons.current = now2;
      }
      if (restart) {
        start();
        return;
      }

      const state = sim.current;
      if (state && phaseRef.current === "running") {
        if (shiftDir !== 0 && !autoGear) {
          const r = shift(state.car, shiftDir as 1 | -1);
          if (r.ok) state.car = r.car;
          else if (r.reason === "overrev") setNotice(m.trail_shift_blocked());
        }
        state.acc += Math.min(0.1, (now - state.last) / 1000);
        state.last = now;
        while (state.acc >= DT) {
          state.car = step(spec, state.car, input, DT, { autoGear });
          state.samples.push(sampleOf(state.car, input));
          if (state.car.sliding && state.samples.length % 3 === 0) {
            state.skids.push({ x: state.car.x, y: state.car.y });
            if (state.skids.length > 600) state.skids.shift();
          }
          state.acc -= DT;
        }
        const finished = state.car.s >= trackLength(spec) && !state.car.offTrack;
        if (finished || state.car.offTrack || state.car.t > 45) {
          const result = scoreAttempt(spec, state.samples, finished, { manualGear: !autoGear });
          setScore(result);
          setAttempt(state.samples);
          setPhase("done");
          setBest((prev) => {
            if ((prev[spec.id] ?? -1) >= result.total) return prev;
            const next = { ...prev, [spec.id]: result.total };
            writeJson(BEST_KEY, next);
            return next;
          });
        }
      }
      const car = state?.car ?? initialState(spec);
      ctx.save();
      ctx.scale(dpr, dpr);
      drawScene(ctx, spec, car, input, state?.skids ?? [], rect.width, rect.height);
      ctx.restore();
      // React HUD at ~20 Hz (the canvas already updates every frame).
      if (now - lastHud >= 50) {
        lastHud = now;
        const grip = car.grip || 1;
        setHud({ kmh: car.v * 3.6, gear: car.gear, rpm: car.rpm, ...input, gx: car.ay / grip, gy: car.ax / grip, sliding: car.sliding, wheel: useWheel });
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [autoGear, calibrating, calibration, sensitivity, spec, start]);

  // Calibration: one session per click on "Calibrate".
  useEffect(() => {
    if (calibrationSession === 0) return;
    let raf = 0;
    const axes: Partial<Record<CalibrationStep, AxisCal>> = {};
    const buttons: Partial<Record<CalibrationStep, number>> = {};
    let stepIndex = 0;
    let axisDetector: AxisDetector | null = null;
    let buttonDetector: ButtonDetector | null = null;
    const finish = (padId: string) => {
      const cal: Calibration = { gamepadId: padId, steer: axes.steer!, throttle: axes.throttle!, brake: axes.brake!, shiftUp: buttons.shiftUp, shiftDown: buttons.shiftDown };
      saveCalibration(cal);
      setCalibration(cal);
      if (cal.shiftUp === undefined || cal.shiftDown === undefined) {
        setAutoGear(true);
        writeJson(AUTO_GEAR_KEY, true);
      }
      setCalibrating(null);
      setCalibrationSession(0);
    };
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const pad = findWheel();
      if (!pad) return;
      const current = CALIBRATION_STEPS[stepIndex];
      if (skipRequested.current) {
        skipRequested.current = false;
        stepIndex = CALIBRATION_STEPS.length;
        finish(pad.id);
        cancelAnimationFrame(raf);
        return;
      }
      if (AXIS_STEPS.has(current)) {
        axisDetector ??= new AxisDetector(pad, new Set(Object.values(axes).map((c) => c.axis)));
        const result = axisDetector.update(pad, now);
        setCalibrating({ step: current, progress: axisDetector.progress });
        if (!result) return;
        axes[current] = result;
        axisDetector = null;
      } else {
        buttonDetector ??= new ButtonDetector(pad, new Set(Object.values(buttons)));
        setCalibrating({ step: current, progress: 0 });
        const result = buttonDetector.update(pad);
        if (result === null) return;
        buttons[current] = result;
        buttonDetector = null;
      }
      stepIndex++;
      if (stepIndex >= CALIBRATION_STEPS.length) {
        // let go of the last button before it can count as "restart"
        prevButtons.current = pressedButtons(pad);
        finish(pad.id);
        cancelAnimationFrame(raf);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [calibrationSession]);

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const cornerStart = spec.approach;
  const chartFrom = Math.max(0, (ideal.find((p) => p.brake > 0.05)?.s ?? cornerStart - 150) - 40);
  const chartTo = cornerStart + spec.angle * spec.radius + 40;
  const rpmPct = Math.min(1, hud.rpm / REDLINE_RPM);
  const shiftLights = [0.82, 0.88, 0.94, 0.98].map((t) => rpmPct >= t);
  const approaching = phase === "running" && sim.current && sim.current.car.s < cornerStart + 10;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto bg-app-bg p-4 text-app-text md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{m.trail_title()}</h1>
          <p className="max-w-3xl text-sm text-app-text-muted">{m.trail_desc()}</p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(CORNERS) as CornerId[]).map((id) => (
          <Button key={id} size="sm" variant={id === cornerId ? "default" : "outline"} onClick={() => { setCornerId(id); setPhase("ready"); setScore(null); sim.current = null; }}>
            {CORNER_LABEL[id]()}{best[id] !== undefined ? ` · ${best[id]}` : ""}
          </Button>
        ))}
        <Button size="sm" variant="outline" disabled={calibrating !== null} onClick={() => { setCalibrating({ step: "steer", progress: 0 }); setCalibrationSession((n) => n + 1); }}>
          {m.trail_calibrate()}
        </Button>
        <label className="ml-2 flex items-center gap-2 text-sm text-app-text-secondary">
          {m.trail_sensitivity()} {Math.round(sensitivity * 100)}%
          <input
            type="range"
            min={20}
            max={100}
            value={Math.round(sensitivity * 100)}
            onChange={(e) => { const v = Number(e.target.value) / 100; setSensitivity(v); saveSensitivity(v); }}
            className="w-28 accent-app-accent"
          />
        </label>
        <label className="ml-2 flex items-center gap-2 text-sm text-app-text-secondary">
          <input type="checkbox" checked={autoGear} onChange={(e) => { setAutoGear(e.target.checked); writeJson(AUTO_GEAR_KEY, e.target.checked); }} className="accent-app-accent" />
          {m.trail_auto_gear()}
        </label>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={toggleFullscreen}>{m.trail_fullscreen()}</Button>
      </div>

      <p className="text-xs text-app-text-muted" aria-live="polite">
        {hud.wheel ? m.trail_input_wheel() : wheelPresent && !calibration ? m.trail_wheel_found_uncalibrated() : m.trail_input_keyboard()}
      </p>

      {calibrating && (
        <div className="rounded-md border border-app-accent/60 bg-app-surface p-4">
          <p className="text-base font-medium">{STEP_LABEL[calibrating.step]()}</p>
          {!wheelPresent && <p className="mt-1 text-xs text-app-text-muted">{m.trail_calib_no_wheel()}</p>}
          {AXIS_STEPS.has(calibrating.step) && (
            <div className="mt-2 h-2 w-full max-w-sm overflow-hidden rounded bg-app-progress-track">
              <div className="h-full bg-app-accent transition-[width]" style={{ width: `${Math.round(calibrating.progress * 100)}%` }} />
            </div>
          )}
          <div className="mt-3 flex gap-2">
            {!AXIS_STEPS.has(calibrating.step) && <Button size="sm" variant="outline" onClick={() => { skipRequested.current = true; }}>{m.trail_calib_skip()}</Button>}
            <Button size="sm" variant="ghost" onClick={() => { setCalibrating(null); setCalibrationSession(0); }}>{m.trail_cancel()}</Button>
          </div>
        </div>
      )}

      <div ref={containerRef} className="relative h-[max(520px,calc(100vh-230px))] w-full overflow-hidden rounded-md border border-app-border bg-app-bg">
        <canvas ref={canvasRef} className="size-full" />

        {/* HUD */}
        <div className="pointer-events-none absolute right-4 top-4 flex items-stretch gap-4 rounded-lg bg-app-bg/60 p-4">
          <div className="flex flex-col justify-between">
            <div className="flex gap-1" aria-hidden>
              {shiftLights.map((on, i) => (
                <span key={i} className={`size-2.5 rounded-full ${on ? (i < 2 ? "bg-status-success" : i < 3 ? "bg-status-warning" : "bg-status-danger") : "bg-app-text/10"}`} />
              ))}
            </div>
            <div className="text-right">
              <div className="text-4xl font-semibold tabular-nums leading-none">{Math.round(hud.kmh)}</div>
              <div className="text-xs text-app-text-muted">km/h</div>
            </div>
            <div className="h-1.5 w-28 overflow-hidden rounded bg-app-text/10">
              <div className={`h-full ${rpmPct > 0.94 ? "bg-status-danger" : "bg-app-accent"}`} style={{ width: `${rpmPct * 100}%` }} />
            </div>
          </div>
          <div className="flex flex-col items-center justify-center">
            <div className="text-5xl font-bold tabular-nums leading-none">{hud.gear || "N"}</div>
            <div className="mt-1 text-xs text-app-text-muted">{m.trail_target_gear({ gear: targetGear })}</div>
          </div>
          <div className="flex h-24 items-end gap-1.5 self-center" aria-hidden>
            <div className="relative h-full w-3 rounded bg-app-text/10"><div className="absolute bottom-0 w-full rounded bg-[var(--ch-throttle)]" style={{ height: `${hud.throttle * 100}%` }} /></div>
            <div className="relative h-full w-3 rounded bg-app-text/10"><div className="absolute bottom-0 w-full rounded bg-[var(--ch-brake)]" style={{ height: `${hud.brake * 100}%` }} /></div>
          </div>
          {/* Friction circle: braking pushes the dot up, cornering sideways; outside the ring the front slides. */}
          <svg width="96" height="96" viewBox="-48 -48 96 96" className="self-center" aria-label={m.trail_friction_circle()}>
            <circle r="40" fill="none" stroke="var(--trail-dial-ring)" strokeWidth="1.5" />
            <circle r="20" fill="none" stroke="var(--trail-dial-grid)" strokeWidth="1" />
            <line x1="-40" x2="40" y1="0" y2="0" stroke="var(--trail-dial-grid)" />
            <line y1="-40" y2="40" x1="0" x2="0" stroke="var(--trail-dial-grid)" />
            <circle cx={Math.max(-46, Math.min(46, hud.gx * 40))} cy={Math.max(-46, Math.min(46, -hud.gy * 40))} r="5.5" fill={hud.sliding ? "var(--trail-car-sliding)" : "var(--trail-you)"} stroke="var(--app-surface)" strokeWidth="2" />
          </svg>
        </div>
        {/* Steering indicator */}
        <div className="pointer-events-none absolute bottom-4 left-1/2 h-1.5 w-64 -translate-x-1/2 rounded bg-app-text/10">
          <div className="absolute top-0 h-full w-1 rounded bg-app-text" style={{ left: `${50 + Math.max(-1, Math.min(1, hud.steer)) * 50}%` }} />
        </div>
        {approaching && !autoGear && (
          <div className="pointer-events-none absolute left-4 top-4 rounded-md bg-app-bg/60 px-3 py-2 text-sm">{m.trail_downshift_hint({ gear: targetGear })}</div>
        )}
        {notice && phase === "running" && (
          <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-md bg-status-danger/85 px-3 py-1.5 text-sm font-medium">{notice}</div>
        )}

        {phase !== "running" && (
          <div className="absolute inset-0 flex items-center justify-center bg-app-bg/45">
            <div className="flex max-w-md flex-col items-center gap-3 rounded-lg bg-app-surface/95 p-6 text-center">
              {phase === "done" && score ? (
                <>
                  <div className="text-6xl font-semibold tabular-nums">{score.total}</div>
                  <div className="text-xs text-app-text-muted">{m.trail_score_of_100()}{best[spec.id] !== undefined ? ` · ${m.trail_best({ score: best[spec.id] ?? 0 })}` : ""}</div>
                  <p className="text-sm text-app-text-secondary">{score.tips[0]}</p>
                </>
              ) : (
                <p className="text-sm text-app-text-secondary">{m.trail_how_to()}</p>
              )}
              <Button size="lg" onClick={start}>{phase === "done" ? m.trail_again() : m.trail_start()}</Button>
              <p className="text-xs text-app-text-muted">{m.trail_retry_hint()}</p>
            </div>
          </div>
        )}
      </div>

      {phase === "done" && score && (
        <section className="grid gap-4 lg:grid-cols-[minmax(0,340px)_1fr]" aria-label={m.trail_result()}>
          <div className="flex flex-col gap-3 rounded-md border border-app-border bg-app-surface p-4">
            {score.parts.map((p) => (
              <div key={p.key}>
                <div className="flex justify-between text-sm">
                  <span>{PART_LABEL[p.key]()}</span>
                  <span className="tabular-nums text-app-text-secondary">{p.points}/{p.max}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded bg-app-progress-track">
                  <div className="h-full rounded bg-app-accent" style={{ width: `${(p.points / p.max) * 100}%` }} />
                </div>
              </div>
            ))}
            <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-sm text-app-text-secondary">
              {score.tips.map((tip) => <li key={tip}>{tip}</li>)}
            </ul>
            <p className="text-xs text-app-text-muted">
              {m.trail_apex_speed({ kmh: Math.round(score.minKmh), ideal: Math.round(Math.min(...ideal.map((p) => p.kmh))) })}
              {" · "}{m.trail_front_grip({ pct: Math.round((frontGripFactor(0.4, 0) / frontGripFactor(0, 0) - 1) * 100) })}
            </p>
          </div>
          <div className="rounded-md border border-app-border bg-app-surface p-4">
            <AttemptChart samples={attempt} ideal={ideal} fromM={chartFrom} toM={chartTo} showGear={!autoGear} />
          </div>
        </section>
      )}
    </div>
  );
}
