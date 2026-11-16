import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/index";
import type { Env, KV } from "../src/env";
import { b64, open, seal } from "../src/crypto";
import { escapeLinkedIn, publish, validatePost, xLength } from "../src/actions/post";
import { rfc822, sendMessage, validateMessage } from "../src/actions/message";
import { getConnection, saveConnection } from "../src/store";

class MemKV implements KV {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async put(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
}

const OWNER = "o".repeat(40);
let env: Env;
beforeEach(() => {
  env = {
    STORE: new MemKV(), PUBLIC_URL: "https://relay.example.workers.dev", ALLOWED_ORIGINS: "http://localhost:5173",
    RELAY_OWNER_TOKEN: OWNER, TOKEN_KEY: b64(new Uint8Array(32).fill(7)),
    LINKEDIN_CLIENT_ID: "li", LINKEDIN_CLIENT_SECRET: "lis", CANVA_CLIENT_ID: "cv", CANVA_CLIENT_SECRET: "cvs",
    GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs", X_CLIENT_ID: "x", X_CLIENT_SECRET: "xs", META_APP_ID: "m", META_APP_SECRET: "ms",
  };
});

type Call = { url: string; init?: RequestInit };
function mockFetch(routes: [RegExp, (c: Call) => Response | Promise<Response>][]) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const c = { url, init }; calls.push(c);
    for (const [re, fn] of routes) if (re.test(url)) return fn(c);
    throw new Error("unexpected fetch " + url);
  }) as typeof fetch;
  return { f, calls };
}
const ok = (j: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json", ...headers } });
const req = (path: string, init: RequestInit = {}, token = OWNER) =>
  new Request("https://relay.example.workers.dev" + path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers as any) } });

