import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USER_DATA_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { getSecret } from "@raceiq/backend-core/runtime/platform/keystore";

/**
 * Voice for the race engineer, generated on the server and cached on disk:
 * every distinct phrase is synthesised once and replayed from disk after
 * that, so callouts play instantly. Phrases the coach can say are generated
 * ahead of time (`prewarmSpeech`) — before the car leaves the box.
 *
 * Providers, in order:
 *  - ElevenLabs, when the user stored an API key;
 *  - Microsoft Edge's neural voices (the same "Francisca Online (Natural)"
 *    the browser speaks with) through the `edge-tts` command, when installed
 *    (`pip install edge-tts`).
 * With neither, the client falls back to the browser's own speech synthesis.
 */
export const ELEVENLABS_KEY = "elevenlabs-api-key";
/** ElevenLabs premade voice that speaks Portuguese well with the multilingual Flash model. */
export const DEFAULT_VOICE_ID = "nPczCjzI2devNBz1zQrb";
const MODEL_ID = "eleven_flash_v2_5";
const CACHE_DIR = join(USER_DATA_DIR, "race-engineer", "tts");
export const DEFAULT_EDGE_VOICE = "pt-BR-FranciscaNeural";
/** Same pace the client uses for natural browser voices (rate 1.15). */
const EDGE_RATE = "+15%";

let voiceId = DEFAULT_VOICE_ID;
let edgeVoice = DEFAULT_EDGE_VOICE;
let keyCache: { value: string; at: number } | null = null;
const inflight = new Map<string, Promise<Buffer | null>>();
let lastError: string | null = null;

export function setEngineerVoiceId(id: string | null | undefined): void {
  voiceId = id && /^[A-Za-z0-9]{8,40}$/.test(id) ? id : DEFAULT_VOICE_ID;
}

export function engineerVoiceId(): string {
  return voiceId;
}

/**
 * Edge neural voice name from the browser voice the driver picked, e.g.
 * "Microsoft Francisca Online (Natural) - Portuguese (Brazil)" + "pt-BR"
 * → "pt-BR-FranciscaNeural". Null when it isn't an Edge online voice.
 */
export function edgeVoiceFromBrowser(name: string | null | undefined, lang: string | null | undefined): string | null {
  const m = /Microsoft\s+([A-Za-z]+)\s+Online/i.exec(name ?? "");
  const l = /^[a-z]{2}-[A-Z]{2}$/.test(lang ?? "") ? lang! : "pt-BR";
  return m ? `${l}-${m[1]}Neural` : null;
}

export function setEdgeVoice(name: string | null | undefined): void {
  if (name && /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(name)) edgeVoice = name;
}

export function currentEdgeVoice(): string {
  return edgeVoice;
}

async function apiKey(): Promise<string> {
  if (keyCache && Date.now() - keyCache.at < 30_000) return keyCache.value;
  let value = "";
  try {
    value = await getSecret(ELEVENLABS_KEY);
  } catch {
    value = "";
  }
  keyCache = { value, at: Date.now() };
  return value;
}

export function forgetElevenLabsKey(): void {
  keyCache = null;
  lastError = null;
}

export async function isPremiumVoiceReady(): Promise<boolean> {
  return (await apiKey()).length > 0;
}

// ── edge-tts command ─────────────────────────────────────────────────────
let edgeCommand: string[] | null | undefined;
function findEdgeCommand(): string[] | null {
  if (edgeCommand !== undefined) return edgeCommand;
  const direct = Bun.which("edge-tts");
  if (direct) return (edgeCommand = [direct]);
  for (const py of ["python", "python3", "py"]) {
    const exe = Bun.which(py);
    if (!exe) continue;
    const probe = Bun.spawnSync([exe, "-c", "import edge_tts"], { stdout: "ignore", stderr: "ignore" });
    if (probe.exitCode === 0) return (edgeCommand = [exe, "-m", "edge_tts"]);
  }
  return (edgeCommand = null);
}

export function isEdgeVoiceReady(): boolean {
  return findEdgeCommand() !== null;
}

export function lastSpeechError(): string | null {
  return lastError;
}

type Provider = { kind: "elevenlabs"; key: string } | { kind: "edge"; voice: string };

async function provider(): Promise<Provider | null> {
  const key = await apiKey();
  if (key) return { kind: "elevenlabs", key };
  if (isEdgeVoiceReady()) return { kind: "edge", voice: edgeVoice };
  return null;
}

