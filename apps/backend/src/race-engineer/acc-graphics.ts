import { GRAPHICS, STATIC } from "@raceiq/capture-formats/acc/structs";
import type { CarPosition } from "./bot-recorder";

/** Fields the engineer needs from ACC's acpmf_graphics page, read in place. */
export interface AccGraphicsView {
  normalizedCarPosition: number;
  player: CarPosition | null;
  others: CarPosition[];
}

const MAX_CARS = 60;

/** Track spline length in metres from acpmf_static (0 when not published yet). */
export function readAccTrackLength(staticData: Buffer): number {
  const length = staticData.readFloatLE(STATIC.trackSplineLength.offset);
  return Number.isFinite(length) && length > 500 && length < 30_000 ? length : 0;
}

export function readAccGraphics(graphics: Buffer, includeCars: boolean): AccGraphicsView {
  const normalizedCarPosition = graphics.readFloatLE(GRAPHICS.normalizedCarPosition.offset);
  if (!includeCars) return { normalizedCarPosition, player: null, others: [] };

  const active = Math.min(MAX_CARS, Math.max(0, graphics.readInt32LE(GRAPHICS.activeCars.offset)));
  const playerId = graphics.readInt32LE(GRAPHICS.playerCarID.offset);
  let player: CarPosition | null = null;
  const others: CarPosition[] = [];
  for (let i = 0; i < active; i++) {
    const id = graphics.readInt32LE(GRAPHICS.carIDBase.offset + i * 4);
    const base = GRAPHICS.carCoordinatesBase.offset + i * 12;
    const car = { id, x: graphics.readFloatLE(base), z: graphics.readFloatLE(base + 8) };
    if (!Number.isFinite(car.x) || !Number.isFinite(car.z) || (car.x === 0 && car.z === 0)) continue;
    if (id === playerId) player = car;
    else others.push(car);
  }
  return { normalizedCarPosition, player, others };
}
