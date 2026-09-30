import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLink, listLinks, sendJson, stats } from "./api/links.js";
import { DEFAULT_RATE_LIMIT, RateLimiter, rateLimitFromEnv } from "./ratelimit.js";
import { redirect } from "./redirect.js";
import { Store } from "./store.js";

const DEFAULT_PORT = 3000;
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");

function sendPage(res: ServerResponse, file: string) {
  const html = readFileSync(join(WEB_DIR, file), "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;

interface Route {
  method: "GET" | "POST";
  path: string;
  handler: Handler;
}

export interface AppOptions {
  /** `POST /links` allowed per client IP per minute. Default 10. */
  rateLimit?: number;
}

/** Wrap a handler so each client IP gets at most `limiter`'s quota; over it, `429` with `Retry-After`. */
function rateLimited(limiter: RateLimiter, handler: Handler): Handler {
  return (req, res, url) => {
    const { allowed, retryAfterSeconds } = limiter.hit(req.socket.remoteAddress ?? "unknown");
    if (allowed) return handler(req, res, url);
    return sendJson(
      res,
      429,
      { error: "too many links created; try again later" },
      { "retry-after": String(retryAfterSeconds) },
    );
  };
}

/** The fixed routes. Every GET route also answers HEAD; another method on one of these paths is a 405. */
function routes(store: Store, limiter: RateLimiter): Route[] {
  return [
    { method: "GET", path: "/", handler: (_req, res) => sendPage(res, "index.html") },
    { method: "GET", path: "/links", handler: (_req, res) => sendPage(res, "links.html") },
    {
      method: "POST",
      path: "/links",
      handler: rateLimited(limiter, (req, res) => createLink(req, res, store)),
    },
    { method: "GET", path: "/api/links", handler: (req, res) => listLinks(req, res, store) },
    { method: "GET", path: "/api/stats", handler: (req, res, url) => stats(req, res, store, url) },
  ];
}

/** Build the http server around a store. Tests call this with a throwaway store. */
export function createApp(store: Store, options: AppOptions = {}): Server {
  const table = routes(store, new RateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT));
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;
    // HEAD is GET without the body, and node:http already drops the body for HEAD responses.
    const routeMethod = method === "HEAD" ? "GET" : method;

    try {
      const known = table.filter((r) => r.path === path);
      if (known.length > 0) {
        const match = known.find((r) => r.method === routeMethod);
        if (match) return await match.handler(req, res, url);
        const allow = known.flatMap((r) => (r.method === "GET" ? ["GET", "HEAD"] : [r.method]));
        return sendJson(res, 405, { error: "method not allowed" }, { allow: allow.join(", ") });
      }

      if (path.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });

      const slug = path.slice(1);
      if (routeMethod === "GET" && slug !== "" && !slug.includes("/")) {
        return redirect(req, res, store, slug);
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (err: any) {
      console.error(err);
      return sendJson(res, 500, { error: "internal error" });
    }
  });
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  const store = Store.open();
  createApp(store, { rateLimit: rateLimitFromEnv() }).listen(port, () => {
    console.log(`linkr listening on http://localhost:${port}  (${store.list().length} links)`);
  });
}
