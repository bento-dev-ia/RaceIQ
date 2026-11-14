import { resolve, sep } from "node:path";
import { wsManager, type WSData } from "@raceiq/backend-core/runtime/websocket-manager";
import { MAX_IBT_BYTES } from "../imports/iracing-ibt";
import { gameAssetsDir } from "@raceiq/shared/platform/runtime/data-paths";
import { beginRequestAuthorization, endRequestAuthorization, httpAccess, type HttpAccess } from "./http-access";

type HttpApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

export function staticAssetHeaders(filePath: string): HeadersInit | undefined {
  if (!filePath.endsWith(".gz")) return undefined;
  const contentPath = filePath.slice(0, -".gz".length);
  return {
    "content-encoding": "gzip",
    "content-type": contentPath.endsWith(".json") ? "application/json" : "application/octet-stream",
  };
}

export interface HttpServerOptions {
  app: HttpApp;
  port: number;
  staticDir: string | null;
  devPublicDir: string | null;
  access?: HttpAccess;
}

/**
 * Who is listening on the HTTP port before we bind it.
 *
 * The upstream build force-killed *any* process listening on the port through
 * a hidden shell. That can terminate unrelated
 * programs and is the kind of behaviour antivirus heuristics flag, so this fork
 * only looks: a running RaceIQ answers with `X-RaceIQ: 1`; anything else is
 * another program and we refuse to start instead of killing it.
 */
export async function probeHttpPort(port: number, timeoutMs = 1500): Promise<"free" | "raceiq" | "other"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await response.body?.cancel();
    return response.headers.get("X-RaceIQ") === "1" || response.status === 401 || response.status === 423 ? "raceiq" : "other";
  } catch (error) {
    // Connection refused → free. A listener that accepts but never answers is someone else.
    const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    return /timeout|abort/i.test(message) ? "other" : "free";
  }
}

export function startHttpServer({ app, port, staticDir, devPublicDir, access = {
  ...httpAccess,
  authorize: (request) => httpAccess.authorize(request),
  allowsOrigin: (origin, request) => httpAccess.allowsOrigin(origin, request),
} }: HttpServerOptions): Bun.Server<WSData> {
  // Also disconnect already-open sockets after logout/password replacement,
  // including resets performed by another process against the shared DB.
  const sockets = new Map<Bun.ServerWebSocket<WSData>, Request>();
  const sessionCheck = setInterval(() => {
    if (!access.usesSessions) return;
    for (const [socket, request] of sockets) {
      endRequestAuthorization(request);
      void access
        .authorize(request)
        .then((denied) => {
          if (denied) socket.close(1008, "Authentication required");
        })
        .catch(() => socket.close(1008, "Authentication unavailable"));
    }
  }, 1000);
  sessionCheck.unref();
  const requests = new WeakMap<WSData, Request>();
  const server = Bun.serve<WSData>({
    port,
    hostname: access.hostname,
    idleTimeout: 255,
    // Bun otherwise terminates uploads above its 128 MiB default before Hono
    // can stream them to disk or return the route's structured size error.
    maxRequestBodySize: MAX_IBT_BYTES,
    async fetch(req, server) {
      beginRequestAuthorization(req);
      const denied = await access.authorize(req);
      if (denied) return denied;
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const data = { createdAt: Date.now(), devTelemetrySubscribed: false };
        requests.set(data, req);
        const upgraded = server.upgrade(req, { data });
        if (upgraded) return undefined as unknown as Response;
      }

      if (url.pathname.startsWith("/api") || url.pathname.startsWith("/studio-api")) {
        return app.fetch(req);
      }

      if (staticDir) {
        const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
        const filePath = resolve(staticDir, pathname.slice(1));
        if (filePath.startsWith(staticDir)) {
          const file = Bun.file(filePath);
          if (await file.exists()) {
            return new Response(file, { headers: { ...staticAssetHeaders(filePath), "X-RaceIQ": "1" } });
          }
        }
        return new Response(Bun.file(resolve(staticDir, "index.html")), { headers: { "X-RaceIQ": "1" } });
      }

      if (process.env.NODE_ENV !== "production" && url.pathname === "/") {
        const origin = req.headers.get("origin");
        return new Response("ok", {
          status: 200,
          headers: origin
            ? {
                "access-control-allow-origin": origin,
                "access-control-allow-credentials": "true",
                vary: "Origin",
              }
            : undefined,
        });
      }

      if (devPublicDir) {
        const pathname = decodeURIComponent(url.pathname);
        const filePath = resolve(devPublicDir, pathname.slice(1));
        if (filePath.startsWith(devPublicDir)) {
          const file = Bun.file(filePath);
          if (await file.exists()) {
            return new Response(file);
          }
        }
      }
      const pathname = decodeURIComponent(url.pathname);
      const gameAsset = pathname.startsWith("/car-images/f1/")
        ? { game: "f1-2025", relative: pathname.slice(1) }
        : pathname.startsWith("/car-images/acc-")
          ? { game: "acc", relative: pathname.slice(1) }
          : pathname.startsWith("/car-images/")
            ? { game: "fm-2023", relative: pathname.slice(1) }
            : pathname.startsWith("/iracing-car-images/")
              ? { game: "iracing", relative: pathname.slice(1) }
              : null;
      if (devPublicDir && gameAsset) {
        const root = resolve(gameAssetsDir(gameAsset.game), "public");
        const filePath = resolve(root, gameAsset.relative);
        if (filePath.startsWith(`${root}${sep}`)) {
          const file = Bun.file(filePath);
          if (await file.exists()) return new Response(file);
        }
      }

      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        const request = requests.get(ws.data);
        if (request) sockets.set(ws, request);
        wsManager.addClient(ws);
      },
      close(ws) {
        sockets.delete(ws);
        wsManager.removeClient(ws);
      },
      message(ws, msg) {
        wsManager.handleMessage(ws, typeof msg === "string" ? msg : Buffer.from(msg));
      },
    },
  });
  const stop = server.stop.bind(server);
  server.stop = (closeActiveConnections) => {
    clearInterval(sessionCheck);
    return stop(closeActiveConnections);
  };
  return server;
}
