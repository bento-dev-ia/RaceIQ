import { getTrackOutlineById } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";

/**
 * Track length in metres for converting lap fractions to distances.
 * ACC leaves `trackSplineLength` at 0, so prefer the bundled outline (same
 * source the live SectorTracker uses), then the driver's own laps.
 */
export function resolveTrackLengthM(trackId: string, gameId: string, storedLapLengths: readonly number[] = []): number {
  const outline = getTrackOutlineById(trackId, gameId);
  if (outline && outline.length > 1) {
    let length = 0;
    for (let i = 1; i < outline.length; i++) {
      length += Math.hypot(outline[i].x - outline[i - 1].x, outline[i].z - outline[i - 1].z);
    }
    if (length > 500) return length;
  }
  const valid = storedLapLengths.filter((l) => l > 500).sort((a, b) => a - b);
  return valid.length > 0 ? valid[Math.floor(valid.length / 2)] : 0;
}