describe("security", () => {
  it("rejects calls without the owner key", async () => {
    expect((await handle(req("/v1/accounts", {}, "wrong"), env)).status).toBe(401);
    env.RELAY_OWNER_TOKEN = "short";
    expect((await handle(req("/v1/accounts", {}, "short"), env)).status).toBe(401);
  });
  it("seals tokens so a different key cannot read them", async () => {
    const s = await seal(env.TOKEN_KEY, { a: 1 });
    expect(await open(env.TOKEN_KEY, s)).toEqual({ a: 1 });
    await expect(open(b64(new Uint8Array(32).fill(9)), s)).rejects.toThrow();
  });
  it("stores connections encrypted in KV", async () => {
    await saveConnection(env, { provider: "x", access_token: "secret-token", account: { id: "1", name: "@me" }, connected_at: "" });
    expect([...(env.STORE as MemKV).m.values()].join()).not.toContain("secret-token");
  });
  it("allows only listed browser origins plus the desktop app", async () => {
    const r1 = await handle(new Request("https://r/v1/health", { headers: { Origin: "http://localhost:5173" } }), env);
    expect(r1.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    const r2 = await handle(new Request("https://r/v1/health", { headers: { Origin: "https://evil.example" } }), env);
    expect(r2.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const r3 = await handle(new Request("https://r/v1/health", { headers: { Origin: "app://bundle" } }), env);
    expect(r3.headers.get("Access-Control-Allow-Origin")).toBe("app://bundle");
  });
});

describe("connecting apps", () => {
  it("builds a Canva sign-in link with PKCE and completes the callback once", async () => {
    const r = await handle(req("/v1/connect/canva", { method: "POST" }), env);
    const { url } = await r.json() as { url: string };
    const u = new URL(url);
    expect(u.origin).toBe("https://www.canva.com");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://relay.example.workers.dev/v1/callback/canva");
    const state = u.searchParams.get("state")!;
    const { f, calls } = mockFetch([
      [/oauth\/token/, () => ok({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
      [/users\/me\/profile/, () => ok({ profile: { display_name: "Whitney" } })],
    ]);
    const cb = await handle(new Request(`https://relay.example.workers.dev/v1/callback/canva?code=C&state=${state}`), env, f);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain("Canva connected");
    expect(String((calls[0].init!.headers as any).Authorization)).toMatch(/^Basic /);
    expect(String(calls[0].init!.body)).toContain("code_verifier=");
    expect((await getConnection(env, "canva"))!.account.name).toBe("Whitney");
    const again = await handle(new Request(`https://relay.example.workers.dev/v1/callback/canva?code=C&state=${state}`), env, f);
    expect(again.status).toBe(400); // state is single use
  });
  it("explains when an app has no keys on the relay", async () => {
    const r = await handle(req("/v1/connect/tiktok", { method: "POST" }), env);
    expect(r.status).toBe(409);
  });
  it("refreshes an expired token before use", async () => {
    await saveConnection(env, { provider: "x", access_token: "old", refresh_token: "r1", expires_at: Date.now() - 1, account: { id: "1", name: "@hdsc" }, connected_at: "" });
    const { f, calls } = mockFetch([
      [/oauth2\/token/, () => ok({ access_token: "new", refresh_token: "r2", expires_in: 7200 })],
      [/2\/tweets/, c => { expect((c.init!.headers as any).Authorization).toBe("Bearer new"); return ok({ data: { id: "99" } }); }],
    ]);
    const res = await publish(env, { text: "DEMO hello", targets: ["x"] }, f);
    expect(res[0]).toMatchObject({ ok: true, ref: "99", url: "https://x.com/hdsc/status/99" });
    expect(calls[0].url).toContain("oauth2/token");
    expect((await getConnection(env, "x"))!.refresh_token).toBe("r2");
  });
});

describe("posting", () => {
  it("validates per-platform limits and media rules", () => {
    expect(validatePost({ text: "a".repeat(281), targets: ["x"] })).toMatch(/280/);
    expect(validatePost({ text: "hi " + "https://example.com/" + "a".repeat(300), targets: ["x"] })).toBeNull(); // links count as 23
    expect(xLength("see https://example.com/very/long/path/abc")).toBe(4 + 23);
    expect(validatePost({ text: "hi", targets: ["instagram"] })).toMatch(/need an image/);
    expect(validatePost({ text: "hi", targets: ["linkedin"], media: { kind: "video", url: "https://a/b.mp4" } })).toMatch(/Video/);
    expect(validatePost({ text: "ok", targets: ["linkedin", "facebook"] })).toBeNull();
  });
  it("escapes LinkedIn markup characters", () => {
    expect(escapeLinkedIn("Series A (seed) #defense @HDSC")).toBe("Series A \\(seed\\) \\#defense \\@HDSC");
  });
  it("posts text to LinkedIn with the versioned Posts API", async () => {
    await saveConnection(env, { provider: "linkedin", access_token: "LT", account: { id: "abc", name: "Whitney" }, connected_at: "" });
    const { f, calls } = mockFetch([[/rest\/posts/, () => new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:1" } })]]);
    const [r] = await publish(env, { text: "DEMO update (pre-seed)", targets: ["linkedin"] }, f);
    expect(r).toMatchObject({ ok: true, ref: "urn:li:share:1" });
    const sent = JSON.parse(String(calls[0].init!.body));
    expect(sent.author).toBe("urn:li:person:abc");
    expect(sent.commentary).toBe("DEMO update \\(pre-seed\\)");
    expect((calls[0].init!.headers as any)["LinkedIn-Version"]).toBe("202610");
  });
  it("exports a Canva design and publishes it to Instagram", async () => {
    await saveConnection(env, { provider: "canva", access_token: "CT", account: { id: "me", name: "W" }, connected_at: "" });
    await saveConnection(env, { provider: "meta", access_token: "MT", account: { id: "u", name: "W" }, connected_at: "",
      pages: [{ id: "p1", name: "HDSC", access_token: "PT", instagram: { id: "ig1", username: "hdsc" } }] });
    const { f, calls } = mockFetch([
      [/rest\/v1\/exports$/, () => ok({ job: { id: "j1", status: "in_progress" } })],
      [/rest\/v1\/exports\/j1/, () => ok({ job: { id: "j1", status: "success", urls: ["https://export.canva.example/x.jpg"] } })],
      [/export\.canva\.example/, () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } })],
      [/ig1\/media_publish/, () => ok({ id: "IGPOST" })],
      [/ig1\/media$/, c => { expect(String(c.init!.body)).toContain("image_url=https%3A%2F%2Fexport.canva.example%2Fx.jpg"); return ok({ id: "cont1" }); }],
      [/cont1\?fields=status_code/, () => ok({ status_code: "FINISHED" })],
    ]);
    const [r] = await publish(env, { text: "DEMO caption", targets: ["instagram"], media: { canva_design_id: "DAF123", kind: "image" } }, f, 0);
    expect(r).toMatchObject({ target: "instagram", ok: true, ref: "IGPOST", note: "@hdsc" });
    expect(JSON.parse(String(calls[0].init!.body)).format).toEqual({ type: "jpg", quality: 92 });
  });
  it("reports one failed target without stopping the others", async () => {
    await saveConnection(env, { provider: "meta", access_token: "MT", account: { id: "u", name: "W" }, connected_at: "", pages: [{ id: "p1", name: "HDSC", access_token: "PT" }] });
    const { f } = mockFetch([[/p1\/feed/, () => ok({ id: "p1_5" })]]);
    const res = await publish(env, { text: "DEMO", targets: ["linkedin", "facebook"] }, f);
    expect(res[0]).toMatchObject({ target: "linkedin", ok: false });
    expect(res[0].error).toMatch(/isn't connected/);
    expect(res[1]).toMatchObject({ target: "facebook", ok: true, ref: "p1_5" });
  });
});

describe("messages", () => {
  const good = { channel: "gmail" as const, to: "partner@demo-fund.example", subject: "DEMO intro", text: "Hi.\n\nIf you'd rather not hear from me, reply and I won't follow up.", recipient_source: "DEMO_list.csv" };
  it("requires a recorded source, an opt-out line, and filled placeholders", () => {
    expect(validateMessage({ ...good, recipient_source: "" })).toMatch(/recorded source/);
    expect(validateMessage({ ...good, text: "Hi there" })).toMatch(/opt-out/);
    expect(validateMessage({ ...good, text: good.text + " [traction]" })).toMatch(/bracketed/);
    expect(validateMessage({ ...good, subject: "a\nBcc: x@y.z" })).toMatch(/single line/);
    expect(validateMessage(good)).toBeNull();
  });
  it("sends one Gmail message with a UTF-8 subject", async () => {
    await saveConnection(env, { provider: "google", access_token: "GT", account: { id: "1", name: "w@hdsc.example", email: "w@hdsc.example" }, connected_at: "" });
    const { f, calls } = mockFetch([[/messages\/send/, () => ok({ id: "m1" })]]);
    const r = await sendMessage(env, good, f);
    expect(r).toMatchObject({ ok: true, ref: "m1" });
    const raw = JSON.parse(String(calls[0].init!.body)).raw as string;
    const decoded = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    expect(decoded).toContain("To: partner@demo-fund.example");
    expect(decoded).toContain("Subject: =?UTF-8?B?");
  });
  it("caps sends per day", async () => {
    env.DAILY_EMAIL_LIMIT = "1";
    await saveConnection(env, { provider: "google", access_token: "GT", account: { id: "1", name: "w", email: "w@x.example" }, connected_at: "" });
    const { f } = mockFetch([[/messages\/send/, () => ok({ id: "m1" })]]);
    await sendMessage(env, good, f);
    await expect(sendMessage(env, good, f)).rejects.toThrow(/Daily limit/);
  });
  it("looks up an X handle before sending a DM", async () => {
    await saveConnection(env, { provider: "x", access_token: "XT", account: { id: "1", name: "@hdsc" }, connected_at: "" });
    const { f, calls } = mockFetch([
      [/users\/by\/username\/demo_vc/, () => ok({ data: { id: "42" } })],
      [/dm_conversations\/with\/42\/messages/, () => ok({ data: { dm_event_id: "e1" } })],
    ]);
    expect(await sendMessage(env, { channel: "x_dm", to: "@demo_vc", text: "DEMO hi" }, f)).toMatchObject({ ok: true, ref: "e1" });
    expect(calls).toHaveLength(2);
  });
  it("builds a valid RFC 822 message", () => {
    const raw = rfc822("a@b.example", "c@d.example", "Hello — DEMO", "line1\nline2");
    expect(raw).not.toMatch(/[+/=]/);
  });
});

describe("polish", () => {
  it("is off without an API key", async () => {
    const r = await handle(req("/v1/polish", { method: "POST", body: JSON.stringify({ text: "x" }) }), env);
    expect(r.status).toBe(501);
  });
  it("warns when a rewrite drops a placeholder", async () => {
    env.ANTHROPIC_API_KEY = "k";
    const { f } = mockFetch([[/anthropic/, () => ok({ content: [{ type: "text", text: "Short version." }] })]]);
    const r = await handle(req("/v1/polish", { method: "POST", body: JSON.stringify({ text: "We grew [traction].", limit: 300 }) }), env, f);
    const j = await r.json() as any;
    expect(j.text).toBe("Short version.");
    expect(j.warnings[0]).toMatch(/\[traction\]/);
  });
});
