/**
 * In-process Win32 helpers (bun:ffi), replacing background child processes
 * that antivirus behaviour engines treat as trojan activity:
 *  - process list polling   → Toolhelp32 snapshot
 *  - secret storage         → DPAPI (CryptProtectData)
 *  - autorun registry value → RegGetValueW / RegSetKeyValueW
 *  - opening the browser    → ShellExecuteW
 *
 * Everything is loaded lazily and only on Windows.
 */
import { isMainThread } from "node:worker_threads";
import { IS_WINDOWS } from "./shell";

type FfiModule = typeof import("bun:ffi");
interface Win32 {
  ffi: FfiModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kernel32: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  crypt32: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shell32: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  advapi32: any;
}

let win32: Win32 | null | undefined;

function load(): Win32 | null {
  if (win32 !== undefined) return win32;
  // Main thread only: several workers import modules that reach these helpers,
  // and concurrent bun:ffi dlopen/JIT across threads can deadlock the process.
  if (!IS_WINDOWS || !isMainThread) return (win32 = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require("bun:ffi") as FfiModule;
    const { dlopen, FFIType } = ffi;
    const kernel32 = dlopen("kernel32.dll", {
      CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
      Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
      LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
    });
    const crypt32 = dlopen("crypt32.dll", {
      CryptProtectData: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
      CryptUnprotectData: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
    });
    const shell32 = dlopen("shell32.dll", {
      ShellExecuteW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    });
    const advapi32 = dlopen("advapi32.dll", {
      RegGetValueW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      RegSetKeyValueW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      RegDeleteKeyValueW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });
    win32 = { ffi, kernel32: kernel32.symbols, crypt32: crypt32.symbols, shell32: shell32.symbols, advapi32: advapi32.symbols };
  } catch (error) {
    console.warn("[Win32] native helpers unavailable:", error instanceof Error ? error.message : String(error));
    win32 = null;
  }
  return win32;
}

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

// PROCESSENTRY32W on x64: dwSize at 0, szExeFile (WCHAR[260]) at 44, sizeof 568.
const PE32_SIZE = 568;
const PE32_EXE_OFFSET = 44;
const TH32CS_SNAPPROCESS = 0x2;
const INVALID_HANDLE = 0xffffffffffffffffn;

/** Lower-case executable names (without .exe) of running processes, or null if unavailable. */
export function listProcessNames(): Set<string> | null {
  const w = load();
  if (!w) return null;
  const snapshot = w.kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snapshot || BigInt(snapshot) === INVALID_HANDLE) return null;
  const names = new Set<string>();
  try {
    const entry = Buffer.alloc(PE32_SIZE);
    entry.writeUInt32LE(PE32_SIZE, 0);
    const entryPtr = w.ffi.ptr(entry);
    let ok = w.kernel32.Process32FirstW(snapshot, entryPtr);
    while (ok) {
      const raw = entry.toString("utf16le", PE32_EXE_OFFSET, PE32_EXE_OFFSET + 520);
      const name = raw.slice(0, raw.indexOf("\0") >>> 0).replace(/\.exe$/i, "").toLowerCase();
      if (name) names.add(name);
      ok = w.kernel32.Process32NextW(snapshot, entryPtr);
    }
  } finally {
    w.kernel32.CloseHandle(snapshot);
  }
  return names;
}

// DATA_BLOB on x64: DWORD cbData, 4 bytes padding, BYTE* pbData.
function blobIn(w: Win32, data: Buffer): { blob: Buffer; keepAlive: Buffer } {
  const keepAlive = Buffer.from(data.length > 0 ? data : Buffer.alloc(1));
  const blob = Buffer.alloc(16);
  blob.writeUInt32LE(data.length, 0);
  blob.writeBigUInt64LE(BigInt(w.ffi.ptr(keepAlive)), 8);
  return { blob, keepAlive };
}

