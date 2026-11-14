/**
 * In-game input overlay for ACC: a small transparent, always-on-top box with
 *  - the next corner's targets (gear, minimum speed, distance to the brake
 *    point, brake % and trail-braking cue), and
 *  - a live scrolling graph of throttle, brake and steering — yours (solid)
 *    against the ideal (dashed), the ideal also drawn a little ahead.
 *
 *   bun run overlay [--url=http://raceiq.localhost:1355] [--scale=1.25] [--preview]
 *
 * While driving it is click-through. In ACC's menus / pause it becomes
 * draggable: drag it wherever you like; the position is remembered in
 * %APPDATA%/RaceIQ/overlay.json.
 *
 * It runs inside the signed bun.exe (no new executable to trust) and reads
 * ACC's documented shared memory directly; targets and the ideal come from
 * RaceIQ (/api/race-engineer/ideal). ACC must run in windowed / borderless
 * fullscreen — nothing can draw over exclusive fullscreen.
 */
import { dlopen, FFIType, JSCallback, ptr, read, toArrayBuffer } from "bun:ffi";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

if (process.platform !== "win32") throw new Error("The input overlay is Windows-only");

const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const BASE_URL = (arg("url") ?? "http://raceiq.localhost:1355").replace(/\/$/, "");
const PREVIEW = process.argv.includes("--preview");
const POSITION_FILE = join(process.env.APPDATA ?? ".", "RaceIQ", "overlay.json");

