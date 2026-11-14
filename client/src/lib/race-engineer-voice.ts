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

/** 0..3 — above 1 is real amplification (natural voice only; browser voices cap at 1). */
export const MAX_ENGINEER_VOLUME = 3;
export function getEngineerVolume(): number {
  const v = Number.parseFloat(readStorage(VOLUME_KEY) ?? "");
  return Number.isFinite(v) ? Math.min(MAX_ENGINEER_VOLUME, Math.max(0, v)) : 2;
}
export function setEngineerVolume(value: number): void {
  writeStorage(VOLUME_KEY, String(Math.min(MAX_ENGINEER_VOLUME, Math.max(0, value))));
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

let audio: AudioContext | null = null;

/**
 * Team-radio cue: a short squelch burst and two quick high "pips", as on the
 * F1 pit-to-car radio. Synthesised with Web Audio (no files, no network).
 */
function radioCue(volume: number, closing: boolean): number {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    const ctx = audio;
    const t0 = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = 0.35 * volume;
    out.connect(ctx.destination);

    // squelch: band-passed noise, 70 ms
    const noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.07), ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 2200;
    band.Q.value = 0.9;
    src.connect(band).connect(out);
    src.start(closing ? t0 + 0.09 : t0);

    // pips
    const pips = closing ? [0] : [0.08, 0.16];
    for (const at of pips) {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = closing ? 1500 : 1900;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t0 + at);
      env.gain.linearRampToValueAtTime(0.5, t0 + at + 0.005);
      env.gain.setValueAtTime(0.5, t0 + at + 0.045);
      env.gain.linearRampToValueAtTime(0, t0 + at + 0.055);
      osc.connect(env).connect(out);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.06);
    }
    return closing ? 0 : 230; // ms to wait before speaking
  } catch {
    return 0;
  }
}

/** Natural (neural) voices sound right a bit faster; the old desktop voices need more speed to not drag. */
function speechRate(voice: SpeechSynthesisVoice | null): number {
  return voice && /natural|online|neural/i.test(voice.name) ? 1.15 : 1.3;
}

let pendingSpeak: ReturnType<typeof setTimeout> | null = null;

// ── Natural voice (ElevenLabs through the Bento Racing server, cached) ────

let premium: boolean | null = null;
let premiumCheckedAt = 0;
const decoded = new Map<string, Promise<AudioBuffer | null>>();
let currentSource: AudioBufferSourceNode | null = null;
let speakToken = 0;

/** Whether the server has a natural voice configured (re-checked every 30 s). */
async function premiumReady(): Promise<boolean> {
  if (premium !== null && Date.now() - premiumCheckedAt < 30_000) return premium;
  premiumCheckedAt = Date.now();
  try {
    const res = await fetch("/api/race-engineer/voice", { credentials: "include" });
    premium = res.ok && ((await res.json()) as { premium?: boolean }).premium === true;
  } catch {
    premium = false;
  }
  return premium;
}

/** Forget the cached status (after the key or voice changes). */
export function refreshEngineerVoice(): void {
  premium = null;
  decoded.clear();
}

function context(): AudioContext {
  audio ??= new AudioContext();
  if (audio.state === "suspended") void audio.resume();
  return audio;
}

function loadSpeech(text: string): Promise<AudioBuffer | null> {
  let job = decoded.get(text);
  if (!job) {
    job = (async () => {
      try {
        const res = await fetch(`/api/race-engineer/speech?text=${encodeURIComponent(text)}`, { credentials: "include" });
        if (!res.ok) return null;
        return await context().decodeAudioData(await res.arrayBuffer());
      } catch {
        return null;
      }
    })();
    decoded.set(text, job);
    if (decoded.size > 300) decoded.delete(decoded.keys().next().value as string);
    void job.then((buf) => {
      if (!buf) decoded.delete(text);
    });
  }
  return job;
}

/**
 * Play through gain + compressor: the compressor keeps peaks from clipping
 * so the gain can go well past 100% and cut through engine noise.
 */
function playBuffer(buffer: AudioBuffer, volume: number): void {
  const ctx = context();
  currentSource?.stop();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volume * 1.6;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24;
  comp.knee.value = 12;
  comp.ratio.value = 6;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  // a little "radio" presence: cut lows, lift the voice band
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 180;
  const presence = ctx.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 2500;
  presence.gain.value = 4;
  src.connect(highpass).connect(presence).connect(gain).connect(comp).connect(ctx.destination);
  src.onended = () => {
    if (currentSource === src) {
      currentSource = null;
      radioCue(Math.min(1, volume), true);
    }
  };
  currentSource = src;
  src.start();
}

/** Warm the decoded-audio cache for phrases likely to be said soon. */
export function preloadRaceEngineer(texts: readonly string[]): void {
  void premiumReady().then((ok) => {
    if (ok) for (const t of texts) void loadSpeech(t);
  });
}

function speakWithBrowser(text: string, volume: number): void {
  const s = synth();
  if (!s) return;
  const voice = pickVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = LANG;
  utterance.rate = speechRate(voice);
  utterance.volume = Math.min(1, volume);
  if (voice) utterance.voice = voice;
  utterance.onend = () => radioCue(Math.min(1, volume), true);
  s.cancel();
  if (pendingSpeak) clearTimeout(pendingSpeak);
  const delay = radioCue(Math.min(1, volume), false);
  pendingSpeak = setTimeout(() => {
    pendingSpeak = null;
    s.speak(utterance);
  }, delay);
}

export function speakRaceEngineer(text: string, force = false): void {
  if (!force && !getListenHere()) return;
  const volume = getEngineerVolume();
  const token = ++speakToken;
  synth()?.cancel();
  if (pendingSpeak) clearTimeout(pendingSpeak);
  void (async () => {
    if (await premiumReady()) {
      const startedAt = performance.now();
      const buffer = await loadSpeech(text);
      if (token !== speakToken) return; // a newer callout replaced this one
      if (buffer) {
        // pips first, then the voice (the pips overlap any fetch time already spent)
        const wait = Math.max(0, radioCue(Math.min(1, volume), false) - (performance.now() - startedAt));
        setTimeout(() => {
          if (token === speakToken) playBuffer(buffer, volume);
        }, wait);
        return;
      }
    }
    if (token === speakToken) speakWithBrowser(text, volume);
  })();
}
