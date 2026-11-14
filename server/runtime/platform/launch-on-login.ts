import { dirname, join } from "node:path";
import { IS_COMPILED } from "../config/paths";
import { IS_WINDOWS } from "./shell";
import { regDeleteValue, regGetBinary, regGetString, regSetString } from "./win32-native";

/**
 * Start-with-Windows toggle (Settings → General). Off unless the user turns it on.
 *
 * Fork note: upstream read and wrote these keys through hidden PowerShell on
 * every settings load. A background process polling its own autorun entry via
 * PowerShell is a persistence-trojan pattern for antivirus behaviour engines,
 * so this uses the registry API in-process, and disabling removes the entry
 * instead of leaving a dormant one.
 */
const RUN_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const VALUE_NAME = "RaceIQ";

// The native desktop shell owns its own startup entry, independently of the backend.
export function isDesktopStartupOwned(): boolean {
  return process.env.RACEIQ_DESKTOP === "1";
}

export function isLaunchOnLoginSupported(): boolean {
  return !isDesktopStartupOwned() && IS_WINDOWS && IS_COMPILED;
}

export function isLaunchOnLoginEnabled(): boolean {
  if (!isLaunchOnLoginSupported()) return false;
  try {
    if (!regGetString(RUN_KEY, VALUE_NAME)) return false;
    // Task Manager marks a disabled entry with first byte 0x03 in StartupApproved.
    const approved = regGetBinary(APPROVED_KEY, VALUE_NAME);
    return !approved || approved[0] !== 0x03;
  } catch {
    return false;
  }
}

export function enableLaunchOnLogin(exeDir: string): void {
  if (!isLaunchOnLoginSupported()) return;
  regSetString(RUN_KEY, VALUE_NAME, `"${join(exeDir, "raceiq.exe")}"`);
  // Clear a previous "disabled" mark so Windows treats the entry as enabled.
  regDeleteValue(APPROVED_KEY, VALUE_NAME);
}

export function disableLaunchOnLogin(): void {
  if (!isLaunchOnLoginSupported()) return;
  regDeleteValue(RUN_KEY, VALUE_NAME);
  regDeleteValue(APPROVED_KEY, VALUE_NAME);
}

export function getLaunchOnLoginExeDir(): string {
  return dirname(process.execPath);
}