function cacheFile(p: Provider, text: string): string {
  if (p.kind === "elevenlabs") {
    const hash = createHash("sha1").update(`${MODEL_ID}|${voiceId}|${text}`).digest("hex");
    return join(CACHE_DIR, voiceId, `${hash}.mp3`);
  }
  const hash = createHash("sha1").update(`edge|${p.voice}|${EDGE_RATE}|${text}`).digest("hex");
  return join(CACHE_DIR, "edge", p.voice, `${hash}.mp3`);
}

async function elevenLabs(key: string, text: string): Promise<Buffer | null> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      language_code: "pt",
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed: 1.1 },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    lastError = `ElevenLabs ${res.status}`;
    console.warn(`[RaceEngineer] voice synthesis failed: HTTP ${res.status}`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

async function edge(voice: string, text: string, file: string): Promise<Buffer | null> {
  const cmd = findEdgeCommand();
  if (!cmd) return null;
  const tmp = `${file}.${process.pid}.tmp.mp3`;
  // Arguments are passed as an array (no shell), so the text needs no escaping.
  const proc = Bun.spawn([...cmd, "--voice", voice, `--rate=${EDGE_RATE}`, "--text", text, "--write-media", tmp], { stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 20_000);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0 || !existsSync(tmp)) {
    lastError = `edge-tts saiu com código ${code}`;
    console.warn(`[RaceEngineer] edge-tts failed (${code}): ${(await new Response(proc.stderr).text()).slice(-200)}`);
    rmSync(tmp, { force: true });
    return null;
  }
  const audio = readFileSync(tmp);
  rmSync(tmp, { force: true });
  return audio.length > 0 ? audio : null;
}

/** MP3 for `text`, from the cache or a provider; null when none is available / on failure. */
export async function synthesize(text: string): Promise<Buffer | null> {
  const clean = text.trim().slice(0, 400);
  if (!clean) return null;
  const p = await provider();
  if (!p) return null;
  const file = cacheFile(p, clean);
  if (existsSync(file)) return readFileSync(file);
  const pending = inflight.get(file);
  if (pending) return pending;
  const job = (async () => {
    try {
      mkdirSync(join(file, ".."), { recursive: true });
      const audio = p.kind === "elevenlabs" ? await elevenLabs(p.key, clean) : await edge(p.voice, clean, file);
      if (!audio) return null;
      writeFileSync(`${file}.tmp`, audio);
      renameSync(`${file}.tmp`, file);
      lastError = null;
      return audio;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn("[RaceEngineer] voice synthesis failed:", lastError);
      return null;
    } finally {
      inflight.delete(file);
    }
  })();
  inflight.set(file, job);
  return job;
}

/** True when `text` is already on disk for the active provider (plays with no delay). */
export async function isSpeechCached(text: string): Promise<boolean> {
  const p = await provider();
  return p !== null && existsSync(cacheFile(p, text.trim().slice(0, 400)));
}

let prewarmQueue: string[] = [];
let prewarmRunning = false;
const prewarmListeners: (() => void)[] = [];

/**
 * Generate phrases in the background, skipping cached ones. Newer requests go
 * first (they are what the coach needs next); a few run in parallel.
 */
export function prewarmSpeech(texts: readonly string[], onGenerated?: () => void): void {
  void (async () => {
    const p = await provider();
    if (!p) return;
    const fresh = [...new Set(texts.map((t) => t.trim()).filter(Boolean))].filter((t) => !existsSync(cacheFile(p, t)));
    if (fresh.length === 0) return;
    if (onGenerated) prewarmListeners.push(onGenerated);
    prewarmQueue = [...fresh, ...prewarmQueue.filter((t) => !fresh.includes(t))];
    if (prewarmRunning) return;
    prewarmRunning = true;
    const started = Date.now();
    let done = 0;
    try {
      const parallel = p.kind === "edge" ? 4 : 2;
      while (prewarmQueue.length > 0) {
        const batch = prewarmQueue.splice(0, parallel);
        await Promise.all(batch.map((t) => synthesize(t)));
        done += batch.length;
      }
    } finally {
      prewarmRunning = false;
      console.log(`[RaceEngineer] voice: ${done} phrases ready in ${((Date.now() - started) / 1000).toFixed(0)} s`);
      for (const listener of prewarmListeners.splice(0)) listener();
    }
  })();
}
