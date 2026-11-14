import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { arch, platform, release, type as osType, cpus, networkInterfaces, totalmem, freemem, uptime as osUptime } from "node:os";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { zipSync, strToU8 } from "fflate";

import { lapDetector } from "@raceiq/backend-core/telemetry/live-pipeline";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import { IS_COMPILED, ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { udpListener } from "../../runtime/udp-listener";
import { getRunningGame } from "@raceiq/backend-core/games/registry";
import { getCurrentDetectedGame } from "@raceiq/backend-core/games/packet-dispatch";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
import { client as dbClient, DB_PATH } from "@raceiq/backend-core/db/index";
import { collectDiagnosticChatContext } from "@raceiq/backend-core/ai/chat-agent";
import { formatDiagnosticRecord, log, readRecentLogText } from "@raceiq/backend-core/runtime/logger";
import { normalizeDiagnostic } from "@raceiq/backend-core/ai/diagnostic-logging";
import { APP_VERSION } from "@raceiq/shared/platform/runtime/app-version";

const DB_DIR = dirname(DB_PATH);

const ClientLogSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("error"),
  scope: z.string().max(64),
  message: z.string().max(4000),
  occurredAtMs: z.number().int().min(0).max(8_640_000_000_000_000),
  detail: z.unknown().optional(),
});

function latestAiError(logs: string): string | null {
  let latest: string | null = null;
  for (const line of logs.split("\n")) {
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    try {
      const record = JSON.parse(line.slice(separator + 1)) as Record<string, unknown>;
      if (record.event !== "llm-error") continue;
      const error = record.error;
      if (typeof error === "string") latest = error;
      else if (error && typeof error === "object" && "message" in error) {
        latest = String(error.message);
      }
    } catch {
      // Ignore non-structured retained log lines.
    }
  }
  return latest;
}

