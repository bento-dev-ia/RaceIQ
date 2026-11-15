import { useCallback, useEffect, useState } from "react";
import { m } from "@/paraglide/messages";
import { authenticatedFetch } from "@/lib/rpc";

type SectorColor = "purple" | "green" | "yellow" | "invalid" | "suspect";

interface SectorLapView {
  id: string;
  lapNumber: number;
  at: number;
  lapMs: number;
  sectorsMs: number[];
  colors: SectorColor[];
  lapColor: SectorColor;
  valid: boolean;
  suspect: boolean;
  thisSession: boolean;
}

interface SectorsResponse {
  available: boolean;
  laps?: SectorLapView[];
  current?: { lapNumber: number; sectorsMs: (number | null)[]; colors: (SectorColor | null)[] } | null;
}

const COLOR_CLASS: Record<SectorColor, string> = {
  purple: "bg-(--lap-pace-best) text-app-on-filled",
  green: "bg-status-success text-app-on-filled",
  yellow: "bg-status-warning text-app-on-filled",
  invalid: "bg-app-surface text-app-text-muted line-through",
  suspect: "bg-app-surface text-status-danger",
};

function formatSector(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function formatLap(ms: number): string {
  const min = Math.floor(ms / 60000);
  const rest = ms - min * 60000;
  return `${min}:${(rest / 1000).toFixed(3).padStart(6, "0")}`;
}

/** Live sector history for the current car/track with timing-screen colours and a delete button per lap. */
export function RaceEngineerSectorHistory() {
  const [data, setData] = useState<SectorsResponse | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authenticatedFetch("/api/race-engineer/sectors?limit=30");
      if (res.ok) setData((await res.json()) as SectorsResponse);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  const remove = async (id: string) => {
    setDeleting(id);
    try {
      await authenticatedFetch(`/api/race-engineer/sectors/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } finally {
      setDeleting(null);
    }
  };

  const laps = data?.available ? data.laps ?? [] : [];
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-sm font-medium text-app-text">{m.race_engineer_sectors()}</p>
        <p className="text-sm text-app-text-muted">{m.race_engineer_sectors_desc()}</p>
      </div>
      {laps.length === 0 ? (
        <p className="text-xs text-app-text-muted">{m.race_engineer_sectors_empty()}</p>
      ) : (
        <table className="w-full max-w-xl border-separate border-spacing-y-1 text-sm tabular-nums">
          <tbody>
            {laps.map((lap) => (
              <tr key={lap.id} className={lap.thisSession ? "" : "opacity-70"}>
                <td className="pr-2 text-app-text-muted">
                  {m.race_engineer_sectors_lap()} {lap.lapNumber}
                </td>
                <td className={`rounded px-2 py-0.5 text-center font-medium ${COLOR_CLASS[lap.lapColor]}`}>
                  {lap.suspect ? "⚠ " : ""}
                  {formatLap(lap.lapMs)}
                </td>
                {lap.sectorsMs.map((s, i) => (
                  <td key={i} className={`rounded px-2 py-0.5 text-center ${COLOR_CLASS[lap.colors[i] ?? "yellow"]}`}>
                    {formatSector(s)}
                  </td>
                ))}
                <td className="pl-2">
                  <button
                    type="button"
                    className="rounded px-2 text-app-text-muted hover:bg-app-surface-hover hover:text-status-danger disabled:opacity-50"
                    aria-label={`${m.race_engineer_sectors_delete()} ${lap.lapNumber}`}
                    title={m.race_engineer_sectors_delete()}
                    disabled={deleting === lap.id}
                    onClick={() => void remove(lap.id)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
