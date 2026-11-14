import { useCallback, useEffect } from "react";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { speakRaceEngineer } from "@/lib/race-engineer-voice";

/** Ctrl+Shift+E toggles the voice engineer from anywhere in the app. */
export function isRaceEngineerHotkey(e: Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "code">): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === "KeyE";
}

/**
 * On/off state for the voice race engineer. Toggling speaks the new state so
 * the driver gets confirmation without looking at the screen.
 */
export function useRaceEngineerToggle(): { enabled: boolean; toggle: () => void } {
  const { displaySettings, settingsLoaded } = useSettings();
  const saveSettings = useSaveSettings();
  const enabled = displaySettings.raceEngineerEnabled;
  const toggle = useCallback(() => {
    if (!settingsLoaded || saveSettings.isPending) return;
    const next = !enabled;
    saveSettings.mutate({ raceEngineerEnabled: next });
    speakRaceEngineer(next ? "Engenheiro ligado." : "Engenheiro desligado.", true);
  }, [enabled, saveSettings, settingsLoaded]);
  return { enabled, toggle };
}

/** Mount once (root layout). Works while a RaceIQ window has focus. */
export function RaceEngineerHotkey() {
  const { toggle } = useRaceEngineerToggle();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isRaceEngineerHotkey(e)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
  return null;
}
