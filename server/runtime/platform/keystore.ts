/**
 * Secure credential store:
 *   macOS:   Keychain via `security` CLI
 *   Windows: DPAPI (CryptProtectData, in-process) → %APPDATA%/RaceIQ/secrets.dpapi.json
 *
 * Fork note: upstream read the Windows credential vault through a hidden
 * shell script that wrote the secret to the temp folder. Antivirus behaviour
 * engines treat that as a password stealer and quarantined RaceIQ. DPAPI
 * encrypts per Windows user with no child process and no plaintext on disk.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_COMPILED, USER_DATA_DIR } from "../config/paths";
import { IS_DARWIN, IS_WINDOWS } from "./shell";
import { createMacKeychain } from "./mac-keychain";
import { dpapiProtect, dpapiUnprotect, isDpapiAvailable } from "./win32-native";

// ── Windows (DPAPI file store) ───────────────────────────────

const SECRETS_FILE = "secrets.dpapi.json";
let windowsSecrets: Map<string, string> | null = null;
let warnedUnavailable = false;

function warnUnavailableOnce(): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(`[Keystore] Secure store unavailable (platform=${process.platform}). Secrets will not be persisted.`);
}

function secretsPath(): string {
  return join(USER_DATA_DIR, SECRETS_FILE);
}

function loadWindowsSecrets(): Map<string, string> {
  if (windowsSecrets) return windowsSecrets;
  windowsSecrets = new Map();
  const path = secretsPath();
  if (!existsSync(path)) return windowsSecrets;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    for (const [key, cipher] of Object.entries(stored)) {
      try {
        windowsSecrets.set(key, dpapiUnprotect(Buffer.from(cipher, "base64")).toString("utf8"));
      } catch {
        console.warn(`[Keystore] Could not decrypt ${key} (different Windows user?); ignoring it.`);
      }
    }
  } catch (error) {
    console.warn("[Keystore] Could not read secret store:", error instanceof Error ? error.message : String(error));
  }
  return windowsSecrets;
}

function saveWindowsSecrets(secrets: Map<string, string>): void {
  const out: Record<string, string> = {};
  for (const [key, value] of secrets) out[key] = dpapiProtect(Buffer.from(value, "utf8")).toString("base64");
  mkdirSync(USER_DATA_DIR, { recursive: true });
  const path = secretsPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2));
  renameSync(tmp, path);
}

const WIN_STORE_AVAILABLE = IS_WINDOWS && isDpapiAvailable();

// ── macOS helpers ────────────────────────────────────────────

const macKeychain = createMacKeychain();

// ── Dev fallback ─────────────────────────────────────────────

// Source checkouts on Linux/WSL have no credential store. Keep secrets in
// memory for the life of the dev server so API keys can be tested; they are
// never written to disk and compiled builds keep the warn-and-drop behavior.
const devMemoryStore = IS_COMPILED ? null : new Map<string, string>();

// ── Public API ───────────────────────────────────────────────

export async function getSecret(key: string): Promise<string> {
  if (IS_DARWIN) {
    try { return macKeychain.get(key); } catch { return ""; }
  }
  if (!WIN_STORE_AVAILABLE) {
    if (devMemoryStore) return devMemoryStore.get(key) ?? "";
    warnUnavailableOnce();
    return "";
  }
  return loadWindowsSecrets().get(key) ?? "";
}

export async function setSecret(key: string, value: string): Promise<void> {
  if (IS_DARWIN) {
    if (!value) {
      macKeychain.delete(key);
    } else {
      macKeychain.set(key, value);
    }
    return;
  }
  if (!WIN_STORE_AVAILABLE) {
    if (devMemoryStore) {
      if (value) devMemoryStore.set(key, value);
      else devMemoryStore.delete(key);
      return;
    }
    warnUnavailableOnce();
    return;
  }
  const secrets = loadWindowsSecrets();
  if (value) secrets.set(key, value);
  else secrets.delete(key);
  saveWindowsSecrets(secrets);
}
