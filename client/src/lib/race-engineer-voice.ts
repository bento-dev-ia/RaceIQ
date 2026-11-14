/**
 * Speaks race-engineer callouts with the browser's speech synthesis
 * (Windows/Edge ship natural pt-BR voices: Francisca, Antonio, Thalita…).
 * A new callout always replaces the one being spoken — stale advice is worse
 * than none.
 */

const LISTEN_KEY = "raceiq.raceEngineer.listenHere";
const VOICE_KEY = "raceiq.raceEngineer.voice";
const VOLUME_KEY = "raceiq.raceEngineer.volume";
const LANG = "pt-BR";

export interface RaceEngineerCalloutWire {
  type: "race-engineer-callout";
  kind: "pre-corner" | "post-corner" | "lap-summary" | "status";
  text: string;
  priority: number;
  cornerKey?: string;
  at: number;
}

export function isRaceEngineerCallout(data: unknown): data is RaceEngineerCalloutWire {
  return data !== null && typeof data === "object" && "type" in data && data.type === "race-engineer-callout"
    && "text" in data && typeof data.text === "string";
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: setting just won't persist */
  }
}

/** Whether this device/tab should speak (e.g. only the phone in the cockpit). */
export function getListenHere(): boolean {
  return readStorage(LISTEN_KEY) !== "false";
}
export function setListenHere(value: boolean): void {
  writeStorage(LISTEN_KEY, String(value));
}

export function getEngineerVolume(): number {
  const v = Number.parseFloat(readStorage(VOLUME_KEY) ?? "");
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}
export function setEngineerVolume(value: number): void {
  writeStorage(VOLUME_KEY, String(Math.min(1, Math.max(0, value))));
}

export function getEngineerVoiceUri(): string | null {
  return readStorage(VOICE_KEY);
}
export function setEngineerVoiceUri(uri: string | null): void {
  writeStorage(VOICE_KEY, uri ?? "");
}

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

/** pt-BR voices, best first: natural/online voices, then any pt-BR, then any pt. */
export function listPortugueseVoices(): SpeechSynthesisVoice[] {
  const voices = synth()?.getVoices() ?? [];
  const score = (v: SpeechSynthesisVoice) =>
    (v.lang === LANG ? 4 : v.lang.toLowerCase().startsWith("pt") ? 1 : 0)
    + (/natural|online|neural/i.test(v.name) ? 2 : 0);
  return voices.filter((v) => v.lang.toLowerCase().startsWith("pt")).sort((a, b) => score(b) - score(a));
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = listPortugueseVoices();
  const saved = getEngineerVoiceUri();
  return (saved && voices.find((v) => v.voiceURI === saved)) || voices[0] || null;
}

export function speakRaceEngineer(text: string, force = false): void {
  const s = synth();
  if (!s || (!force && !getListenHere())) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = LANG;
  utterance.rate = 1.1;
  utterance.volume = getEngineerVolume();
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  s.cancel();
  s.speak(utterance);
}
