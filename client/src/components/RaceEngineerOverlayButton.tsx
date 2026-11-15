import { useCallback, useEffect, useState } from "react";
import { authenticatedFetch } from "@/lib/rpc";
import { m } from "@/paraglide/messages";

interface OverlayStatus { available: boolean; running: boolean }

/** Polls whether the in-game overlay process is running and can start it again. */
export function useRaceEngineerOverlay() {
  const [status, setStatus] = useState<OverlayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const res = await authenticatedFetch("/api/race-engineer/overlay");
      if (res.ok) setStatus((await res.json()) as OverlayStatus);
    } catch {
      /* server unreachable: keep the last status */
    }
  }, []);
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [refresh]);
  const open = useCallback(async () => {
    setBusy(true);
    try {
      await authenticatedFetch("/api/race-engineer/overlay", { method: "POST" });
    } finally {
      setBusy(false);
      void refresh();
    }
  }, [refresh]);
  return { status, busy, open };
}

/** Compact button: "Open overlay" / "Overlay open". */
export function RaceEngineerOverlayButton({ className }: { className?: string }) {
  const { status, busy, open } = useRaceEngineerOverlay();
  if (!status?.available) return null;
  return (
    <button
      type="button"
      disabled={busy || status.running}
      onClick={() => void open()}
      className={className ?? "rounded-md border border-app-border px-3 py-1.5 text-sm text-app-text hover:bg-app-surface-hover disabled:opacity-60"}
    >
      {status.running ? m.race_engineer_overlay_running() : m.race_engineer_overlay_open()}
    </button>
  );
}
