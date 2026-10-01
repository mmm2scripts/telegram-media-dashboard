/**
 * Cloudflare Worker — serves the dashboard (static assets from ./public) and acts as the API
 * gateway between the browser and the private bot server.
 *
 *   GET  /api/health      -> checks the Worker and the bot server
 *   POST /api/send-media  -> streams the multipart upload to the bot server
 *
 * Secrets (set with `npx wrangler secret put <NAME>`):
 *   BOT_SERVER_URL     e.g. https://bot.example.com
 *   INTERNAL_API_KEY   shared secret, sent as the X-Internal-Key header
 *
 * Plain variables (wrangler.toml [vars]):
 *   ALLOWED_ORIGIN         "*" or comma-separated list of allowed origins
 *   MAX_BODY_MB            maximum request size (default 95)
 *   RATE_LIMIT_PER_MINUTE  per-IP limit, best effort per isolate (default 60)
 */

const MB = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const hits = new Map(); // ip -> { start, count }

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000",
};

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const list = allowedOrigins(env);
  const h = { Vary: "Origin", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };
  if (list.includes("*")) h["Access-Control-Allow-Origin"] = "*";
  else if (origin && list.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(request, env, body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...corsHeaders(request, env), ...extra },
  });
}

function rateLimited(ip, max) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > 60_000) {
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > 60_000) hits.delete(k);
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > max;
}

function botBase(env) {
  if (!env.BOT_SERVER_URL || !env.INTERNAL_API_KEY) return null;
  try {
    const u = new URL(env.BOT_SERVER_URL);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch { return null; }
}

async function health(request, env) {
  const base = botBase(env);
  if (!base) return json(request, env, { ok: false, worker: true, botServer: false, error: "Worker secrets BOT_SERVER_URL / INTERNAL_API_KEY are missing or invalid." }, 503);
  try {
    const r = await fetch(`${base}/health`, { headers: { "X-Internal-Key": env.INTERNAL_API_KEY }, signal: AbortSignal.timeout(8000) });
    return json(request, env, { ok: r.ok, worker: true, botServer: r.ok }, r.ok ? 200 : 503);
  } catch {
    return json(request, env, { ok: false, worker: true, botServer: false, error: "Bot server is unreachable." }, 503);
  }
}

async function sendMedia(request, env) {
  const base = botBase(env);
  if (!base) return json(request, env, { ok: false, error: "Worker is not configured (missing secrets)." }, 500);

  const type = request.headers.get("Content-Type") || "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(type)) return json(request, env, { ok: false, error: "Content-Type must be multipart/form-data." }, 415);

  const maxBytes = (Number(env.MAX_BODY_MB) || 95) * MB;
  const len = request.headers.get("Content-Length");
  if (!len || !/^\d+$/.test(len)) return json(request, env, { ok: false, error: "Content-Length header is required." }, 411);
  if (Number(len) > maxBytes) return json(request, env, { ok: false, error: `Request too large. Maximum is ${Math.round(maxBytes / MB)} MB per request; use a smaller pack size.` }, 413);

  const packSize = Number(new URL(request.url).searchParams.get("packSize") ?? 10);
  if (!Number.isInteger(packSize) || packSize < 5 || packSize > 10) return json(request, env, { ok: false, error: "packSize must be an integer from 5 to 10." }, 400);

  let upstream;
  try {
    upstream = await fetch(`${base}/api/send-media?packSize=${packSize}`, {
      method: "POST",
      headers: { "Content-Type": type, "X-Internal-Key": env.INTERNAL_API_KEY },
      body: request.body,
      duplex: "half",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err && err.name === "TimeoutError";
    return json(request, env, { ok: false, error: timeout ? "Bot server timed out." : "Could not reach the bot server." }, timeout ? 504 : 502);
  }

  let data;
  try { data = JSON.parse(await upstream.text()); } catch { data = null; }
  if (!data || typeof data !== "object") return json(request, env, { ok: false, error: "Bot server returned an invalid response." }, 502);
  if (upstream.status === 401 || upstream.status === 403) return json(request, env, { ok: false, error: "Bot server rejected the Worker. Check that INTERNAL_API_KEY matches on both sides." }, 502);
  return json(request, env, data, upstream.status, upstream.headers.get("Retry-After") ? { "Retry-After": upstream.headers.get("Retry-After") } : {});
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const origin = request.headers.get("Origin");
      const list = allowedOrigins(env);

      if (request.method === "OPTIONS") {
        const ok = list.includes("*") || (origin && list.includes(origin));
        return new Response(null, { status: ok ? 204 : 403, headers: { ...SECURITY_HEADERS, ...corsHeaders(request, env) } });
      }
      if (origin && origin !== url.origin && !list.includes("*") && !list.includes(origin)) return json(request, env, { ok: false, error: "Origin not allowed." }, 403);

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const max = Number(env.RATE_LIMIT_PER_MINUTE) || 60;
      if (rateLimited(ip, max)) return json(request, env, { ok: false, error: "Too many requests. Try again in a minute." }, 429, { "Retry-After": "60" });

      if (url.pathname === "/api/health") {
        return request.method === "GET" ? health(request, env) : json(request, env, { ok: false, error: "Method not allowed." }, 405, { Allow: "GET" });
      }
      if (url.pathname === "/api/send-media") {
        return request.method === "POST" ? sendMedia(request, env) : json(request, env, { ok: false, error: "Method not allowed." }, 405, { Allow: "POST" });
      }
      return json(request, env, { ok: false, error: "Not found." }, 404);
    } catch {
      return json(request, env, { ok: false, error: "Internal error." }, 500);
    }
  },
};
