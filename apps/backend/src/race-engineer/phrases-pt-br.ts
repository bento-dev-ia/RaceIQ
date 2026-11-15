import type { CornerGuide } from "./track-knowledge";
import type { CornerIssue, CornerReference, IssueKind } from "./types";

/** Short spoken phrases in Brazilian Portuguese. Kept terse on purpose: the driver is busy. */

const GEAR_WORDS = ["", "primeira", "segunda", "terceira", "quarta", "quinta", "sexta", "sétima", "oitava"];

export function gearWord(gear: number): string {
  return GEAR_WORDS[gear] ?? `${gear}ª`;
}

/** Brake markers are spoken rounded: 5 m steps under 50 m, 10 m steps above. */
export function roundBrakeMetres(m: number): number {
  const step = m < 50 ? 5 : 10;
  return Math.max(step, Math.round(m / step) * step);
}

function brakeMarker(ref: CornerReference): string | null {
  const m = ref.brakeBeforeTurnInM;
  if (m === null || m < 5) return null;
  return `freia nos ${roundBrakeMetres(m)} metros`;
}

const TIP: Record<IssueKind, (i: CornerIssue) => string> = {
  "brake-early": (i) => (i.brakeShiftM ? `${roundBrakeMetres(Math.abs(i.brakeShiftM))} metros mais tarde` : "dá pra passar sem frear"),
  "brake-late": (i) => (i.brakeShiftM ? `${roundBrakeMetres(Math.abs(i.brakeShiftM))} metros antes` : "freia um pouco antes"),
  "brake-harder": (i) => (i.refPeakBrakePct ? `pisa mais forte, uns ${i.refPeakBrakePct} por cento` : "pisa mais forte no freio"),
  "brake-softer": (i) => (i.refPeakBrakePct ? `menos freio, uns ${i.refPeakBrakePct} por cento` : "alivia o freio"),
  "trail-brake": () => "solta o freio devagar até o ápice",
  "min-speed-low": (i) => (i.refMinKmh ? `leva mais velocidade, mínima de ${i.refMinKmh}` : "leva mais velocidade no meio"),
  gear: (i) => (i.refGear ? `usa a ${gearWord(i.refGear)}` : "confere a marcha"),
  "throttle-late": () => "acelera mais cedo na saída",
  "turn-in-early": (i) => (i.turnInShiftM ? `espera, vira uns ${roundBrakeMetres(Math.abs(i.turnInShiftM))} metros mais tarde` : "espera mais pra virar"),
  "turn-in-late": (i) => (i.turnInShiftM ? `vira uns ${roundBrakeMetres(Math.abs(i.turnInShiftM))} metros antes` : "vira um pouco antes"),
  "steer-too-much": () => "menos volante, deixa o carro rolar",
  "steer-too-little": () => "mais volante, aponta pro ápice",
};

const CAUSE: Record<IssueKind, string> = {
  "brake-early": "freou cedo",
  "brake-late": "freou tarde",
  "brake-harder": "pouco freio",
  "brake-softer": "freio demais",
  "trail-brake": "soltou o freio cedo",
  "min-speed-low": "mínima baixa",
  gear: "marcha diferente",
  "throttle-late": "acelerou tarde",
  "turn-in-early": "virou cedo",
  "turn-in-late": "virou tarde",
  "steer-too-much": "volante demais",
  "steer-too-little": "pouco volante",
};

/**
 * "La Source, segunda, freia nos 100 metros. Solta o freio devagar até o ápice."
 * Gear and brake marker are the anchor; the tip is the one thing to change.
 * With a track guide, its gear, apex speed and board are the anchor instead,
 * and a brake point that is off is corrected against the board, not in metres.
 */
export function preCornerPhrase(spokenName: string, ref: CornerReference, issue: CornerIssue | undefined, guide?: CornerGuide): string {
  if (guide) return guidedPreCornerPhrase(spokenName, guide, issue);
  const parts: string[] = [spokenName];
  if (ref.gear > 0 && issue?.kind !== "gear") parts.push(gearWord(ref.gear));
  const marker = brakeMarker(ref);
  if (marker) parts.push(marker);
  let text = parts.join(", ");
  if (issue) text += `. ${capitalize(TIP[issue.kind](issue))}`;
  return `${text}.`;
}

function guidedPreCornerPhrase(spokenName: string, guide: CornerGuide, issue: CornerIssue | undefined): string {
  const parts: string[] = [spokenName];
  if (guide.gear > 0) parts.push(gearWord(guide.gear));
  if (guide.apexKmh) parts.push(String(guide.apexKmh));
  if (guide.brake) parts.push(`freia ${guide.brake}`);
  let tip: string | null = null;
  if (issue) {
    switch (issue.kind) {
      case "brake-early":
        tip = guide.brake ? "espera a referência pra frear" : TIP[issue.kind](issue);
        break;
      case "brake-late":
        tip = guide.brake ? "freia mais cedo, na referência" : TIP[issue.kind](issue);
        break;
      case "gear":
        tip = guide.gear > 0 ? `usa a ${gearWord(guide.gear)}` : null;
        break;
      case "min-speed-low":
        tip = guide.apexKmh ? `leva mais velocidade, ${guide.apexKmh} no ápice` : TIP[issue.kind](issue);
        break;
      case "turn-in-early":
      case "turn-in-late":
        tip = guide.turnIn ?? TIP[issue.kind](issue);
        break;
      default:
        tip = TIP[issue.kind](issue);
    }
  }
  let text = `${parts.join(", ")}.`;
  if (tip) text += ` ${capitalize(tip)}.`;
  return text;
}