export const diagnosticsRoutes = new Hono()
  /**
   * POST /api/client-log — sink for browser-side errors.
   *
   * The file logger only captures the server console, so anything thrown in the
   * React AI panels stays in devtools and never reaches the diagnostics export.
   * The client posts here so user-reported chat failures are in `logs.txt`.
   */
  .post("/api/client-log", zValidator("json", ClientLogSchema), async (c) => {
    const { level, scope, message, detail, occurredAtMs } = c.req.valid("json");
    if (scope === "console" && message.startsWith("[vite]")) return c.json({ ok: true });
    const record = { clientOccurredAt: new Date(occurredAtMs).toISOString(), clientScope: scope, clientDetail: detail };
    const line = `[Client/${scope}] ${message}`;
    log[level](record, line);
    return c.json({ ok: true });
  })
  .get("/api/diagnostics", async (c) => {
    let logs = "";

    const session = lapDetector.session;
    // Detect game from actual UDP packets being parsed, then fall back to process list
    let runningGame = getCurrentDetectedGame();
    if (!runningGame) {
      runningGame = getRunningGame();
    }
    const settings = loadSettings();

    // Browser details from query parameters
    const browserName = c.req.query("browserName") || "Unknown";
    const browserVersion = c.req.query("browserVersion") || "Unknown";
    const browserEngine = c.req.query("browserEngine") || "Unknown";
    const browserUA = c.req.query("browserUA") || "";

    // Browser memory usage (if available)
    let browserMemoryMB: number | null = null;
    const browserMemoryStr = c.req.query("browserMemory");
    if (browserMemoryStr) {
      const parsed = parseFloat(browserMemoryStr);
      if (!Number.isNaN(parsed)) browserMemoryMB = parsed;
    }

    // Server process memory usage
    const memUsage = process.memoryUsage();
    const serverMemoryMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const chatSnapshot = await collectDiagnosticChatContext();
    const chatThreads = chatSnapshot.threads.map(({ thread, messages }) => {
      const id = thread && typeof thread === "object" && "id" in thread ? String(thread.id) : "unknown";
      const updatedAt = thread && typeof thread === "object" && "updatedAt" in thread ? String(thread.updatedAt ?? "") : "";
      return { threadId: id, messages: messages.length, updatedAt };
    });
    const chatMessageCount = chatSnapshot.messageCount;
    const chatCollectionError = chatSnapshot.error;
    if (chatCollectionError) log.error({ event: "ai-chat-export-error", error: chatCollectionError }, "ai-chat-export-error");
    const chatLines = ["=== RaceIQ AI conversation context ==="];
    const exportTime = new Date().toISOString();
    for (const snapshot of chatSnapshot.threads) {
      chatLines.push(formatDiagnosticRecord({
        ...normalizeDiagnostic({
          event: "ai-chat-thread",
          thread: snapshot.thread,
          systemPrompt: snapshot.systemPrompt,
          systemPromptUnavailable: snapshot.systemPromptUnavailable,
          messageCount: snapshot.messages.length,
        }) as Record<string, unknown>,
        level: "info",
        time: exportTime,
        service: "raceiq/export",
        msg: "AI chat thread",
      }).trimEnd());
      for (const message of snapshot.messages) {
        chatLines.push(formatDiagnosticRecord({
          ...normalizeDiagnostic({ event: "ai-chat-message", message }) as Record<string, unknown>,
          level: "info",
          time: exportTime,
          service: "raceiq/export",
          msg: "AI chat message",
        }).trimEnd());
      }
    }
    const recentLogs = readRecentLogText();
    const chatError = latestAiError(recentLogs) ?? chatCollectionError;
    logs = `${recentLogs}${recentLogs.endsWith("\n") ? "" : "\n"}${chatLines.join("\n")}\n`;
    // Database size and stats
    let dbSizeMB: number | null = null;
    let sessionCount: number | null = null;
    let lapCount: number | null = null;
    try {
      if (existsSync(DB_PATH)) {
        const stats = statSync(DB_PATH);
        dbSizeMB = Math.round(stats.size / 1024 / 1024 * 100) / 100;
      }
      // Query session and lap counts
      const sessionResult = await dbClient.execute("SELECT COUNT(*) as count FROM sessions");
      sessionCount = Number(sessionResult.rows[0]?.count) || 0;
      const lapResult = await dbClient.execute("SELECT COUNT(*) as count FROM laps");
      lapCount = Number(lapResult.rows[0]?.count) || 0;
    } catch {}

    // Hardware & network diagnostics (no child processes; see fork note below)
    const cpuUsagePercent: number | null = null;
    const gpuName: string | null = null;
    const gpuUsagePercent: number | null = null;
    let networkType: string | null = null;
    const linkSpeedMbps: number | null = null;

    // Detect network type from OS network interfaces as fallback
    const nets = networkInterfaces();
    for (const [name, addrs] of Object.entries(nets)) {
      const active = addrs?.find((a) => !a.internal && a.family === "IPv4");
      if (active) {
        const lower = name.toLowerCase();
        networkType = lower.includes("wi-fi") || lower.includes("wifi") || lower.includes("wlan")
          ? "WiFi" : "Ethernet";
        break;
      }
    }

    // Fork note: upstream probed CPU/GPU load, network adapter, power plan and
    // disk media type with ~8 hidden PowerShell processes in a row. That burst
    // of system reconnaissance is what info-stealer heuristics look for, so
    // these optional fields stay null on Windows.
    const powerMode: string | null = null;
    const installDriveType: string | null = null;
    const dataDriveType: string | null = null;


    const diagnostics = {
      app: {
        version: APP_VERSION,
        compiled: IS_COMPILED,
        installDir: ROOT_DIR,
        installDriveType,
        dataDir: DB_DIR,
        dataDriveType,
        bunVersion: typeof Bun !== "undefined" ? Bun.version : null,
      },
      browser: {
        name: browserName,
        version: browserVersion,
        engine: browserEngine,
        userAgent: browserUA,
        memoryUsedMB: browserMemoryMB,
      },
      system: {
        os: osType(),
        platform: platform(),
        arch: arch(),
        osRelease: release(),
        powerMode,
        cpu: cpus()[0]?.model ?? null,
        cpuCores: cpus().length,
        cpuUsagePercent,
        gpu: gpuName,
        gpuUsagePercent,
        network: networkType,
        linkSpeedMbps,
        totalMemoryMB: Math.round(totalmem() / 1024 / 1024),
        freeMemoryMB: Math.round(freemem() / 1024 / 1024),
        uptimeSec: Math.round(osUptime()),
      },
      server: {
        udpPort: udpListener.port,
        udpReceiving: udpListener.receiving,
        packetsPerSec: udpListener.packetsPerSec,
        droppedPackets: udpListener.droppedPackets,
        connectedClients: wsManager.connectedClients,
        memoryHeapUsedMB: serverMemoryMB,
        database: {
          sizeMB: dbSizeMB,
          sessionCount,
          lapCount,
        },
        detectedGame: runningGame
          ? { id: runningGame.id, name: runningGame.shortName }
          : null,
        currentSession: session
          ? {
              id: session.sessionId,
              carId: session.carId,
              trackId: session.trackId,
            }
          : null,
      },
      settings: {
        udpPort: settings.udpPort,
        unit: settings.unit,
        wsRefreshRate: settings.wsRefreshRate,
        aiAnalysis: {
          provider: settings.aiProvider,
          model: settings.aiModel,
        },
        aiChat: {
          provider: settings.chatProvider,
          model: settings.chatModel,
        },
      },
      chat: {
        messageCount: chatMessageCount,
        error: chatError,
        collectionError: chatCollectionError,
        threads: chatThreads,
      },
      generatedAt: new Date().toISOString(),
    };

    const zip = zipSync({
      "diagnostics.json": strToU8(JSON.stringify(diagnostics, null, 2)),
      "logs.txt": strToU8(logs),
    });

    return new Response(Buffer.from(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="raceiq-diagnostics.zip"`,
      },
    });
  });
