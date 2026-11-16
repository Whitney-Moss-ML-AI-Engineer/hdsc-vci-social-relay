// Encrypted token storage, OAuth state, short-lived media, daily send counters and a send log.
import { open, randomId, seal } from "./crypto";
import type { Env } from "./env";

export type ProviderId = "linkedin" | "google" | "microsoft" | "x" | "meta" | "tiktok" | "canva";

export type MetaPage = { id: string; name: string; access_token: string; instagram?: { id: string; username?: string } | null };

export type Connection = {
  provider: ProviderId;
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  scope?: string;
  account: { id: string; name: string; email?: string };
  pages?: MetaPage[]; // meta only
  connected_at: string;
};

export type OAuthState = { provider: ProviderId; verifier: string; return_to?: string; created: number };

export async function saveConnection(env: Env, c: Connection) {
  await env.STORE.put(`conn:${c.provider}`, await seal(env.TOKEN_KEY, c));
}
export async function getConnection(env: Env, p: ProviderId): Promise<Connection | null> {
  const v = await env.STORE.get(`conn:${p}`);
  return v ? open<Connection>(env.TOKEN_KEY, v) : null;
}
export async function deleteConnection(env: Env, p: ProviderId) { await env.STORE.delete(`conn:${p}`); }

export async function putState(env: Env, s: OAuthState): Promise<string> {
  const id = randomId(); await env.STORE.put(`state:${id}`, await seal(env.TOKEN_KEY, s), { expirationTtl: 600 });
  return id;
}
export async function takeState(env: Env, id: string): Promise<OAuthState | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
  const v = await env.STORE.get(`state:${id}`);
  if (!v) return null;
  await env.STORE.delete(`state:${id}`); // single use
  const s = await open<OAuthState>(env.TOKEN_KEY, v);
  return Date.now() - s.created < 600_000 ? s : null;
}

// Media handed to TikTok's PULL_FROM_URL: stored for 1 hour under an unguessable id.
export async function putMedia(env: Env, bytes: Uint8Array, type: string): Promise<string> {
  const id = randomId(18);
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  await env.STORE.put(`media:${id}`, JSON.stringify({ type, data: btoa(s) }), { expirationTtl: 3600 });
  return id;
}
export async function getMedia(env: Env, id: string): Promise<{ type: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(id)) return null;
  const v = await env.STORE.get(`media:${id}`);
  if (!v) return null;
  const { type, data } = JSON.parse(v); const bin = atob(data); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { type, bytes };
}

const day = () => new Date().toISOString().slice(0, 10);
export async function bumpDaily(env: Env, bucket: string, limit: number): Promise<number> {
  const k = `count:${bucket}:${day()}`;
  const n = Number((await env.STORE.get(k)) || "0");
  if (n >= limit) return -1;
  await env.STORE.put(k, String(n + 1), { expirationTtl: 172800 });
  return n + 1;
}

export type LogEntry = { at: string; kind: "post" | "message"; channel: string; target: string; ok: boolean; ref?: string; error?: string };
export async function appendLog(env: Env, e: LogEntry) {
  const cur = JSON.parse((await env.STORE.get("log")) || "[]") as LogEntry[];
  cur.unshift(e);
  await env.STORE.put("log", JSON.stringify(cur.slice(0, 500)));
}
export async function readLog(env: Env): Promise<LogEntry[]> {
  return JSON.parse((await env.STORE.get("log")) || "[]");
}
