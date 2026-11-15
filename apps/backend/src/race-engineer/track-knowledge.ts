/**
 * Per-corner targets from published GT3 track guides (ACC). These are the
 * engineer's truth for gear, apex speed and the brake marker; the driver's own
 * laps are only used to spot where they deviate from it.
 *
 * Turn numbers are the official ones (FIA / circuit map), which is what the
 * track segments use. Track Titan numbers Monza differently after Lesmo 2
 * (its T8 is the flat-out Serraglio kink, T9/T10 = Ascari, T11 = Parabolica).
 *
 * Sources (see docs/research/*-track-guides.md for the full extraction):
 *  - Track Titan, "ACC Monza Audi R8 LMS Evo II 2022 (Dry) Track Guide" — on-screen
 *    apex speed / lowest gear per turn and the braking trace, read frame by frame.
 *    https://youtu.be/qwkawq-rdFU
 *  - TraxionGG, "How to be fast at Monza on ACC" https://youtu.be/O7R-abglkZ0
 *  - Yorkie065, "Monza In-Depth Track Guide" https://youtu.be/jC6sz9DIwBk
 *  - Tone Racing, "Monza Beginner Lap Guide" https://youtu.be/eczYVLlzC_c
 *  - Spa: Track Titan Audi R8 LMS Evo II https://youtu.be/7vcZbx0bmEg, TraxionGG (Audi R8)
 *    https://youtu.be/8mv7HYAcSms, Yorkie065 https://youtu.be/V6xhn7XqxHA, SimRacingSetups
 *    https://youtu.be/8eNe6VacNbQ, ThatSimRacerDZ https://youtu.be/f6cnKQI0V34
 */

export interface CornerGuide {
  /** Official turn numbers this entry covers. */
  turns: number[];
  /** Where to brake, as the driver sees it ("na placa de 150"). Empty = no braking. */
  brake: string;
  /** Gear at the apex (1 = first). 0 = unchanged / not given. */
  gear: number;
  /** Apex (minimum) speed in km/h, when the guide gives it. */
  apexKmh?: number;
  /** True for corners taken flat out. */
  flat?: boolean;
  /** Turn-in reference, when the guide gives one. */
  turnIn?: string;
  /** The one thing that matters most in this corner (line, brake release, steering). */
  tip: string;
}

export interface TrackGuide {
  /** ACC track ids this applies to. */
  trackIds: string[];
  /** Car the numbers were taken with. */
  car: string;
  source: string;
  corners: CornerGuide[];
}

