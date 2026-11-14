import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { setSecret } from "@raceiq/backend-core/runtime/platform/keystore";
import { getRaceEngineerIdeal, getRaceEngineerOverlayPlacement } from "../race-engineer/service";
import { ELEVENLABS_KEY, engineerVoiceId, forgetElevenLabsKey, isPremiumVoiceReady, lastSpeechError, synthesize } from "../race-engineer/tts";
import { overlayAvailable, overlayRunning, startOverlay, stopOverlay } from "../race-engineer/overlay-launcher";

export const raceEngineerRoutes = new Hono()
  // Ideal pedal/steering inputs + placement for the in-game input overlay (polled every few seconds).
  .get("/api/race-engineer/ideal", (c) => {
    const known = c.req.query("version") ?? null;
    const ideal = getRaceEngineerIdeal(known);
    const placement = getRaceEngineerOverlayPlacement();
    if (!ideal) return c.json({ available: false as const, placement });
    return c.json({ available: true as const, placement, ...ideal });
  })

  // Natural voice: MP3 of one callout (cached on disk after the first time).
  .get("/api/race-engineer/speech", zValidator("query", z.object({ text: z.string().min(1).max(400) })), async (c) => {
    const audio = await synthesize(c.req.valid("query").text);
    if (!audio) return c.json({ error: "voice unavailable" }, 404);
    return c.body(new Uint8Array(audio), 200, { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" });
  })
  .get("/api/race-engineer/voice", async (c) => c.json({ premium: await isPremiumVoiceReady(), voiceId: engineerVoiceId(), error: lastSpeechError() }))
  .put("/api/race-engineer/voice-key", zValidator("json", z.object({ apiKey: z.string().max(200).refine((v) => !v.includes("\0")) }).strict()), async (c) => {
    try {
      await setSecret(ELEVENLABS_KEY, c.req.valid("json").apiKey.trim());
      forgetElevenLabsKey();
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, error: "Failed to store API key" }, 500);
    }
  })

  // In-game overlay process.
  .get("/api/race-engineer/overlay", (c) => c.json({ available: overlayAvailable(), running: overlayRunning() }))
  .post("/api/race-engineer/overlay", (c) => {
    const result = startOverlay(new URL(c.req.url).origin);
    return c.json(result, result.ok ? 200 : 409);
  })
  .delete("/api/race-engineer/overlay", (c) => {
    stopOverlay();
    return c.json({ ok: true });
  });
