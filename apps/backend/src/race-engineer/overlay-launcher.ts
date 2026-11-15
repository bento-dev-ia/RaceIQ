import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Starts the in-game input overlay (scripts/race-engineer/overlay.ts) as a
 * child of this same signed bun.exe — no other executable involved. Only
 * available when running from source (dev / `bun run dev`); the compiled
 * build doesn't ship the script.
 */
const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "race-engineer", "overlay.ts");

let child: ReturnType<typeof Bun.spawn> | null = null;

export function overlayAvailable(): boolean {
  return existsSync(SCRIPT) && /bun(\.exe)?$/i.test(process.execPath);
}

export function overlayRunning(): boolean {
  return child !== null && child.exitCode === null && !child.killed;
}

export function startOverlay(baseUrl: string): { ok: true; alreadyRunning: boolean } | { ok: false; reason: string } {
  if (overlayRunning()) return { ok: true, alreadyRunning: true };
  if (!overlayAvailable()) return { ok: false, reason: "unavailable" };
  child = Bun.spawn([process.execPath, SCRIPT, `--url=${baseUrl}`], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  void child.exited.then((code) => {
    console.log(`[Overlay] exited (${code})`);
  });
  console.log(`[Overlay] started (pid ${child.pid})`);
  return { ok: true, alreadyRunning: false };
}

export function stopOverlay(): void {
  if (overlayRunning()) child?.kill();
  child = null;
}

process.on("exit", stopOverlay);
