import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { setSecret } from "@raceiq/backend-core/runtime/platform/keystore";
import { deleteRaceEngineerLap, getRaceEngineerIdeal, getRaceEngineerOverlayPlacement, getRaceEngineerSectors } from "../race-engineer/service";
import { ELEVENLABS_KEY, currentEdgeVoice, edgeVoiceFromBrowser, engineerVoiceId, forgetElevenLabsKey, isEdgeVoiceReady, isPremiumVoiceReady, isSpeechCached, lastSpeechError, setEdgeVoice, synthesize } from "../race-engineer/tts";
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
  // `cachedOnly`: the client preloading clips — answer only what is already generated.
  .get("/api/race-engineer/speech", zValidator("query", z.object({ text: z.string().min(1).max(400), cachedOnly: z.string().optional() })), async (c) => {
    const { text, cachedOnly } = c.req.valid("query");
    if (cachedOnly && !(await isSpeechCached(text))) return c.json({ error: "not generated yet" }, 404);
    const audio = await synthesize(text);
    if (!audio) return c.json({ error: "voice unavailable" }, 404);
    return c.body(new Uint8Array(audio), 200, { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" });
  })
  // `browserVoice`/`lang`: the browser voice the driver picked, so the server speaks with the same one.
  .get("/api/race-engineer/voice", zValidator("query", z.object({ browserVoice: z.string().max(200).optional(), lang: z.string().max(20).optional() })), async (c) => {
    const { browserVoice, lang } = c.req.valid("query");
    if (browserVoice !== undefined) setEdgeVoice(edgeVoiceFromBrowser(browserVoice, lang));
    return c.json({ premium: await isPremiumVoiceReady(), edge: isEdgeVoiceReady(), edgeVoice: currentEdgeVoice(), voiceId: engineerVoiceId(), error: lastSpeechError() });
  })
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

/** Sector history (timing-screen colours) + manual delete of glitched laps. Kept apart: one chain got too deep for tsc. */
export const raceEngineerSectorRoutes = new Hono()
  .get("/api/race-engineer/sectors", (c) => {
    const limit = Math.min(300, Math.max(1, Number.parseInt(c.req.query("limit") ?? "10", 10) || 10));
    const view = getRaceEngineerSectors(limit);
    return c.body(JSON.stringify(view ? { available: true, ...view } : { available: false }), 200, { "Content-Type": "application/json" });
  })
  .delete("/api/race-engineer/sectors/:id", (c) => {
    const id = c.req.param("id");
    if (!/^[a-z0-9-]{3,40}$/.test(id)) return c.json({ ok: false }, 400);
    const ok = deleteRaceEngineerLap(id);
    return c.json({ ok }, ok ? 200 : 404);
  });
