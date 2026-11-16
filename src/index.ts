// HDSC VC Intelligence social relay. A single-owner Cloudflare Worker that holds the founder's own
// app connections (LinkedIn, Gmail, Outlook, X, Facebook/Instagram, TikTok, Canva) and performs
// posts and one-to-one messages only when the founder presses Send in the app.
import { HttpError, type Env } from "./env";
import { safeEqual } from "./crypto";
import { PROVIDERS, authorizeUrl, configured, exchangeCode, isProvider, newVerifier } from "./providers";
import { deleteConnection, getConnection, getMedia, putState, readLog, saveConnection, takeState, type ProviderId } from "./store";
import { SIZES, createDesign, exportDesign, listDesigns, type ExportFormat } from "./actions/canva";
import { publish, type PostRequest } from "./actions/post";
import { sendMessage, type MessageRequest } from "./actions/message";
import { polish } from "./actions/polish";

const DESKTOP_ORIGIN = "app://bundle";

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = origin && (origin === DESKTOP_ORIGIN || allowed.includes(origin));
  return ok ? { "Access-Control-Allow-Origin": origin!, "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Max-Age": "600", Vary: "Origin" } : { Vary: "Origin" };
}

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });

function page(title: string, body: string, status = 200) {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:system-ui;background:#0b0f1a;color:#eef1f7;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:22px">${esc(title)}</h1><p style="color:#aab3c5">${esc(body)}</p></main>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}

function authorized(env: Env, req: Request): boolean {
  const h = req.headers.get("Authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  return !!env.RELAY_OWNER_TOKEN && env.RELAY_OWNER_TOKEN.length >= 32 && safeEqual(tok, env.RELAY_OWNER_TOKEN);
}

async function body<T>(req: Request): Promise<T> {
  try { return await req.json() as T; } catch { throw new HttpError(400, "Expected a JSON body."); }
}

export async function handle(req: Request, env: Env, f: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const cors = corsHeaders(env, req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // Public routes: OAuth callback (browser redirect from the provider) and short-lived TikTok photo pulls.
  let m = path.match(/^\/v1\/callback\/([a-z]+)$/);
  if (m && req.method === "GET") {
    const p = m[1];
    if (!isProvider(p)) return page("Unknown app", "This connection link isn't valid.", 404);
    const err = url.searchParams.get("error_description") || url.searchParams.get("error");
    const st = await takeState(env, url.searchParams.get("state") || "");
    if (!st || st.provider !== p) return page("Link expired", "Start the connection again from the app.", 400);
    if (err) return page(`${PROVIDERS[p].label} not connected`, err, 400);
    try {
      const conn = await exchangeCode(env, p, url.searchParams.get("code") || "", st.verifier, f);
      await saveConnection(env, conn);
      return page(`${PROVIDERS[p].label} connected`, `Signed in as ${conn.account.name}. You can close this window and return to HDSC VC Intelligence.`);
    } catch (e) {
      return page(`${PROVIDERS[p].label} not connected`, (e as Error).message, 502);
    }
  }
  m = path.match(/^\/v1\/media\/([A-Za-z0-9_-]+)$/);
  if (m && req.method === "GET") {
    const media = await getMedia(env, m[1]);
    return media ? new Response(media.bytes, { headers: { "Content-Type": media.type, "Cache-Control": "private, max-age=600" } }) : new Response("Not found", { status: 404 });
  }
  if (path === "" || path === "/v1/health") return json({ ok: true, service: "hdsc-vci-social-relay" }, 200, cors);

  if (!authorized(env, req)) return json({ detail: "Relay key missing or wrong. Check Connections → Relay in the app." }, 401, cors);

  try {
    if (path === "/v1/accounts" && req.method === "GET") {
      const out = [];
      for (const p of Object.keys(PROVIDERS) as ProviderId[]) {
        const c = await getConnection(env, p);
        out.push({ provider: p, label: PROVIDERS[p].label, configured: configured(env, p), connected: !!c,
          account: c?.account.name ?? null, connected_at: c?.connected_at ?? null,
          pages: c?.pages?.map(pg => ({ id: pg.id, name: pg.name, instagram: pg.instagram?.username ?? (pg.instagram ? "linked" : null) })) ?? undefined });
      }
      return json({ accounts: out, polish_available: !!env.ANTHROPIC_API_KEY, canva_sizes: SIZES }, 200, cors);
    }
    m = path.match(/^\/v1\/connect\/([a-z]+)$/);
    if (m && req.method === "POST") {
      const p = m[1];
      if (!isProvider(p)) throw new HttpError(404, "Unknown app.");
      if (!configured(env, p)) throw new HttpError(409, `${PROVIDERS[p].label} isn't set up on your relay yet. Add its client ID and secret (see the relay README).`);
      const verifier = newVerifier();
      const state = await putState(env, { provider: p, verifier, created: Date.now() });
      return json({ url: await authorizeUrl(env, p, state, verifier) }, 200, cors);
    }
    m = path.match(/^\/v1\/accounts\/([a-z]+)$/);
    if (m && req.method === "DELETE") {
      if (!isProvider(m[1])) throw new HttpError(404, "Unknown app.");
      await deleteConnection(env, m[1]);
      return json({ ok: true }, 200, cors);
    }
    if (path === "/v1/canva/designs" && req.method === "GET")
      return json(await listDesigns(env, url.searchParams.get("query") || "", url.searchParams.get("continuation") || "", f), 200, cors);
    if (path === "/v1/canva/designs" && req.method === "POST") {
      const b = await body<{ size: string; title: string }>(req);
      return json(await createDesign(env, b.size, b.title, f), 200, cors);
    }
    if (path === "/v1/canva/export" && req.method === "POST") {
      const b = await body<{ design_id: string; format: ExportFormat }>(req);
      if (!["png", "jpg", "pdf", "mp4"].includes(b.format)) throw new HttpError(400, "Format must be png, jpg, pdf or mp4.");
      return json({ urls: await exportDesign(env, b.design_id, b.format, f) }, 200, cors);
    }
    if (path === "/v1/post" && req.method === "POST") return json({ results: await publish(env, await body<PostRequest>(req), f) }, 200, cors);
    if (path === "/v1/message" && req.method === "POST") return json(await sendMessage(env, await body<MessageRequest>(req), f), 200, cors);
    if (path === "/v1/polish" && req.method === "POST") return json(await polish(env, await body(req), f), 200, cors);
    if (path === "/v1/log" && req.method === "GET") return json({ log: await readLog(env) }, 200, cors);
    return json({ detail: "Not found" }, 404, cors);
  } catch (e) {
    if (e instanceof HttpError) return json({ detail: e.message }, e.status, cors);
    return json({ detail: "The relay hit an unexpected error." }, 500, cors);
  }
}

export default { fetch: (req: Request, env: Env) => handle(req, env) };