export const TRACK_GUIDES: readonly TrackGuide[] = [
  {
    trackIds: ["monza", "0", "11"],
    car: "Audi R8 LMS Evo II",
    source: "Track Titan (Audi R8 LMS Evo II) + TraxionGG, Yorkie065, Tone Racing",
    corners: [
      { turns: [1], brake: "pouco antes da placa de 150", gear: 1, apexKmh: 66, turnIn: "vira quando a frente chegar na grama sintética", tip: "freia reto na linha branca e segura o freio até o primeiro ápice" },
      { turns: [2], brake: "", gear: 1, apexKmh: 61, tip: "só um toque no freio, acelera cedo e foge da zebra alta" },
      { turns: [3], brake: "", gear: 0, flat: true, tip: "volante suave, colado na zebra de dentro" },
      { turns: [4], brake: "na placa de 150", gear: 2, apexKmh: 83, tip: "ápice tardio, fica à esquerda pra abrir a segunda perna" },
      { turns: [5], brake: "", gear: 2, apexKmh: 91, tip: "pelo menos meio acelerador; se tirar o pé todo, entrou rápido demais" },
      { turns: [6], brake: "com um toque leve antes da marca laranja à direita", gear: 3, apexKmh: 132, tip: "ápice onde acaba o guard-rail de dentro" },
      { turns: [7], brake: "pouco antes da placa de 50", gear: 3, apexKmh: 119, tip: "ápice médio pra tardio, só na parte pintada da zebra" },
      { turns: [8], brake: "logo depois da marca laranja, antes da placa de 100", gear: 3, apexKmh: 149, tip: "sacrifica a entrada e pensa na saída pra reta" },
      { turns: [9], brake: "", gear: 3, tip: "quase pé embaixo na direita, sem exagerar no acelerador" },
      { turns: [10], brake: "", gear: 3, apexKmh: 168, tip: "ápice curto, cuidado com a zebra alta de dentro" },
      { turns: [11], brake: "na placa de 100", gear: 3, apexKmh: 127, turnIn: "vira na placa de 50", tip: "segura o freio até o ápice e acelera progressivo" },
    ],
  },
  {
    trackIds: ["spa", "6", "17"],
    car: "Audi R8 LMS Evo II",
    source: "Track Titan (Audi R8 LMS Evo II) + TraxionGG (Audi R8), Yorkie065, SimRacingSetups, ThatSimRacerDZ",
    corners: [
      { turns: [1], brake: "logo depois da placa de 100", gear: 1, apexKmh: 60, turnIn: "vira mais tarde do que parece", tip: "ápice tardio, reduz no tempo certo pra traseira não soltar" },
      { turns: [2, 3, 4], brake: "", gear: 0, flat: true, tip: "colado no muro dos boxes, sem virar demais" },
      { turns: [5], brake: "na placa de 100, no início da zebra", gear: 3, tip: "solta o freio antes do que parece; a esquerda seguinte importa mais" },
      { turns: [6], brake: "", gear: 3, apexKmh: 110, tip: "pega a zebra de dentro e já abre pra direita" },
      { turns: [7], brake: "", gear: 3, apexKmh: 147, tip: "só alivia o acelerador, sem frear" },
      { turns: [8], brake: "no começo da zebra", gear: 2, apexKmh: 102, tip: "freia virando, solta devagar até o ápice, sem abusar do ABS" },
      { turns: [9], brake: "com um toque leve", gear: 3, apexKmh: 131, tip: "toque curto e acelera cedo na descida" },
      { turns: [10], brake: "com um toque curto na cerca laranja da direita", gear: 4, apexKmh: 167, tip: "ápice amplo na primeira perna pra chegar certo na segunda" },
      { turns: [11], brake: "", gear: 4, apexKmh: 205, tip: "sem freio, abre o volante e acelera" },
      { turns: [12], brake: "embaixo da placa da Total", gear: 3, apexKmh: 130, tip: "freia reto e vira quando soltar o freio" },
      { turns: [13], brake: "", gear: 3, apexKmh: 127, tip: "só alivia e deixa o carro sair largo" },
      { turns: [14], brake: "com o carro reto, logo antes da zebra da esquerda", gear: 3, apexKmh: 123, tip: "a saída importa mais, ápice central e acelera cedo" },
      { turns: [15], brake: "", gear: 0, apexKmh: 180, tip: "sem freio, volante suave" },
      { turns: [16, 17], brake: "", gear: 0, flat: true, tip: "entra quando a zebra acaba e segura pé embaixo" },
      { turns: [18], brake: "entre a placa de 150 e a de 100, logo depois da linha branca", gear: 1, apexKmh: 63, tip: "fica à direita na primeira pra abrir a segunda" },
      { turns: [19], brake: "", gear: 1, apexKmh: 65, tip: "acelera cedo, sem pisar na zebra alta" },
    ],
  },
];

export function guideForTrack(trackId: string): TrackGuide | null {
  const id = trackId.toLowerCase();
  return TRACK_GUIDES.find((g) => g.trackIds.includes(id)) ?? null;
}

export function guideForTurns(guide: TrackGuide | null, turns: readonly number[]): CornerGuide | undefined {
  if (!guide || turns.length === 0) return undefined;
  return guide.corners.find((c) => c.turns.some((t) => turns.includes(t)));
}
