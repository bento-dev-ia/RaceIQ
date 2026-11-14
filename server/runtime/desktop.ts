import { spawn } from "node:child_process";
import { IS_DARWIN, IS_WINDOWS } from "./platform/shell";
import { shellOpen } from "./platform/win32-native";

export function preventMacSleep(): void {
  if (!IS_DARWIN) return;
  try {
    const caffeinate = spawn("caffeinate", ["-i"], { stdio: "ignore", detached: true });
    caffeinate.unref();
    process.on("exit", () => {
      try {
        caffeinate.kill();
      } catch {}
    });
    console.log("[Server] caffeinate started — macOS will not sleep while server is running");
  } catch {
    console.log("[Server] caffeinate not available — sleep prevention disabled");
  }
}

export function openFirstRunDashboard(port: number): void {
  // Installed shortcuts wait for HTTP readiness and open the dashboard themselves.
  if (process.env.RACEIQ_LAUNCHER_OPENS_BROWSER === "1") return;
  console.log("[Server] First run detected");
  openDashboard(port);
}

/** Open the local dashboard in the default browser (shortcuts pass --open-dashboard). */
export function openDashboard(port: number): void {
  const url = `http://localhost:${port}`;
  console.log(`[Server] Opening ${url}`);
  try {
    if (IS_WINDOWS) {
      // ShellExecuteW in-process instead of spawning `cmd /c start`.
      if (!shellOpen(url)) console.warn(`[Server] Could not open the browser; visit ${url}`);
    } else if (IS_DARWIN) {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {}
}
