import { describe, expect, test } from "bun:test";
import { dpapiProtect, dpapiUnprotect, listProcessNames, regDeleteValue, regGetBinary, regGetString, regSetBinary, regSetString } from "@raceiq/backend-core/runtime/platform/win32-native";

const onWindows = process.platform === "win32";

describe.if(onWindows)("win32 native helpers (no child processes)", () => {
  test("lists running processes in-process, including this one", () => {
    const names = listProcessNames();
    expect(names).not.toBeNull();
    expect(names!.size).toBeGreaterThan(5);
    expect(names!.has("bun")).toBe(true);
  });

  test("DPAPI round-trips secrets for the current user", () => {
    const secret = Buffer.from("sk-test-áéí-🔑", "utf8");
    const cipher = dpapiProtect(secret);
    expect(cipher.length).toBeGreaterThan(secret.length);
    expect(cipher.includes(secret)).toBe(false);
    expect(dpapiUnprotect(cipher).toString("utf8")).toBe("sk-test-áéí-🔑");
  });

  test("HKCU registry read/write/delete without PowerShell", () => {
    const key = "Software\\RaceIQ-test";
    const name = `probe-${process.pid}`;
    expect(regSetString(key, name, "\"C:\\Program Files\\x.exe\"")).toBe(true);
    expect(regGetString(key, name)).toBe("\"C:\\Program Files\\x.exe\"");
    expect(regSetBinary(key, `${name}-bin`, Buffer.from([3, 0, 0, 0]))).toBe(true);
    expect(regGetBinary(key, `${name}-bin`)?.[0]).toBe(3);
    expect(regDeleteValue(key, name)).toBe(true);
    expect(regDeleteValue(key, `${name}-bin`)).toBe(true);
    expect(regGetString(key, name)).toBeNull();
  });

  test("DPAPI rejects tampered data", () => {
    const cipher = dpapiProtect(Buffer.from("value"));
    cipher[cipher.length - 1] ^= 0xff;
    expect(() => dpapiUnprotect(cipher)).toThrow();
  });
});
