import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USER_DATA_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { getSecret } from "@raceiq/backend-core/runtime/platform/keystore";

/**
 * Natural voice for the race engineer through ElevenLabs, with a disk cache:
 * every distinct phrase is synthesised once and replayed from disk after
 * that, so the per-corner callouts (which repeat every lap) cost nothing and
 * play without delay. Phrases the coach is about to need are generated ahead
 * of time (`prewarmSpeech`).
 */
export const ELEVENLABS_KEY = "elevenlabs-api-key";
/** ElevenLabs premade voice that speaks Portuguese well with the multilingual Flash model. */
export const DEFAULT_VOICE_ID = "nPczCjzI2devNBz1zQrb";
const MODEL_ID = "eleven_flash_v2_5";
const CACHE_DIR = join(USER_DATA_DIR, "race-engineer", "tts");

let voiceId = DEFAULT_VOICE_ID;
let keyCache: { value: string; at: number } | null = null;
const inflight = new Map<string, Promise<Buffer | null>>();
let lastError: string | null = null;

export function setEngineerVoiceId(id: string | null | undefined): void {
  voiceId = id && /^[A-Za-z0-9]{8,40}$/.test(id) ? id : DEFAULT_VOICE_ID;
}

export function engineerVoiceId(): string {
  return voiceId;
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

export function lastSpeechError(): string | null {
  return lastError;
}

function cacheFile(text: string): string {
  const hash = createHash("sha1").update(`${MODEL_ID}|${voiceId}|${text}`).digest("hex");
  return join(CACHE_DIR, voiceId, `${hash}.mp3`);
}

/** MP3 for `text`, from the cache or ElevenLabs; null when no key / on failure. */
export async function synthesize(text: string): Promise<Buffer | null> {
  const clean = text.trim().slice(0, 400);
  if (!clean) return null;
  const file = cacheFile(clean);
  if (existsSync(file)) return readFileSync(file);
  const pending = inflight.get(file);
  if (pending) return pending;
  const job = (async () => {
    const key = await apiKey();
    if (!key) return null;
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: clean,
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
      const audio = Buffer.from(await res.arrayBuffer());
      mkdirSync(join(CACHE_DIR, voiceId), { recursive: true });
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

/** Generate upcoming phrases in the background, two at a time, skipping cached ones. */
export function prewarmSpeech(texts: readonly string[]): void {
  void (async () => {
    if (!(await isPremiumVoiceReady())) return;
    const todo = [...new Set(texts.map((t) => t.trim()).filter(Boolean))].filter((t) => !existsSync(cacheFile(t)));
    for (let i = 0; i < todo.length; i += 2) await Promise.all(todo.slice(i, i + 2).map((t) => synthesize(t)));
  })();
}