/** Every pre-corner phrase a guided corner can produce (to synthesise ahead of time). */
export function guidedPreCornerVariants(spokenName: string, guide: CornerGuide): string[] {
  const kinds: IssueKind[] = ["brake-early", "brake-late", "brake-harder", "brake-softer", "trail-brake", "min-speed-low", "gear", "throttle-late", "turn-in-early", "turn-in-late", "steer-too-much", "steer-too-little"];
  return kinds.map((kind) => guidedPreCornerPhrase(spokenName, guide, { kind }));
}

/**
 * Plain briefing for a corner with nothing to fix yet:
 * "Lesmo 1, segunda, 120, freia nos 50 metros."
 */
export function briefingPhrase(spokenName: string, ref: CornerReference): string {
  const parts: string[] = [spokenName];
  if (ref.gear > 0) parts.push(gearWord(ref.gear));
  if (ref.minKmh > 0) parts.push(String(Math.round(ref.minKmh / 5) * 5));
  const marker = brakeMarker(ref);
  if (marker) parts.push(marker);
  return `${parts.join(", ")}.`;
}

/** From the track guide: "Curva 4, segunda, 83, freia na placa de 150." */
export function guidePhrase(spokenName: string, guide: CornerGuide, withTip: boolean): string {
  const parts = [spokenName];
  if (guide.flat) parts.push("pé embaixo");
  else {
    if (guide.gear > 0) parts.push(gearWord(guide.gear));
    if (guide.apexKmh) parts.push(String(guide.apexKmh));
    if (guide.brake) parts.push(`freia ${guide.brake}`);
  }
  let text = `${parts.join(", ")}.`;
  if (withTip && guide.tip) text += ` ${capitalize(guide.tip)}.`;
  return text;
}

export function postCornerPhrase(deltaS: number, issue: CornerIssue | undefined, second?: CornerIssue): string {
  const amount = formatDelta(Math.abs(deltaS));
  if (deltaS < 0) return `Boa, ganhou ${amount}.`;
  if (!issue) return `Perdeu ${amount}.`;
  return second ? `Perdeu ${amount}, ${CAUSE[issue.kind]} e ${CAUSE[second.kind]}.` : `Perdeu ${amount}, ${CAUSE[issue.kind]}.`;
}

export function lapSummaryPhrase(lapTimeS: number, bestS: number | null, focusName: string | null): string {
  let text = formatLapTime(lapTimeS);
  if (bestS !== null && bestS > 0) {
    const delta = lapTimeS - bestS;
    if (Math.abs(delta) < 0.05) text += ", igual ao melhor";
    else if (delta < 0) text += `, melhor volta, ${formatDelta(-delta)} mais rápido`;
    else text += `, ${formatDelta(delta)} do melhor`;
  }
  if (focusName) text += `. Foco na ${focusName}`;
  return `${text}.`;
}

export const NO_REFERENCE_PHRASE = "Engenheiro ligado. Ainda sem referência nessa pista, dá uma volta limpa.";
export const REFERENCE_READY_PHRASE = "Referência pronta. Vou te passar as curvas que mais custam.";
export const ENGINEER_ON_PHRASE = "Engenheiro ligado.";

/** "2 décimos", "1 décimo", "1,3 segundo". */
export function formatDelta(seconds: number): string {
  if (seconds < 0.95) {
    const tenths = Math.max(1, Math.round(seconds * 10));
    return tenths === 1 ? "1 décimo" : `${tenths} décimos`;
  }
  const s = (Math.round(seconds * 10) / 10).toFixed(1).replace(".", ",").replace(",0", "");
  return s === "1" ? "1 segundo" : `${s} segundos`;
}

/** 108.34 → "1 minuto, 48 e 3"; 58.2 → "58 e 2". */
export function formatLapTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const min = Math.floor(total / 60);
  const sec = Math.floor(total - min * 60);
  const tenth = Math.floor((total - min * 60 - sec) * 10);
  const tail = `${sec} e ${tenth}`;
  if (min === 0) return tail;
  return `${min} ${min === 1 ? "minuto" : "minutos"}, ${tail}`;
}

/**
 * Only corners famous by name keep it on the radio (short form); everything
 * else is just its number, which is quicker to say and to place.
 */
const FAMOUS: readonly [RegExp, string][] = [
  [/lesmo\s*1/i, "Lesmo 1"],
  [/lesmo\s*2/i, "Lesmo 2"],
  [/ascari/i, "Ascari"],
  [/parab[oó]lica/i, "Parabólica"],
  [/la source/i, "La Source"],
  [/eau rouge/i, "Eau Rouge"],
  [/raidillon/i, "Raidillon"],
  [/pouhon/i, "Pouhon"],
  [/blanchimont/i, "Blanchimont"],
  [/bus stop/i, "Bus Stop"],
];

/** Spoken corner name from segment data: a famous name when it has one, else "Curva N". */
export function spokenCornerName(name: string | undefined, numbers: readonly number[], fallbackIndex: number): string {
  const trimmed = (name ?? "").trim();
  for (const [pattern, short] of FAMOUS) if (pattern.test(trimmed)) return short;
  const isToken = /^T\??$/.test(trimmed) || /^T\d+(?:[-,/]\d+)*$/.test(trimmed) || trimmed === "";
  if (!isToken && numbers.length === 0) return trimmed;
  if (numbers.length > 1) return `Curva ${numbers[0]} e ${numbers[numbers.length - 1]}`;
  if (numbers.length === 1) return `Curva ${numbers[0]}`;
  const fromToken = /^T(\d+)/.exec(trimmed);
  return `Curva ${fromToken ? fromToken[1] : fallbackIndex}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