function blobOut(w: Win32, blob: Buffer): Buffer {
  const size = blob.readUInt32LE(0);
  const address = blob.readBigUInt64LE(8);
  if (address === 0n) return Buffer.alloc(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pointer = Number(address) as any;
  const copy = Buffer.from(new Uint8Array(w.ffi.toArrayBuffer(pointer, 0, size)));
  w.kernel32.LocalFree(pointer);
  return copy;
}

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

/** Encrypt for the current Windows user (DPAPI). Throws when unavailable. */
export function dpapiProtect(plain: Buffer): Buffer {
  const w = load();
  if (!w) throw new Error("DPAPI unavailable");
  const input = blobIn(w, plain);
  const output = Buffer.alloc(16);
  const ok = w.crypt32.CryptProtectData(w.ffi.ptr(input.blob), null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, w.ffi.ptr(output));
  if (!ok) throw new Error("CryptProtectData failed");
  void input.keepAlive;
  return blobOut(w, output);
}

/** Decrypt data produced by dpapiProtect for the same Windows user. Throws on failure. */
export function dpapiUnprotect(cipher: Buffer): Buffer {
  const w = load();
  if (!w) throw new Error("DPAPI unavailable");
  const input = blobIn(w, cipher);
  const output = Buffer.alloc(16);
  const ok = w.crypt32.CryptUnprotectData(w.ffi.ptr(input.blob), null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, w.ffi.ptr(output));
  if (!ok) throw new Error("CryptUnprotectData failed");
  void input.keepAlive;
  return blobOut(w, output);
}

export function isDpapiAvailable(): boolean {
  return load() !== null;
}

// ── HKEY_CURRENT_USER registry (replaces PowerShell Get/Set-ItemProperty) ──

const HKCU = 0x80000001n;
const RRF_RT_REG_SZ = 0x2;
const RRF_RT_REG_BINARY = 0x8;
const REG_SZ = 1;
const REG_BINARY = 3;
const ERROR_SUCCESS = 0;

function regGet(subKey: string, name: string, flags: number): Buffer | null {
  const w = load();
  if (!w) return null;
  const key = wide(subKey);
  const value = wide(name);
  const size = Buffer.alloc(4);
  if (w.advapi32.RegGetValueW(HKCU, w.ffi.ptr(key), w.ffi.ptr(value), flags, null, null, w.ffi.ptr(size)) !== ERROR_SUCCESS) return null;
  const data = Buffer.alloc(Math.max(2, size.readUInt32LE(0)));
  size.writeUInt32LE(data.length, 0);
  if (w.advapi32.RegGetValueW(HKCU, w.ffi.ptr(key), w.ffi.ptr(value), flags, null, w.ffi.ptr(data), w.ffi.ptr(size)) !== ERROR_SUCCESS) return null;
  return data.subarray(0, size.readUInt32LE(0));
}

/** Read a REG_SZ value under HKCU, or null when missing. */
export function regGetString(subKey: string, name: string): string | null {
  const data = regGet(subKey, name, RRF_RT_REG_SZ);
  if (!data) return null;
  const text = data.toString("utf16le");
  const nul = text.indexOf("\0");
  return nul >= 0 ? text.slice(0, nul) : text;
}

/** Read a REG_BINARY value under HKCU, or null when missing. */
export function regGetBinary(subKey: string, name: string): Buffer | null {
  return regGet(subKey, name, RRF_RT_REG_BINARY);
}

function regSet(subKey: string, name: string, type: number, data: Buffer): boolean {
  const w = load();
  if (!w) return false;
  const key = wide(subKey);
  const value = wide(name);
  return w.advapi32.RegSetKeyValueW(HKCU, w.ffi.ptr(key), w.ffi.ptr(value), type, w.ffi.ptr(data), data.length) === ERROR_SUCCESS;
}

export function regSetString(subKey: string, name: string, value: string): boolean {
  return regSet(subKey, name, REG_SZ, wide(value));
}

export function regSetBinary(subKey: string, name: string, value: Buffer): boolean {
  return regSet(subKey, name, REG_BINARY, value);
}

export function regDeleteValue(subKey: string, name: string): boolean {
  const w = load();
  if (!w) return false;
  return w.advapi32.RegDeleteKeyValueW(HKCU, w.ffi.ptr(wide(subKey)), w.ffi.ptr(wide(name))) === ERROR_SUCCESS;
}

/** Open a URL with the user's default handler. Returns false when unavailable. */
export function shellOpen(url: string): boolean {
  const w = load();
  if (!w) return false;
  const verb = wide("open");
  const target = wide(url);
  const result = w.shell32.ShellExecuteW(null, w.ffi.ptr(verb), w.ffi.ptr(target), null, null, 1);
  return Number(result) > 32;
}