interface Placement { scale: number }
async function fetchPlacement(): Promise<Placement | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/race-engineer/ideal?version=placement-only`, { signal: AbortSignal.timeout(4000) });
    return ((await res.json()) as { placement?: Placement }).placement ?? null;
  } catch {
    return null;
  }
}
const SCALE = Number(arg("scale") ?? (await fetchPlacement())?.scale ?? 1) || 1;
const S = (v: number) => Math.round(v * SCALE);
const TYRE_W = S(100); // 2×2 tyre/brake panel on the right
const W = S(400) + TYRE_W + S(6);
const H = S(196);
const PAST_S = 5;
const FUTURE_S = 1.2;
const FPS = 60;

// ── Win32 ────────────────────────────────────────────────────────────────
const user32 = dlopen("user32.dll", {
  SetProcessDPIAware: { args: [], returns: FFIType.bool },
  GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
  CreateWindowExW: {
    args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.bool },
  SetWindowPos: { args: [FFIType.ptr, FFIType.i64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.bool },
  GetWindowRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  SetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i64 },
  GetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
  CallWindowProcW: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
  UpdateLayeredWindow: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
    returns: FFIType.bool,
  },
  PeekMessageW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.bool },
  TranslateMessage: { args: [FFIType.ptr], returns: FFIType.bool },
  DispatchMessageW: { args: [FFIType.ptr], returns: FFIType.i64 },
  GetDC: { args: [FFIType.ptr], returns: FFIType.u64 },
  DestroyWindow: { args: [FFIType.ptr], returns: FFIType.bool },
});
const gdi32 = dlopen("gdi32.dll", {
  CreateCompatibleDC: { args: [FFIType.u64], returns: FFIType.u64 },
  CreateDIBSection: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u64 },
  SelectObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
  CreateFontW: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.u64,
  },
  SetTextColor: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
  SetBkMode: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  TextOutW: { args: [FFIType.u64, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.bool },
  GetTextExtentPoint32W: { args: [FFIType.u64, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.bool },
  GdiFlush: { args: [], returns: FFIType.bool },
});
const kernel32 = dlopen("kernel32.dll", {
  GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.ptr },
  OpenFileMappingW: { args: [FFIType.u32, FFIType.bool, FFIType.ptr], returns: FFIType.ptr },
  MapViewOfFile: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.ptr },
  UnmapViewOfFile: { args: [FFIType.ptr], returns: FFIType.bool },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  GetLastError: { args: [], returns: FFIType.u32 },
});
const U = user32.symbols;
const G = gdi32.symbols;
const K = kernel32.symbols;

const wide = (s: string): Buffer => Buffer.from(`${s}\0`, "utf16le");

U.SetProcessDPIAware();
const screenW = U.GetSystemMetrics(0);
const screenH = U.GetSystemMetrics(1);

function loadPosition(): [number, number] {
  try {
    const saved = JSON.parse(readFileSync(POSITION_FILE, "utf8")) as { x: number; y: number };
    const x = Math.round(saved.x * screenW), y = Math.round(saved.y * screenH);
    if (x > -W / 2 && x < screenW - W / 2 && y >= 0 && y < screenH - H / 2) return [x, y];
  } catch {
    /* first run */
  }
  return [Math.round(screenW * 0.015), Math.round((screenH - H) / 2)];
}
function savePosition(x: number, y: number): void {
  try {
    mkdirSync(dirname(POSITION_FILE), { recursive: true });
    writeFileSync(POSITION_FILE, JSON.stringify({ x: x / screenW, y: y / screenH }));
  } catch (error) {
    console.warn("[Overlay] could not save position:", error instanceof Error ? error.message : error);
  }
}
const [posX, posY] = arg("x") !== undefined && arg("y") !== undefined ? [Number(arg("x")), Number(arg("y"))] : loadPosition();

const WS_EX_TOPMOST = 0x8, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x8000000;
const WS_POPUP = 0x80000000;
const GWL_EXSTYLE = -20, GWLP_WNDPROC = -4;
const className = wide("STATIC"); // system window class: no class registration needed
const title = wide("Bento Racing input overlay");
const hwnd = U.CreateWindowExW(
  WS_EX_TOPMOST | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE,
  ptr(className), ptr(title), WS_POPUP >>> 0, posX, posY, W, H, null, null, K.GetModuleHandleW(null), null,
);
if (!hwnd) throw new Error("CreateWindowExW failed");

// Dragging: while editable, report the whole box as a caption so Windows moves it natively.
let editable = false;
const WM_NCHITTEST = 0x84, HTCAPTION = 2, WM_EXITSIZEMOVE = 0x232;
const rect = new Int32Array(4);
let originalProc = 0n;
const wndProc = new JSCallback(
  (h: number, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_NCHITTEST && editable) return BigInt(HTCAPTION);
    if (msg === WM_EXITSIZEMOVE) {
      U.GetWindowRect(hwnd, ptr(rect));
      savePosition(rect[0], rect[1]);
      console.log(`[Overlay] position saved (${rect[0]}, ${rect[1]})`);
    }
    return BigInt(U.CallWindowProcW(originalProc, h, msg, wParam, lParam));
  },
  { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
);
originalProc = BigInt(U.SetWindowLongPtrW(hwnd, GWLP_WNDPROC, BigInt(wndProc.ptr!)));

function setEditable(value: boolean): void {
  if (editable === value) return;
  editable = value;
  const ex = BigInt(U.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  const next = value ? ex & ~BigInt(WS_EX_TRANSPARENT) : ex | BigInt(WS_EX_TRANSPARENT);
  U.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
}

U.ShowWindow(hwnd, 4 /* SW_SHOWNOACTIVATE */);

const screenDC = U.GetDC(null);
function dibSection(): { dc: bigint; pixels: Uint32Array } {
  const dc = G.CreateCompatibleDC(screenDC);
  const bmi = Buffer.alloc(44);
  bmi.writeUInt32LE(40, 0);
  bmi.writeInt32LE(W, 4);
  bmi.writeInt32LE(-H, 8); // top-down rows
  bmi.writeUInt16LE(1, 12);
  bmi.writeUInt16LE(32, 14);
  const bitsOut = new BigUint64Array(1);
  const dib = G.CreateDIBSection(dc, ptr(bmi), 0, ptr(bitsOut), null, 0);
  if (!dib || !dc) throw new Error("CreateDIBSection failed");
  G.SelectObject(dc, dib);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { dc: BigInt(dc), pixels: new Uint32Array(toArrayBuffer(Number(bitsOut[0]) as any, 0, W * H * 4)) };
}
const frame = dibSection(); // what is shown
const glyphs = dibSection(); // scratch: GDI text rendered white-on-black, used as alpha mask
const pixels = frame.pixels;

const size = new Int32Array([W, H]);
const dst = new Int32Array([posX, posY]);
const src = new Int32Array([0, 0]);
const blend = new Uint8Array([0, 0, 255, 1]); // AC_SRC_OVER, const alpha 255, AC_SRC_ALPHA
let presentFailures = 0;
function present(): void {
  // Present at the window's current spot (it may have been dragged).
  U.GetWindowRect(hwnd, ptr(rect));
  dst[0] = rect[0];
  dst[1] = rect[1];
  const ok = U.UpdateLayeredWindow(hwnd, screenDC, ptr(dst), ptr(size), frame.dc, ptr(src), 0, ptr(blend), 2 /* ULW_ALPHA */);
  if (!ok && presentFailures++ === 0) console.warn(`[Overlay] UpdateLayeredWindow failed (error ${K.GetLastError()})`);
}

const msg = Buffer.alloc(48);
function pumpMessages(): void {
  while (U.PeekMessageW(ptr(msg), null, 0, 0, 1 /* PM_REMOVE */)) {
    U.TranslateMessage(ptr(msg));
    U.DispatchMessageW(ptr(msg));
  }
}

// ── ACC shared memory (read-only) ────────────────────────────────────────
interface Mapping { handle: number; view: number }
function openMapping(name: string, bytes: number): Mapping | null {
  const handle = K.OpenFileMappingW(0x4 /* FILE_MAP_READ */, false, ptr(wide(name)));
  if (!handle) return null;
  const view = K.MapViewOfFile(handle, 0x4, 0, 0, bytes);
  if (!view) {
    K.CloseHandle(handle);
    return null;
  }
  return { handle: Number(handle), view: Number(view) };
}
let physics: Mapping | null = null;
let graphics: Mapping | null = null;
let lastOpenAttempt = 0;

interface Live {
  status: number; gas: number; brake: number; steer: number; speedKmh: number; gear: number; pos: number;
  /** FL, FR, RL, RR */
  tyreCore: number[]; pressure: number[]; brakeTemp: number[];
}
const quad = (p: unknown, offset: number): number[] => [0, 1, 2, 3].map((i) => read.f32(p as never, offset + i * 4));
function readLive(nowMs: number): Live | null {
  if ((!physics || !graphics) && nowMs - lastOpenAttempt > 2000) {
    lastOpenAttempt = nowMs;
    physics ??= openMapping("Local\\acpmf_physics", 800);
    graphics ??= openMapping("Local\\acpmf_graphics", 1600);
  }
  if (!physics || !graphics) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = physics.view as any, g = graphics.view as any;
  return {
    status: read.i32(g, 4), // 0 off, 1 replay, 2 live, 3 pause
    gas: read.f32(p, 4),
    brake: read.f32(p, 8),
    gear: read.i32(p, 16) - 1, // ACC: 0 = R, 1 = N, 2 = 1st
    steer: read.f32(p, 24),
    speedKmh: read.f32(p, 28),
    pos: read.f32(g, 248),
    pressure: quad(p, 88), // wheelsPressure, psi
    tyreCore: quad(p, 152), // tyreCoreTemperature, °C
    brakeTemp: quad(p, 348), // brakeTemp, °C
  };
}

// ── Ideal + corner targets from RaceIQ ───────────────────────────────────
interface CornerTarget { name: string; startM: number; brakeStartM: number | null; brakeBeforeTurnInM: number | null; turnInM: number; gear: number; minKmh: number; peakBrakePct: number | null; trailBraking: boolean | null }
interface Ideal { version: string; trackLengthM: number; stepM: number; throttle: number[]; brake: number[]; steer: number[]; corners: CornerTarget[] }
let ideal: Ideal | null = null;
let idealWarned = false;
let scaleNoticeShown = false;
async function pollIdeal(): Promise<void> {
  try {
    const url = `${BASE_URL}/api/race-engineer/ideal${ideal ? `?version=${encodeURIComponent(ideal.version)}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const body = (await res.json()) as { available: boolean; unchanged?: boolean; placement?: Placement } & Partial<Ideal>;
    if (body.placement && Math.abs(body.placement.scale - SCALE) > 0.01 && arg("scale") === undefined && !scaleNoticeShown) {
      scaleNoticeShown = true;
      console.log("[Overlay] size changed in RaceIQ — restart the overlay to apply it.");
    }
    if (!body.available) ideal = null;
    else if (!body.unchanged && body.throttle) {
      ideal = { ...(body as Ideal), corners: [...(body.corners ?? [])].sort((a, b) => a.startM - b.startM) };
      console.log(`[Overlay] ideal updated (${ideal.trackLengthM.toFixed(0)} m, ${ideal.corners.length} corners)`);
    }
    idealWarned = false;
  } catch (error) {
    if (!idealWarned) console.warn(`[Overlay] RaceIQ not reachable at ${BASE_URL}: ${error instanceof Error ? error.message : error}`);
    idealWarned = true;
  }
}
function idealAt(d: number): { thr: number; brk: number; str: number } | null {
  if (!ideal) return null;
  const L = ideal.trackLengthM;
  const x = (((d % L) + L) % L) / ideal.stepM;
  const i = Math.floor(x), j = Math.min(i + 1, ideal.throttle.length - 1), k = x - i;
  if (i < 0 || i >= ideal.throttle.length) return null;
  const lerp = (a: number[]) => a[i] + (a[j] - a[i]) * k;
  return { thr: lerp(ideal.throttle), brk: lerp(ideal.brake), str: lerp(ideal.steer) };
}

/** Next corner whose brake point (or turn-in) is still ahead, or the one being braked for now. */
function nextCorner(d: number): { corner: CornerTarget; toBrakeM: number; braking: boolean } | null {
  if (!ideal || ideal.corners.length === 0) return null;
  const L = ideal.trackLengthM;
  for (let lap = 0; lap < 2; lap++) {
    for (const c of ideal.corners) {
      const brakeAt = (c.brakeStartM ?? c.turnInM - 30) + lap * L;
      const until = c.turnInM + 30 + lap * L;
      if (d <= until) return { corner: c, toBrakeM: brakeAt - d, braking: d >= brakeAt };
    }
  }
  return null;
}

// ── History ──────────────────────────────────────────────────────────────
interface Sample { t: number; thr: number; brk: number; str: number; iThr: number; iBrk: number; iStr: number; hasIdeal: boolean }
const history: Sample[] = [];

// ── Drawing (premultiplied BGRA) ─────────────────────────────────────────
type Rgb = readonly [number, number, number];
const GREEN: Rgb = [46, 204, 64], RED: Rgb = [235, 59, 59], WHITE: Rgb = [240, 240, 240], BLUE: Rgb = [80, 170, 255];
const YELLOW: Rgb = [255, 204, 0], GREY: Rgb = [160, 166, 176];

function blendPx(x: number, y: number, c: Rgb, a: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const idx = y * W + x;
  const d = pixels[idx];
  const inv = 1 - a;
  const b = Math.round(c[2] * a + (d & 0xff) * inv);
  const g = Math.round(c[1] * a + ((d >>> 8) & 0xff) * inv);
  const r = Math.round(c[0] * a + ((d >>> 16) & 0xff) * inv);
  const al = Math.round(255 * a + (d >>> 24) * inv);
  pixels[idx] = ((al << 24) | (r << 16) | (g << 8) | b) >>> 0;
}
function fillRect(x0: number, y0: number, w: number, h: number, c: Rgb, a: number): void {
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) blendPx(x, y, c, a);
}
function roundedPanel(alpha: number, border: Rgb | null): void {
  const r = S(10);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x < r ? r - x : x >= W - r ? x - (W - r - 1) : 0;
      const dy = y < r ? r - y : y >= H - r ? y - (H - r - 1) : 0;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > r * r) continue;
      const edge = x < 2 || y < 2 || x >= W - 2 || y >= H - 2 || dist2 > (r - 2) * (r - 2);
      blendPx(x, y, border && edge ? border : [12, 14, 18], border && edge ? 0.9 : alpha);
    }
  }
}
function line(x0: number, y0: number, x1: number, y1: number, c: Rgb, a: number, thick: number, dashed = false): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  const half = thick / 2;
  for (let s = 0; s <= steps; s++) {
    const x = x0 + ((x1 - x0) * s) / steps;
    if (dashed && Math.floor(x / S(4)) % 2 === 1) continue;
    const y = y0 + ((y1 - y0) * s) / steps;
    for (let oy = -half; oy <= half; oy += 1) for (let ox = -half; ox <= half; ox += 1) blendPx(Math.round(x + ox), Math.round(y + oy), c, a);
  }
}

// Text: GDI draws white glyphs into the scratch DIB; their brightness becomes the alpha of `color`.
const fonts = new Map<number, bigint>();
function font(px: number, bold: boolean): bigint {
  const key = px * 2 + (bold ? 1 : 0);
  let f = fonts.get(key);
  if (!f) {
    f = BigInt(G.CreateFontW(-px, 0, 0, 0, bold ? 700 : 500, 0, 0, 0, 0, 0, 0, 4 /* ANTIALIASED_QUALITY */, 0, ptr(wide("Segoe UI"))));
    fonts.set(key, f);
  }
  return f;
}
const extent = new Int32Array(2);
function textWidth(text: string, px: number, bold = true): number {
  G.SelectObject(glyphs.dc, font(px, bold));
  const t = Buffer.from(text, "utf16le");
  G.GetTextExtentPoint32W(glyphs.dc, ptr(t), text.length, ptr(extent));
  return extent[0];
}
function drawText(text: string, x: number, y: number, px: number, color: Rgb, bold = true): number {
  if (!text) return 0;
  const t = Buffer.from(text, "utf16le");
  const top = Math.max(0, y), bottom = Math.min(H, y + Math.ceil(px * 1.6)); // room for descenders and accents
  glyphs.pixels.fill(0, top * W, bottom * W);
  G.SelectObject(glyphs.dc, font(px, bold));
  G.SetBkMode(glyphs.dc, 1 /* TRANSPARENT */);
  G.SetTextColor(glyphs.dc, 0xffffff);
  G.TextOutW(glyphs.dc, x, y, ptr(t), text.length);
  G.GdiFlush();
  const right = Math.min(W, x + textWidth(text, px, bold) + 2);
  for (let row = top; row < bottom; row++) {
    for (let col = Math.max(0, x); col < right; col++) {
      const v = glyphs.pixels[row * W + col] & 0xff;
      if (v) blendPx(col, row, color, v / 255);
    }
  }
  return textWidth(text, px, bold);
}

const PAD = S(8);
const BAR_W = S(10);
const STRIP_H = S(46); // two text lines
const GRAPH_X0 = PAD;
const TYRE_X0 = W - PAD - TYRE_W;
const GRAPH_X1 = TYRE_X0 - S(6) - PAD - BAR_W * 2 - S(4);
const PEDAL_Y0 = PAD + STRIP_H, PEDAL_Y1 = PEDAL_Y0 + Math.round((H - PEDAL_Y0 - PAD) * 0.66);
const STEER_Y0 = PEDAL_Y1 + S(6), STEER_Y1 = H - PAD;
const NOW_X = GRAPH_X0 + Math.round((GRAPH_X1 - GRAPH_X0) * (PAST_S / (PAST_S + FUTURE_S)));
const PX_PER_S = (GRAPH_X1 - GRAPH_X0) / (PAST_S + FUTURE_S);
const pedalY = (v: number) => PEDAL_Y1 - Math.max(0, Math.min(1, v)) * (PEDAL_Y1 - PEDAL_Y0);
const steerY = (v: number) => (STEER_Y0 + STEER_Y1) / 2 + Math.max(-1, Math.min(1, v)) * ((STEER_Y1 - STEER_Y0) / 2);

function plot(points: { x: number; y: number }[], c: Rgb, a: number, thick: number, dashed = false): void {
  for (let i = 1; i < points.length; i++) line(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, c, a, thick, dashed);
}

const GEAR_LABEL = (g: number) => (g > 0 ? `${g}ª` : "");

function drawStrip(live: Live): void {
  const big = S(17), small = S(13);
  const y = PAD - S(1);
  if (!ideal) {
    drawText("Bento Racing · aguardando referência", PAD, y + S(3), small, GREY, false);
    drawText("dê uma volta limpa", PAD, y + S(21), small, GREY, false);
    return;
  }
  const next = nextCorner(live.pos * ideal.trackLengthM);
  if (!next) return;
  const { corner, toBrakeM, braking } = next;

  // Line 1: corner · target gear · target speed (right-aligned), name shortened to fit.
  const targets = `${GEAR_LABEL(corner.gear)}${corner.gear > 0 ? "  " : ""}${corner.minKmh} km/h`;
  const targetsW = textWidth(targets, big);
  const gearColor = corner.gear > 0 && live.gear > corner.gear && toBrakeM < 150 ? YELLOW : WHITE;
  drawText(targets, W - PAD - targetsW, y, big, gearColor);
  drawText(fitText(corner.name, W - PAD * 3 - targetsW, big), PAD, y, big, WHITE);

  // Line 2: the fixed marker on the left, the live cue on the right.
  const y2 = y + S(21);
  const marker = corner.brakeBeforeTurnInM === null ? "sem freio" : `freia a ${roundMarker(corner.brakeBeforeTurnInM)} m da curva`;
  drawText(marker, PAD, y2, small, corner.brakeBeforeTurnInM === null ? GREEN : GREY);
  let cue = "";
  let cueColor: Rgb = GREY;
  if (braking && corner.brakeStartM !== null) {
    cue = corner.peakBrakePct !== null ? `FREIO ${corner.peakBrakePct}%${corner.trailBraking ? " · solta até o ápice" : ""}` : "FREIA";
    cueColor = RED;
  } else if (corner.brakeStartM !== null) {
    cue = `faltam ${Math.max(0, Math.round(toBrakeM / 5) * 5)} m`;
    cueColor = toBrakeM < 100 ? YELLOW : WHITE;
  }
  if (cue) {
    const cueW = textWidth(cue, small);
    drawText(cue, W - PAD - cueW, y2, small, cueColor);
  }
}

// ACC GT3/GT4 windows (same bands RaceIQ's analysis uses).
const BLUE_COLD: Rgb = [80, 160, 255];
function tyreTempColor(c: number): Rgb {
  if (c < 55) return BLUE_COLD;
  if (c < 70) return [120, 200, 255];
  if (c <= 100) return GREEN;
  if (c <= 115) return YELLOW;
  return RED;
}
function pressureColor(psi: number): Rgb {
  if (psi < 25.5) return BLUE_COLD;
  if (psi < 26) return [120, 200, 255];
  if (psi <= 28) return GREEN;
  if (psi <= 28.5) return YELLOW;
  return RED;
}
function brakeTempColor(c: number): Rgb {
  if (c < 250) return BLUE_COLD;
  if (c < 400) return [120, 200, 255];
  if (c <= 750) return GREEN;
  if (c <= 900) return YELLOW;
  return RED;
}

/** 2×2 panel: core temperature (big), hot pressure and brake disc temperature per corner. */
function drawTyres(live: Live): void {
  const gap = S(4);
  const cellW = Math.floor((TYRE_W - gap) / 2);
  const cellH = Math.floor((STEER_Y1 - PEDAL_Y0 - gap) / 2);
  for (let i = 0; i < 4; i++) {
    const x = TYRE_X0 + (i % 2) * (cellW + gap);
    const y = PEDAL_Y0 + Math.floor(i / 2) * (cellH + gap);
    const core = live.tyreCore[i], psi = live.pressure[i], brake = live.brakeTemp[i];
    const tc = tyreTempColor(core);
    fillRect(x, y, cellW, cellH, tc, 0.22);
    fillRect(x, y, S(3), cellH, tc, 0.9);
    const big = S(15), small = S(11);
    drawText(`${Math.round(core)}°`, x + S(7), y + S(2), big, WHITE);
    drawText(psi.toFixed(1), x + S(7), y + S(2) + Math.round(big * 1.25), small, pressureColor(psi));
    drawText(`F ${Math.round(brake)}°`, x + S(7), y + S(2) + Math.round(big * 1.25) + Math.round(small * 1.3), small, brakeTempColor(brake));
  }
}

/** Brake markers like the boards: 5 m steps under 50 m, 10 m above. */
function roundMarker(m: number): number {
  const step = m < 50 ? 5 : 10;
  return Math.max(step, Math.round(m / step) * step);
}

/** Shorten `text` with an ellipsis until it fits `maxW` pixels. */
function fitText(text: string, maxW: number, px: number): string {
  if (textWidth(text, px) <= maxW) return text;
  let cut = text;
  while (cut.length > 1 && textWidth(`${cut}…`, px) > maxW) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

function render(nowMs: number, live: Live | null): void {
  pixels.fill(0);
  if (!live || live.status === 0) {
    setEditable(false);
    present();
    return;
  }
  if (live.status !== 2) {
    // Menus / pause / replay: show the frame so it can be dragged into place.
    setEditable(true);
    roundedPanel(0.7, YELLOW);
    drawText("Bento Racing · arraste para posicionar", PAD + S(4), Math.round(H / 2) - S(16), S(15), WHITE);
    drawText("acelerador · freio · volante — seu (linha) x ideal (tracejado)", PAD + S(4), Math.round(H / 2) + S(6), S(12), GREY, false);
    present();
    return;
  }
  setEditable(false);
  roundedPanel(0.62, null);
  drawStrip(live);
  for (const v of [0.25, 0.5, 0.75]) fillRect(GRAPH_X0, Math.round(pedalY(v)), GRAPH_X1 - GRAPH_X0, 1, WHITE, 0.08);
  fillRect(GRAPH_X0, Math.round(steerY(0)), GRAPH_X1 - GRAPH_X0, 1, WHITE, 0.12);
  fillRect(NOW_X, PEDAL_Y0, 1, STEER_Y1 - PEDAL_Y0, WHITE, 0.35);

  const xOf = (t: number) => NOW_X - ((nowMs - t) / 1000) * PX_PER_S;
  const past = history.filter((s) => xOf(s.t) >= GRAPH_X0);
  const futureIdeal: Sample[] = [];
  if (ideal) {
    const d0 = live.pos * ideal.trackLengthM;
    const mps = Math.max(live.speedKmh, 20) / 3.6;
    for (let x = NOW_X; x <= GRAPH_X1; x += 2) {
      const dt = (x - NOW_X) / PX_PER_S;
      const v = idealAt(d0 + mps * dt);
      if (v) futureIdeal.push({ t: nowMs + dt * 1000, thr: 0, brk: 0, str: 0, iThr: v.thr, iBrk: v.brk, iStr: v.str, hasIdeal: true });
    }
  }
  const idealSeries = [...past.filter((s) => s.hasIdeal), ...futureIdeal];
  const thick = Math.max(2, S(2));
  plot(idealSeries.map((s) => ({ x: xOf(s.t), y: pedalY(s.iThr) })), GREEN, 0.45, thick + 1, true);
  plot(idealSeries.map((s) => ({ x: xOf(s.t), y: pedalY(s.iBrk) })), RED, 0.45, thick + 1, true);
  plot(idealSeries.map((s) => ({ x: xOf(s.t), y: steerY(s.iStr) })), BLUE, 0.5, thick, true);
  plot(past.map((s) => ({ x: xOf(s.t), y: pedalY(s.thr) })), GREEN, 0.95, thick);
  plot(past.map((s) => ({ x: xOf(s.t), y: pedalY(s.brk) })), RED, 0.95, thick);
  plot(past.map((s) => ({ x: xOf(s.t), y: steerY(s.str) })), WHITE, 0.95, thick);

  const barX = TYRE_X0 - S(6) - BAR_W * 2 - S(3);
  drawTyres(live);
  const now = idealAt(ideal ? live.pos * ideal.trackLengthM : 0);
  const bar = (x: number, v: number, iv: number | undefined, c: Rgb) => {
    fillRect(x, PEDAL_Y0, BAR_W, STEER_Y1 - PEDAL_Y0, WHITE, 0.1);
    const top = Math.round(PEDAL_Y0 + (1 - Math.max(0, Math.min(1, v))) * (STEER_Y1 - PEDAL_Y0));
    fillRect(x, top, BAR_W, STEER_Y1 - top, c, 0.9);
    if (iv !== undefined) fillRect(x - 2, Math.round(PEDAL_Y0 + (1 - iv) * (STEER_Y1 - PEDAL_Y0)), BAR_W + 4, 2, WHITE, 0.9);
  };
  bar(barX, live.gas, now?.thr, GREEN);
  bar(barX + BAR_W + S(3), live.brake, now?.brk, RED);
  present();
}

/** --preview: synthetic driving so the box can be checked without the game. */
const PREVIEW_IDEAL: Ideal = {
  version: "preview",
  trackLengthM: 5000,
  stepM: 2,
  throttle: Array.from({ length: 2501 }, (_, i) => (i % 500 > 380 && i % 500 < 430 ? 0 : 1)),
  brake: Array.from({ length: 2501 }, (_, i) => (i % 500 > 380 && i % 500 < 430 ? Math.max(0, 1 - ((i % 500) - 380) / 50) : 0)),
  steer: Array.from({ length: 2501 }, (_, i) => (i % 500 > 395 && i % 500 < 460 ? 0.35 : 0)),
  corners: [0, 1, 2, 3, 4].map((k) => ({
    name: k % 2 === 0 ? "Variante della Roggia" : "Curva Parabolica Alboreto",
    startM: k * 1000 + 760,
    brakeStartM: k * 1000 + 760,
    brakeBeforeTurnInM: 110,
    turnInM: k * 1000 + 870,
    gear: 2 + (k % 2),
    minKmh: 95 + k * 10,
    peakBrakePct: 85,
    trailBraking: true,
  })),
};

function previewLive(nowMs: number): Live {
  ideal ??= PREVIEW_IDEAL;
  const t = nowMs / 1000;
  const phase = (t % 6) / 6;
  const braking = phase > 0.55 && phase < 0.7;
  return {
    status: Math.floor(t / 10) % 2 === 0 ? 2 : 3,
    gas: braking ? 0 : phase < 0.55 ? 1 : Math.min(1, (phase - 0.7) * 4),
    brake: braking ? Math.max(0, 1 - (phase - 0.55) * 6) : 0,
    steer: braking || phase > 0.7 ? Math.sin((phase - 0.55) * Math.PI * 2.2) * 0.4 : 0,
    speedKmh: 180,
    gear: 4,
    pos: ((t * 50) / (ideal?.trackLengthM ?? 5000)) % 1,
    tyreCore: [84, 91, 66, 104],
    pressure: [27.6, 27.9, 25.8, 28.4],
    brakeTemp: [520, 610, 360, 420],
  };
}

// ── Loop ─────────────────────────────────────────────────────────────────
let lastTopmost = 0;
setInterval(() => {
  pumpMessages();
  const nowMs = Date.now();
  const live = PREVIEW ? previewLive(nowMs) : readLive(nowMs);
  if (live && live.status === 2) {
    const i = ideal ? idealAt(live.pos * ideal.trackLengthM) : null;
    history.push({ t: nowMs, thr: live.gas, brk: live.brake, str: live.steer, iThr: i?.thr ?? 0, iBrk: i?.brk ?? 0, iStr: i?.str ?? 0, hasIdeal: i !== null });
    while (history.length > 0 && nowMs - history[0].t > PAST_S * 1000 + 500) history.shift();
  }
  render(nowMs, live);
  // Games that grab topmost on focus would cover us: re-assert every 2 s (no activation).
  if (nowMs - lastTopmost > 2000) {
    lastTopmost = nowMs;
    U.SetWindowPos(hwnd, -1n /* HWND_TOPMOST */, 0, 0, 0, 0, 0x1 | 0x2 | 0x10 /* NOSIZE|NOMOVE|NOACTIVATE */);
  }
}, 1000 / FPS);
setInterval(() => void pollIdeal(), 3000);
void pollIdeal();

const shutdown = () => {
  U.DestroyWindow(hwnd);
  for (const m of [physics, graphics]) {
    if (!m) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    K.UnmapViewOfFile(m.view as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    K.CloseHandle(m.handle as any);
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`[Overlay] ${W}x${H} at ${posX},${posY} — targets from ${BASE_URL}. Drag it while ACC is paused / in menus. Ctrl+C or close this window to stop.`);
