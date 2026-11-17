import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/index";
import type { Env, KV } from "../src/env";
import { b64 } from "../src/crypto";
import { GUIDES } from "../src/setup";

class MemKV implements KV {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async put(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
}
const OWNER = "o".repeat(40);
let env: Env;
beforeEach(() => { env = { STORE: new MemKV(), PUBLIC_URL: "https://relay.example.workers.dev/", RELAY_OWNER_TOKEN: OWNER, TOKEN_KEY: b64(new Uint8Array(32).fill(3)) }; });
const call = (path: string, method = "GET", body?: unknown, token = OWNER) =>
  handle(new Request("https://relay.example.workers.dev" + path, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }), env);

describe("guided setup", () => {
  it("serves a guide for every app with its redirect URL", async () => {
    const j = await (await call("/v1/setup")).json() as any;
    expect(j.guides.map((g: any) => g.id)).toEqual(GUIDES.map(g => g.id));
    const li = j.guides.find((g: any) => g.id === "linkedin");
    expect(li.redirect_uri).toBe("https://relay.example.workers.dev/v1/callback/linkedin");
    expect(li.keys_saved).toBeNull();
    expect(j.media_prefix).toBe("https://relay.example.workers.dev/v1/media/");
  });
  it("requires the owner key to read guides or save keys", async () => {
    expect((await call("/v1/setup", "GET", undefined, "nope")).status).toBe(401);
    expect((await call("/v1/credentials/x", "POST", { client_id: "abcd", client_secret: "efgh" }, "nope")).status).toBe(401);
  });
  it("saves keys sealed, never returns the secret, and makes the app connectable", async () => {
    expect((await call("/v1/connect/canva", "POST")).status).toBe(409);
    const r = await call("/v1/credentials/canva", "POST", { client_id: "OC-AbCdEf123", client_secret: "cnvca-super-secret-value" });
    expect(r.status).toBe(200);
    expect([...(env.STORE as MemKV).m.values()].join()).not.toContain("super-secret");
    const setup = await (await call("/v1/setup")).text();
    expect(setup).not.toContain("super-secret");
    expect(JSON.parse(setup).guides.find((g: any) => g.id === "canva").keys_saved).toBe("app");
    const c = await call("/v1/connect/canva", "POST");
    expect(c.status).toBe(200);
    expect(new URL(((await c.json()) as any).url).searchParams.get("client_id")).toBe("OC-AbCdEf123");
    const acc = await (await call("/v1/accounts")).json() as any;
    expect(acc.accounts.find((a: any) => a.provider === "canva").configured).toBe(true);
  });
  it("prefers Worker secrets over keys saved in the app", async () => {
    env.X_CLIENT_ID = "from-secret"; env.X_CLIENT_SECRET = "s";
    await call("/v1/credentials/x", "POST", { client_id: "from-app", client_secret: "secret-from-app" });
    const u = new URL(((await (await call("/v1/connect/x", "POST")).json()) as any).url);
    expect(u.searchParams.get("client_id")).toBe("from-secret");
    const g = (await (await call("/v1/setup")).json() as any).guides.find((x: any) => x.id === "x");
    expect(g.keys_saved).toBe("worker_secret");
  });
  it("rejects malformed keys and can remove saved keys", async () => {
    expect((await call("/v1/credentials/linkedin", "POST", { client_id: "has space", client_secret: "abcdef" })).status).toBe(400);
    expect((await call("/v1/credentials/linkedin", "POST", { client_id: "abcd" })).status).toBe(400);
    expect((await call("/v1/credentials/anthropic", "POST", { client_id: "wrong-key" })).status).toBe(400);
    expect((await call("/v1/credentials/anthropic", "POST", { client_id: "sk-ant-test123" })).status).toBe(200);
    expect(((await (await call("/v1/accounts")).json()) as any).polish_available).toBe(true);
    await call("/v1/credentials/anthropic", "DELETE");
    expect(((await (await call("/v1/accounts")).json()) as any).polish_available).toBe(false);
    expect((await call("/v1/credentials/nope", "POST", { client_id: "abcd" })).status).toBe(404);
  });
});
