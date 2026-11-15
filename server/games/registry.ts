import { isMainThread } from "node:worker_threads";
import type { ServerGameAdapter } from "./types";
import { listProcessNames } from "../runtime/platform/win32-native";

const adapters: ServerGameAdapter[] = [];
const adapterMap = new Map<string, ServerGameAdapter>();
/** gameId → normalized process names, built at registration time */
const processNameMap = new Map<string, string[]>();

export function registerServerGame(adapter: ServerGameAdapter): void {
  const existing = adapterMap.get(adapter.id);
  if (existing) adapters[adapters.indexOf(existing)] = adapter;
  else adapters.push(adapter);
  adapterMap.set(adapter.id, adapter);
  if (adapter.processNames?.length) {
    processNameMap.set(
      adapter.id,
      adapter.processNames.map((name) => name.replace(/\.exe$/i, "").toLowerCase()),
    );
  } else {
    processNameMap.delete(adapter.id);
  }
}

export function getServerGame(gameId: string): ServerGameAdapter {
  const adapter = adapterMap.get(gameId);
  if (!adapter) throw new Error(`Unknown server game adapter: ${gameId}`);
  return adapter;
}

export function tryGetServerGame(gameId?: string): ServerGameAdapter | undefined {
  return gameId ? adapterMap.get(gameId) : undefined;
}

/** Get all server adapters in registration order (used for packet detection priority). */
export function getAllServerGames(): readonly ServerGameAdapter[] {
  return adapters;
}

/**
 * Cached set of running process names (lowercase, no extension).
 *
 * Fork note: upstream spawned a process-listing command every second, which
 * antivirus behaviour engines read as a trojan surveilling the machine. A
 * Toolhelp32 snapshot in-process gives the same names in ~1 ms with no child
 * process. Only Windows has native sim games to detect; elsewhere the set
 * stays empty (the old command never existed there either).
 */
let _processNames: Set<string> = new Set();

function refreshProcessCache(): void {
  try {
    const names = listProcessNames();
    if (names) _processNames = names;
  } catch {
    // keep stale cache on error
  }
}

// Seed immediately, then refresh every second to sync with status broadcast.
// `.unref()` so this module can be imported by `bun test` without keeping the
// test runner's event loop alive after the suite completes.
// Only the main thread detects games; workers that import this module for the
// adapter registry must not each start their own process polling.
if (isMainThread) {
  refreshProcessCache();
  const processCacheInterval = setInterval(refreshProcessCache, 1000);
  processCacheInterval.unref?.();
}

/** Check if a specific game's process is running. */
export function isGameRunning(gameId: string): boolean {
  return processNameMap.get(gameId)?.some((name) => _processNames.has(name)) ?? false;
}

/** Find which registered game is currently running. Returns null if none detected. */
export function getRunningGame(): ServerGameAdapter | null {
  if (_processNames.size === 0) return null;
  for (const adapter of adapters) {
    const names = processNameMap.get(adapter.id);
    if (names?.some((name) => _processNames.has(name))) return adapter;
  }
  return null;
}
