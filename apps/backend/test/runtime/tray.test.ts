import { describe, expect, test } from "bun:test";
import { shouldStartTray } from "@raceiq/backend-core/runtime/platform/tray";

describe("tray startup", () => {
  test("the fork never starts a tray (it relied on a hidden shell script)", () => {
    expect(shouldStartTray("win32", {})).toBe(false);
    expect(shouldStartTray("win32", { RACEIQ_ENABLE_TRAY: "1" })).toBe(false);
    expect(shouldStartTray("darwin", {})).toBe(false);
  });
});
