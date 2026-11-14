/**
 * Per-corner prior knowledge from published GT3 track guides (ACC), used
 * before the driver has a reference of their own and to add the visual cue a
 * real engineer would give ("turn in at the 50 board"). Facts only — markers,
 * gears, lines — rephrased as short pt-BR callouts; the numbers measured live
 * from the driver's and the bots' laps always take precedence.
 *
 * Sources:
 *  - Coach Dave Academy, "Autodromo Nazionale Monza Track Guide" (2023)
 *    https://coachdaveacademy.com/tutorials/autodromo-nazionale-monza-track-guide/
 *  - Coach Dave Academy, "Circuit de Spa-Francorchamps Track Guide"
 *    https://coachdaveacademy.com/tutorials/circuit-de-spa-francorchamps-track-guide/
 */

export interface CornerGuide {
  /** Official turn numbers this entry covers. */
  turns: number[];
  /** Where to brake, as the driver sees it ("antes da placa de 150"). Empty = flat out. */
  brake: string;
  /** Gear at the apex, spoken ("segunda", "primeira ou segunda"). Empty = unchanged. */
  gear: string;
  /** Turn-in reference, when the guide gives one. */
  turnIn?: string;
  /** The one thing that matters most in this corner. */
  tip: string;
}

export interface TrackGuide {
  /** ACC track ids this applies to. */
  trackIds: string[];
  source: string;
  corners: CornerGuide[];
}

export const TRACK_GUIDES: readonly TrackGuide[] = [
  {
    trackIds: ["monza", "0", "11"],
    source: "Coach Dave Academy — Monza track guide",
    corners: [
      { turns: [1], brake: "um pouco antes da placa de 150", gear: "primeira ou segunda", turnIn: "vira quando a frente chegar na grama sintética", tip: "segura o freio até o primeiro ápice" },
      { turns: [2], brake: "", gear: "", tip: "acelera cedo e foge da zebra alta" },
      { turns: [3], brake: "", gear: "", tip: "pé embaixo, volante suave, colado na zebra de dentro" },
      { turns: [4], brake: "logo depois da placa de 150", gear: "segunda", tip: "ápice tardio, fica à esquerda pra abrir a segunda perna" },
      { turns: [5], brake: "", gear: "", tip: "pelo menos meio acelerador; se tirar o pé todo, entrou rápido demais" },
      { turns: [6], brake: "na placa de 50, no posto laranja", gear: "terceira", turnIn: "vira ao passar o posto laranja", tip: "ápice onde acaba o guard-rail de dentro" },
      { turns: [7], brake: "na placa de 50", gear: "terceira", tip: "ápice médio pra tardio, só na parte pintada da zebra" },
      { turns: [8], brake: "no quadrado laranja do guard-rail", gear: "terceira", tip: "sacrifica a entrada e pensa na saída pra reta" },
      { turns: [9], brake: "", gear: "", tip: "quase pé embaixo na direita, sem exagerar no acelerador" },
      { turns: [10], brake: "", gear: "", tip: "ápice curto, cuidado com a zebra alta de dentro" },
      { turns: [11], brake: "na placa de 100", gear: "terceira", turnIn: "vira na placa de 50", tip: "segura o freio até o ápice e acelera progressivo" },
    ],
  },
  {
    trackIds: ["spa", "6", "17"],
    source: "Coach Dave Academy — Spa-Francorchamps track guide",
    corners: [
      { turns: [1], brake: "na placa de 100", gear: "primeira ou segunda", turnIn: "vira mais tarde do que parece", tip: "ápice tardio, reduz no tempo certo pra traseira não soltar" },
      { turns: [2, 3, 4], brake: "", gear: "", tip: "colado no muro dos boxes, sem virar demais" },
      { turns: [5, 6, 7], brake: "na placa de 100", gear: "terceira ou segunda", tip: "solta o freio antes do que parece; a esquerda seguinte importa mais" },
      { turns: [8], brake: "quando começa a zebra da esquerda", gear: "primeira ou segunda", tip: "segura o freio entrando, sem abusar do ABS" },
      { turns: [10, 11], brake: "na metade da zebra de entrada, freando e virando junto", gear: "terceira ou quarta", tip: "ápice amplo na primeira perna pra chegar certo na segunda" },
      { turns: [14], brake: "no começo da zebra de entrada", gear: "segunda", tip: "a saída importa mais, ápice central e acelera cedo" },
      { turns: [15], brake: "", gear: "", tip: "entra quando a zebra da Campus acaba e segura pé embaixo" },
      { turns: [18, 19], brake: "logo depois da faixa branca", gear: "segunda", tip: "fica à direita na primeira pra abrir a segunda; tira o pé antes do que parece" },
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
